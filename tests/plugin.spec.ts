import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: types the scoped agent/* cordis events (dsh >= 0.1.3-alpha.1).
import type {} from '@deepseek-ai/dsh-agent'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execSync: vi.fn(() => ''),
}))
vi.mock('../src/cli.ts', () => ({
  dependencies: {
    getCliLocation: () => '/usr/local/bin/wakatime-cli',
    isCliInstalled: () => true,
    getCliLocationGlobal: () => undefined,
  },
  ensureCliInstalled: vi.fn(async () => true),
}))

import { apply, Config, name } from '../src/index.ts'
import { stateFileFor, writeLastHeartbeatAt } from '../src/state.ts'

/** A fake ChildProcess that reports 'close' on the next tick. */
function autoClosingChild() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const child = {
    stdin: { end: vi.fn(), on: vi.fn() },
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb)
      if (event === 'close') setImmediate(() => cb(0, null))
    }),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  }
  return child
}

function toolCall(callId: string, tool: string, args: Record<string, unknown>): SessionEvent {
  return {
    type: 'tool/call',
    seq: 0,
    time: Date.now(),
    data: { turn: 0, step: 0, callId, name: tool, arguments: JSON.stringify(args) },
  } as unknown as SessionEvent
}

function toolResult(callId: string, meta?: unknown, error?: { name: string; code: string }): SessionEvent {
  return {
    type: 'tool/result',
    seq: 1,
    time: Date.now(),
    data: {
      turn: 0,
      step: 0,
      message: { source: { callId } },
      ...error === undefined ? {} : { error },
      ...meta === undefined ? {} : { meta },
    },
  } as unknown as SessionEvent
}

const session = { header: { cwd: '/tmp/wk-project' } } as unknown as Session

/** An `agent/status` running transition for the fixture session (dsh 0.1.3-alpha.1). */
function agentRunning(sessionValue: Session): never {
  return { agent: { session: sessionValue }, status: 'running' } as never
}

/** An `agent/assistant-stream` chunk frame for the fixture session. */
function agentStreamChunk(sessionValue: Session): never {
  return {
    agent: { session: sessionValue },
    frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', text: 'hi' } },
  } as never
}

