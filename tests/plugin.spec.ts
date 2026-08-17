import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

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
})
