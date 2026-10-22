import type { FigmaAPI } from '@open-pencil/core/figma-api'
import {
  ALL_TOOLS,
  registerComponentCatalog,
  isAtomicTool,
  isToolExposed,
  toolChangesDocument
} from '@open-pencil/core/tools'
import type { JSONObject } from '@open-pencil/scene-graph/primitives'

import { agentReplyRun, aiUndoLabel, recordRunUndoEntry, type Run } from '@/app/ai/tools/run'
import {
  agentFinished,
  agentStarted,
  readAgentSession,
  touchedNodeIds,
  type AgentSession
} from '@/app/automation/agents'
import { limitToSelection } from '@/app/automation/bridge/selection-scope'
import type { AutomationTarget } from '@/app/automation/bridge/target'
import {
  AUTOMATION_UNDO_LABEL,
  automationUndoLabel,
  executeAtomicEditorTool,
  executeWithDocumentUndo
} from '@/app/automation/execution/editor'
import { ensureGraphFonts } from '@/app/editor/fonts'
import { useLibraryService } from '@/app/libraries'

type FigmaFactory = (store: AutomationTarget['store'], pageId?: string) => FigmaAPI

export function createAutomationToolHandler(makeFigma: FigmaFactory) {
  return async function handleTool(target: AutomationTarget, args: unknown): Promise<unknown> {
    const toolName = (args as { name?: string }).name
    const requestedArgs = (args as { args?: Record<string, unknown> }).args ?? {}
    if (!toolName) throw new Error('Missing "name" in args')
    // An MCP server that shares only the selection marks its calls, and they stay inside it.
    const toolArgs =
      (args as { scope?: unknown }).scope === 'selection'
        ? limitToSelection(target.store, toolName, requestedArgs)
        : requestedArgs

    // A call from an MCP session shows as that session's agent, working where the call works.
    const session = readAgentSession((args as { agent?: unknown }).agent)
    const reply = session ? agentStarted(target.store, session, target.pageId) : 0
    const response = await runInReply(target, toolName, session, () =>
      runTool(target, toolName, toolArgs, replyRunOf(target, session) ? aiUndoLabel : null)
    )
    if (session) {
      agentFinished(target.store, session, {
        reply,
        pageId: target.pageId,
        nodeIds: touchedNodeIds(target.store, toolArgs, response.result),
        edited: response.edited
      })
    }
    return { ok: true, result: response.result }
  }

  /**
   * An ACP chat's call during its reply joins the reply's run, as the built-in chat's calls do,
   * so the reply can revert it and the transcript marks it under the agent's own call id.
   */
  async function runInReply<T>(
    target: AutomationTarget,
    toolName: string,
    session: AgentSession | null,
    run: () => Promise<T>
  ): Promise<T> {
    const reply = replyRunOf(target, session)
    const call = session?.call
    if (!reply || !call) return run()
    const store = target.store
    const undoBefore = store.undo.peekUndo()
    reply.beginTool()
    try {
      return await run()
    } finally {
      recordRunUndoEntry(store, reply, { tool: toolName, toolCallId: call }, undoBefore)
      if (store.undo.peekUndo() !== undoBefore) reply.changedCalls.add(call)
      reply.endTool()
    }
  }

  function replyRunOf(target: AutomationTarget, session: AgentSession | null): Run | null {
    return session?.kind === 'acp' && session.call
      ? agentReplyRun(target.store, session.chat)
      : null
  }

  async function runTool(
    target: AutomationTarget,
    toolName: string,
    toolArgs: Record<string, unknown>,
    /** The chat's labels, for a call that belongs to a chat reply. */
    chatLabel: ((tool: string) => string) | null
  ): Promise<{ result: unknown; edited: boolean }> {
    const def = ALL_TOOLS.find((t) => t.name === toolName && isToolExposed(t, 'mcp'))
    if (!def) throw new Error(`Unknown tool: ${toolName}`)
    const store = target.store
    const libraryService = useLibraryService()
    libraryService.bindEditor(store)
    registerComponentCatalog(store.graph, libraryService)
    const figma = makeFigma(store, target.pageId)
    let result: unknown
    if (isAtomicTool(def)) {
      result = await executeAtomicEditorTool(store, figma, def, toolArgs, {
        label: chatLabel?.(def.name) ?? AUTOMATION_UNDO_LABEL
      })
    } else if (def.mutates) {
      const pageId = writtenPageId(store.graph, toolArgs) ?? figma.currentPageId
      const mutate = () =>
        store.runMutationWithLayout(
          () => def.execute(figma, toolArgs),
          pageId,
          async () => {
            const pageNode = store.graph.getNode(pageId)
            if (pageNode) await ensureGraphFonts(store.graph, pageNode.childIds, store.renderer)
          }
        )
      // View tools (selection, viewport, pages) leave the document and its history alone.
      result = toolChangesDocument(def)
        ? await executeWithDocumentUndo(
            store,
            pageId,
            chatLabel?.(def.name) ?? automationUndoLabel(def.name),
            mutate
          )
        : await mutate()
    } else {
      result = await def.execute(figma, toolArgs)
    }

    if (def.mutates) {
      store.requestRender()
      store.flashNodes(extractNodeIds(result))
    }
    return { result, edited: def.mutates }
  }
}

/**
 * A parent or a replaced layer on another page puts the new layers there, so that page lays out,
 * loads their fonts, and records the change in its history.
 */
function writtenPageId(
  graph: AutomationTarget['store']['graph'],
  args: Record<string, unknown>
): string | null {
  // As render places it: a replaced layer's parent wins over parent_id.
  const nodeId = args.replace_id ?? args.parent_id
  return typeof nodeId === 'string' ? pageIdOf(graph, nodeId) : null
}

function pageIdOf(graph: AutomationTarget['store']['graph'], nodeId: string): string | null {
  let node = graph.getNode(nodeId)
  while (node && node.type !== 'CANVAS')
    node = node.parentId ? graph.getNode(node.parentId) : undefined
  return node?.id ?? null
}

function extractNodeIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') return []
  const obj = result as JSONObject
  if (typeof obj.deleted === 'string') return []
  const ids: string[] = []
  if (typeof obj.id === 'string') ids.push(obj.id)
  if (Array.isArray(obj.results)) {
    for (const item of obj.results) {
      if (item && typeof item === 'object' && typeof (item as JSONObject).id === 'string')
        ids.push((item as JSONObject).id as string)
    }
  }
  return ids
}
