import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { InitializeResponse } from '@agentclientprotocol/sdk'

import type { ACPAgentDef } from '@open-pencil/core/constants'

import { spawnACPProcess } from '@/app/ai/acp/process'
import { createDeferred, type Deferred } from '@/app/runtime/deferred'

import {
  parseAuthMethods,
  parseAuthStatusUpdate,
  type AgentAuthMethod,
  type AgentAuthStatus
} from './status'

/** An agent process's stdio and the way to stop it. */
export interface AgentStreams {
  input: WritableStream<Uint8Array>
  output: ReadableStream<Uint8Array>
  close(): Promise<void>
}

export type SpawnAgent = (agent: ACPAgentDef) => Promise<AgentStreams>

export interface AuthSessionOptions {
  spawn?: SpawnAgent
  /** How long to wait for a login report; adapters read their CLI's with a 5 s limit. */
  statusTimeoutMs?: number
}

const STATUS_TIMEOUT_MS = 8_000

/** What an agent says about its login when it starts, without a session or a prompt. */
export interface AgentAuthCheck {
  /** Null when the agent reported nothing in time, so its login is unknown. */
  status: AgentAuthStatus | null
  methods: AgentAuthMethod[]
  /** The ACP program that answered, to tell a supported adapter from another with its name. */
  adapter: { name: string; version: string } | null
}

export async function spawnAgentStreams(agent: ACPAgentDef): Promise<AgentStreams> {
  let closing = false
  const { child, input, output } = await spawnACPProcess({
    command: agent.command,
    args: agent.args,
    logId: `${agent.id} sign-in`,
    destroying: () => closing,
    onUnexpectedClose: () => undefined
  })
  return {
    input,
    output,
    async close() {
      closing = true
      await child.kill().catch(() => undefined)
    }
  }
}

/** Login reports in arrival order, so a caller can wait for one newer than it has seen. */
function createStatusLog() {
  const reports: AgentAuthStatus[] = []
  let waiting: { after: number; deferred: Deferred<AgentAuthStatus | null> } | null = null
  return {
    get count() {
      return reports.length
    },
    push(status: AgentAuthStatus) {
      reports.push(status)
      if (waiting && reports.length > waiting.after) waiting.deferred.resolve(status)
    },
    /** The first report after `after` reports, or the latest one if none comes in time. */
    async next(after: number, timeoutMs: number): Promise<AgentAuthStatus | null> {
      if (reports.length > after) return reports.at(-1) ?? null
      const deferred = createDeferred<AgentAuthStatus | null>()
      waiting = { after, deferred }
      const timer = setTimeout(() => deferred.resolve(reports.at(-1) ?? null), timeoutMs)
      try {
        return await deferred.promise
      } finally {
        clearTimeout(timer)
        waiting = null
      }
    }
  }
}

async function openAuthSession(agent: ACPAgentDef, spawn: SpawnAgent = spawnAgentStreams) {
  const streams = await spawn(agent)
  const log = createStatusLog()
  const connection = new ClientSideConnection(
    () => ({
      // Nothing runs in this connection, so nothing may ask for permission.
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => undefined,
      extNotification: async (method, params) => {
        const status = parseAuthStatusUpdate(method, params)
        if (status) log.push(status)
      }
    }),
    ndJsonStream(streams.input, streams.output)
  )
  // The SDK leaves requests pending when the agent exits, so each one races the connection.
  const stopped = connection.closed.then(() => {
    throw new Error('The agent stopped.')
  })
  stopped.catch(() => undefined)
  function untilStopped<T>(request: Promise<T>): Promise<T> {
    return Promise.race([request, stopped])
  }
  let init: InitializeResponse
  try {
    init = await untilStopped(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        // Without it, Claude's adapter offers no sign-in methods.
        clientCapabilities: { _meta: { 'terminal-auth': true } }
      })
    )
  } catch (error) {
    await streams.close()
    throw error
  }
  return { connection, init, log, untilStopped, close: () => streams.close() }
}

function adapterOf(init: InitializeResponse): AgentAuthCheck['adapter'] {
  return init.agentInfo ? { name: init.agentInfo.name, version: init.agentInfo.version } : null
}

/** Starts the agent, reads the login it reports, and stops it. */
export async function checkAgentAuth(
  agent: ACPAgentDef,
  { spawn, statusTimeoutMs = STATUS_TIMEOUT_MS }: AuthSessionOptions = {}
): Promise<AgentAuthCheck> {
  const session = await openAuthSession(agent, spawn)
  try {
    return {
      status: await session.log.next(0, statusTimeoutMs),
      methods: parseAuthMethods(session.init.authMethods),
      adapter: adapterOf(session.init)
    }
  } finally {
    await session.close()
  }
}

/**
 * Signs in through an auth method the agent runs itself, such as Codex's ChatGPT login, which
 * opens the browser and waits for it. Aborting stops the agent and rejects.
 */
export async function signInWithAgent(
  agent: ACPAgentDef,
  methodId: string,
  signal: AbortSignal,
  { spawn, statusTimeoutMs = STATUS_TIMEOUT_MS }: AuthSessionOptions = {}
): Promise<AgentAuthStatus | null> {
  const session = await openAuthSession(agent, spawn)
  const stop = () => void session.close()
  signal.addEventListener('abort', stop, { once: true })
  try {
    signal.throwIfAborted()
    const seen = session.log.count
    await session.untilStopped(session.connection.authenticate({ methodId }))
    return await session.log.next(seen, statusTimeoutMs)
  } finally {
    signal.removeEventListener('abort', stop)
    await session.close()
  }
}