/** A v2 `assistant/message` settlement with an embedded provider stream (dsh 0.1.3-alpha.1). */
function assistantMessageWithStream(seq: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: {
      turn: 0,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      stream: [
        { index: 0, time: Date.now(), chunk: { type: 'text-delta', text: 'hi' } },
        { index: 1, time: Date.now() + 1, chunk: { type: 'end', stopReason: 'end_turn' } },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  } as unknown as SessionEvent
}

/** A committed-but-message-less model attempt (dsh 0.1.3-alpha.1). */
function assistantAttempt(seq: number): SessionEvent {
  return {
    type: 'assistant/attempt',
    seq,
    time: Date.now(),
    data: { turn: 0, step: 0, stream: [] },
  } as unknown as SessionEvent
}

let wakatimeHome: string

beforeEach(() => {
  wakatimeHome = mkdtempSync(join(tmpdir(), 'dsh-wakatime-test-'))
  process.env.WAKATIME_HOME = wakatimeHome
  spawnMock.mockReset()
})

afterEach(() => {
  delete process.env.WAKATIME_HOME
  rmSync(wakatimeHome, { recursive: true, force: true })
})

describe('plugin wiring', () => {
  it('tracks tool results, rate-limits, and force-flushes on dispose', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name, Config, apply }, { debug: true, heartbeatIntervalMs: 60_000 })

    ctx.emit('session/event', session, toolCall('c1', 'edit', { file_path: '/tmp/wk-project/a.ts' }))
    ctx.emit('session/event', session, toolResult('c1', {
      diffs: [{ path: '/tmp/wk-project/a.ts', oldText: 'ctx\nold\nctx', newText: 'ctx\nnew1\nnew2\nctx' }],
    }))

    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const firstArgs = spawnMock.mock.calls[0]![1] as string[]
    expect(firstArgs).toContain('--entity')
    expect(firstArgs).toContain('/tmp/wk-project/a.ts')
    expect(firstArgs).toContain('--ai-line-changes')
    expect(firstArgs).toContain('1')

    // A second edit inside the rate-limit window stays pending (no spawn).
    ctx.emit('session/event', session, toolCall('c2', 'edit', { file_path: '/tmp/wk-project/b.ts' }))
    ctx.emit('session/event', session, toolResult('c2', {
      diffs: [{ path: '/tmp/wk-project/b.ts', oldText: 'x', newText: 'y\nz' }],
    }))

    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(1)

    // Disposing the plugin force-flushes the pending changes.
    spawnMock.mockReturnValue(autoClosingChild())
    await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))

    expect(spawnMock).toHaveBeenCalledTimes(2)
    const secondArgs = spawnMock.mock.calls[1]![1] as string[]
    expect(secondArgs).toContain('--entity')
    expect(secondArgs).toContain('/tmp/wk-project/b.ts')
    expect(secondArgs).toContain('--ai-line-changes')
    expect(secondArgs).toContain('1')
  })

  it('ignores failed tool results and untracked tools', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name, Config, apply }, { debug: true })

    ctx.emit('session/event', session, toolCall('f1', 'edit', { file_path: '/tmp/wk-project/a.ts' }))
    ctx.emit('session/event', session, toolResult('f1', undefined, { name: 'E', code: 'X' }))
    ctx.emit('session/event', session, toolCall('f2', 'bash', { command: 'ls' }))
    ctx.emit('session/event', session, toolResult('f2'))

    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).not.toHaveBeenCalled()

    spawnMock.mockReturnValue(autoClosingChild())
    await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('prefers the resolved read path from tool/result meta (dsh 0.1.3-alpha.1)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name, Config, apply }, { debug: true, heartbeatIntervalMs: 60_000 })
    spawnMock.mockReturnValue(autoClosingChild())

    // The args carry the model-visible relative path; the durable meta carries
    // the sandbox-resolved absolute path, which must win as the entity.
    ctx.emit('session/event', session, toolCall('r1', 'read', { file_path: 'src/a.ts' }))
    ctx.emit('session/event', session, toolResult('r1', {
      path: '/tmp/wk-project/src/a.ts',
      offset: 1,
      lines: [{ number: 1, text: 'x' }],
      totalLines: 1,
    }))

    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const args = spawnMock.mock.calls[0]![1] as string[]
    expect(args).toContain('--entity')
    expect(args).toContain('/tmp/wk-project/src/a.ts')
    expect(args).not.toContain('--ai-line-changes')

    await fiber.dispose()
  })

  it('sends live activity heartbeats from agent events while a turn streams', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name, Config, apply }, { debug: true, heartbeatIntervalMs: 0 })
    spawnMock.mockReturnValue(autoClosingChild())

    // Establish the project's current entity with a read.
    ctx.emit('session/event', session, toolCall('r1', 'read', { file_path: '/tmp/wk-project/a.ts' }))
    ctx.emit('session/event', session, toolResult('r1'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(1)

    // Live agent activity (status + stream chunk) heartbeats the entity even
    // with an empty change buffer.
    ctx.emit('agent/status', agentRunning(session))
    ctx.emit('agent/assistant-stream', agentStreamChunk(session))
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(3)
    for (let i = 1; i < 3; i++) {
      const args = spawnMock.mock.calls[i]![1] as string[]
      expect(args).toContain('--entity')
      expect(args).toContain('/tmp/wk-project/a.ts')
      expect(args).not.toContain('--ai-line-changes')
      expect(args).not.toContain('--write')
    }

    await fiber.dispose()
  })

  it('shares the per-project rate-limit budget with durable heartbeats', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name, Config, apply }, { debug: true, heartbeatIntervalMs: 60_000 })
    spawnMock.mockReturnValue(autoClosingChild())

    // The read heartbeat arms the shared per-project budget…
    ctx.emit('session/event', session, toolCall('r1', 'read', { file_path: '/tmp/wk-project/a.ts' }))
    ctx.emit('session/event', session, toolResult('r1'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(1)

    // …so a status transition and a chunk storm right after must not spawn.
    ctx.emit('agent/status', agentRunning(session))
    ctx.emit('agent/assistant-stream', agentStreamChunk(session))
    ctx.emit('agent/assistant-stream', agentStreamChunk(session))
    ctx.emit('agent/assistant-stream', agentStreamChunk(session))
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(1)

    await fiber.dispose()
  })

  it('checkpoints durable settlements with embedded streams and message-less attempts', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name, Config, apply }, { debug: true, heartbeatIntervalMs: 60_000 })
    spawnMock.mockReturnValue(autoClosingChild())

    // One heartbeat arms the per-project rate-limit budget…
    ctx.emit('session/event', session, toolCall('r1', 'read', { file_path: '/tmp/wk-project/a.ts' }))
    ctx.emit('session/event', session, toolResult('r1'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(1)

    // …so the edit stays pending and the v2 assistant/message settlement (with
    // an embedded provider stream) cannot flush it yet either.
    ctx.emit('session/event', session, toolCall('e1', 'edit', { file_path: '/tmp/wk-project/b.ts' }))
    ctx.emit('session/event', session, toolResult('e1', {
      diffs: [{ path: '/tmp/wk-project/b.ts', oldText: 'ctx\na\nctx', newText: 'ctx\nb\nc\nctx' }],
    }))
    ctx.emit('session/event', session, assistantMessageWithStream(2))
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(1)

    // Reopen the shared budget (simulate the 60 s window elapsing)…
    writeLastHeartbeatAt(stateFileFor('/tmp/wk-project'), Math.floor(Date.now() / 1000) - 120)

    // …and a message-less attempt settlement flushes the pending edit.
    ctx.emit('session/event', session, assistantAttempt(3))
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(2)
    const secondArgs = spawnMock.mock.calls[1]![1] as string[]
    expect(secondArgs).toContain('--entity')
    expect(secondArgs).toContain('/tmp/wk-project/b.ts')
    expect(secondArgs).toContain('--ai-line-changes')

    // A second edit inside the reopened window stays pending for the final
    // force flush.
    ctx.emit('session/event', session, toolCall('e2', 'edit', { file_path: '/tmp/wk-project/c.ts' }))
    ctx.emit('session/event', session, toolResult('e2', {
      diffs: [{ path: '/tmp/wk-project/c.ts', oldText: 'x', newText: 'y\nz' }],
    }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(2)

    await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(3)
    const thirdArgs = spawnMock.mock.calls[2]![1] as string[]
    expect(thirdArgs).toContain('--entity')
    expect(thirdArgs).toContain('/tmp/wk-project/c.ts')
    expect(thirdArgs).toContain('--ai-line-changes')
  })

  it('tolerates ignorable records and unknown event types alongside v2 shapes', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name, Config, apply }, { debug: true, heartbeatIntervalMs: 60_000 })
    spawnMock.mockReturnValue(autoClosingChild())

    const ignorable = { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 0 }, ignorable: true } as unknown as SessionEvent
    const unknown = { type: 'compaction/end', seq: 1, time: Date.now(), data: { reason: 'manual' } } as unknown as SessionEvent

    ctx.emit('session/event', session, ignorable)
    ctx.emit('session/event', session, unknown)
    ctx.emit('session/event', session, toolCall('r1', 'read', { file_path: '/tmp/wk-project/a.ts' }))
    ctx.emit('session/event', session, toolResult('r1', undefined, { name: 'E', code: 'X' }))
    ctx.emit('session/event', session, assistantMessageWithStream(2))
    ctx.emit('session/event', session, assistantAttempt(3))

    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).not.toHaveBeenCalled()

    await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
