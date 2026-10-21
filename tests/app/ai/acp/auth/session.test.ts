import { describe, expect, test } from 'bun:test'

import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest
} from '@agentclientprotocol/sdk'

import { ACP_AGENTS } from '@open-pencil/core/constants'

import { checkAgentAuth, signInWithAgent, type AgentStreams } from '@/app/ai/acp/auth/session'
import { AUTH_STATUS_UPDATE_METHOD, type AgentAuthStatus } from '@/app/ai/acp/auth/status'
import { createDeferred } from '@/app/runtime/deferred'

import { expectDefined } from '#tests/helpers/assert'

const codex = expectDefined(
  ACP_AGENTS.find((agent) => agent.id === 'codex'),
  'Codex'
)

const SIGNED_OUT: AgentAuthStatus = { kind: 'none', label: 'Not logged in' }
const SIGNED_IN: AgentAuthStatus = {
  kind: 'account',
  label: 'ChatGPT Pro',
  account: { email: 'designer@example.com', plan: 'pro' }
}

/** An in-memory ACP agent that reports a login the way Claude's and Codex's adapters do. */
function fakeAgent(options: {
  /** Pushed after `initialize` answers; nothing when absent. */
  status?: AgentAuthStatus
  /** Pushed after `authenticate` finishes; `authenticate` never finishes when absent. */
  afterSignIn?: AgentAuthStatus
}) {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>()
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  const initialized: InitializeRequest[] = []
  const closed = createDeferred<undefined>()
  let connection: AgentSideConnection | null = null
  const push = (status: AgentAuthStatus) =>
    void connection?.extNotification(AUTH_STATUS_UPDATE_METHOD, { authStatus: status })
  const agent: Agent = {
    async initialize(params) {
      initialized.push(params)
      if (options.status) {
        const status = options.status
        setTimeout(() => push(status), 5)
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: '@agentclientprotocol/codex-acp', version: '2.2.2' },
        authMethods: [
          { id: 'chat-gpt', name: 'ChatGPT' },
          { id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal', args: ['login'] },
          { name: 'Missing id' }
        ]
      } as Awaited<ReturnType<Agent['initialize']>>
    },
    async newSession() {
      throw new Error('Not used')
    },
    async authenticate() {
      // Without a login to report, the sign-in waits as an unfinished browser login does.
      if (!options.afterSignIn) return createDeferred<never>().promise
      push(options.afterSignIn)
      return {}
    },
    async prompt() {
      throw new Error('Not used')
    },
    cancel: async () => undefined
  }
  connection = new AgentSideConnection(
    () => agent,
    ndJsonStream(toClient.writable, toAgent.readable)
  )
  // Ending the pipe ends what the client reads, as a killed process does.
  const output = new TransformStream<Uint8Array, Uint8Array>()
  const stop = new AbortController()
  toClient.readable
    .pipeTo(output.writable, { signal: stop.signal, preventCancel: true })
    .catch(() => undefined)
  const streams: AgentStreams = {
    input: toAgent.writable,
    output: output.readable,
    async close() {
      stop.abort()
      closed.resolve(undefined)
    }
  }
  return { spawn: async () => streams, initialized, closed: closed.promise }
}

describe('checkAgentAuth', () => {
  test('reads the login an agent reports after initialize, then stops it', async () => {
    const agent = fakeAgent({ status: SIGNED_IN })
    const result = await checkAgentAuth(codex, { spawn: agent.spawn })
    expect(result.status).toEqual(SIGNED_IN)
    expect(result.adapter).toEqual({ name: '@agentclientprotocol/codex-acp', version: '2.2.2' })
    expect(result.methods).toEqual([
      { id: 'chat-gpt', name: 'ChatGPT' },
      { id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' }
    ])
    await agent.closed
  })

  test('asks for terminal sign-in methods, which Claude offers only to clients that run them', async () => {
    const agent = fakeAgent({ status: SIGNED_OUT })
    await checkAgentAuth(codex, { spawn: agent.spawn })
    expect(agent.initialized[0]?.clientCapabilities?._meta).toEqual({ 'terminal-auth': true })
  })

  test('reports an unknown login when the agent says nothing in time', async () => {
    const agent = fakeAgent({})
    const result = await checkAgentAuth(codex, { spawn: agent.spawn, statusTimeoutMs: 20 })
    expect(result.status).toBeNull()
    await agent.closed
  })
})

describe('signInWithAgent', () => {
  test('returns the login the agent reports once authenticate finishes', async () => {
    const agent = fakeAgent({ status: SIGNED_OUT, afterSignIn: SIGNED_IN })
    const status = await signInWithAgent(codex, 'chat-gpt', new AbortController().signal, {
      spawn: agent.spawn
    })
    expect(status).toEqual(SIGNED_IN)
    await agent.closed
  })

  test('stops the agent when the sign-in is cancelled', async () => {
    const agent = fakeAgent({ status: SIGNED_OUT })
    const controller = new AbortController()
    const signIn = signInWithAgent(codex, 'chat-gpt', controller.signal, { spawn: agent.spawn })
    setTimeout(() => controller.abort(), 20)
    await expect(signIn).rejects.toThrow()
    await agent.closed
  })
})
