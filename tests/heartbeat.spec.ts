import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('../src/cli.ts', () => ({
  dependencies: {
    getCliLocation: () => '/usr/local/bin/wakatime-cli',
    isCliInstalled: () => true,
  },
}))

import { flushHeartbeats, sendHeartbeats } from '../src/heartbeat.ts'
import { buildPluginTag } from '../src/config.ts'

/** A fake ChildProcess whose 'close' can be triggered by the test. */
function fakeChild(): {
  child: ChildProcess
  triggerClose: (code: number | null, signal: NodeJS.Signals | null) => void
  stdinEnd: ReturnType<typeof vi.fn>
} {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const stdinEnd = vi.fn()
  const child = {
    stdin: { end: stdinEnd, on: vi.fn() },
    once: vi.fn((name: string, cb: (...args: unknown[]) => void) => { handlers.set(name, cb) }),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  } as unknown as ChildProcess
  return {
    child,
    stdinEnd,
    triggerClose: (code, signal) => {
      ;(child as unknown as { exitCode: number | null }).exitCode = code
      handlers.get('close')?.(code, signal)
    },
  }
}

beforeEach(() => {
  spawnMock.mockReset()
})

describe('sendHeartbeats', () => {
  it('spawns wakatime-cli with the primary heartbeat as CLI args', async () => {
    const { child, triggerClose } = fakeChild()
    spawnMock.mockReturnValue(child)
    const promise = sendHeartbeats(
      [{ entity: '/repo/a.ts', projectFolder: '/repo', lineChanges: 3, isWrite: false }],
      'dsh/0.1.0 dsh-wakatime/0.1.0',
    )
    triggerClose(0, null)
    await promise

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const args = spawnMock.mock.calls[0]![1] as string[]
    expect(args).toContain('--entity')
    expect(args).toContain('/repo/a.ts')
    expect(args).toContain('--entity-type')
    expect(args).toContain('file')
    expect(args).toContain('--category')
    expect(args).toContain('ai coding')
    expect(args).toContain('--plugin')
    expect(args).toContain('dsh/0.1.0 dsh-wakatime/0.1.0')
    expect(args).toContain('--ai-line-changes')
    expect(args).toContain('3')
    expect(args).toContain('--project-folder')
    expect(args).toContain('/repo')
    expect(args).not.toContain('--write')
  })

  it('adds --write and omits zero line changes', async () => {
    const { child, triggerClose } = fakeChild()
    spawnMock.mockReturnValue(child)
    const promise = sendHeartbeats(
      [{ entity: '/repo/new.ts', projectFolder: '/repo', lineChanges: 0, isWrite: true }],
      'dsh/0.1.0 dsh-wakatime/0.1.0',
    )
    triggerClose(0, null)
    await promise

    const args = spawnMock.mock.calls[0]![1] as string[]
    expect(args).toContain('--write')
    expect(args).not.toContain('--ai-line-changes')
  })

  it('passes extra heartbeats as JSON on stdin', async () => {
    const { child, stdinEnd, triggerClose } = fakeChild()
    spawnMock.mockReturnValue(child)
    const promise = sendHeartbeats(
      [
        { entity: '/repo/a.ts', projectFolder: '/repo', lineChanges: 1 },
        { entity: '/repo/b.ts', projectFolder: '/repo', lineChanges: -2 },
        { entity: '/repo/c.ts', projectFolder: '/repo', isWrite: true },
      ],
      'dsh/0.1.0 dsh-wakatime/0.1.0',
    )
    triggerClose(0, null)
    await promise

    const args = spawnMock.mock.calls[0]![1] as string[]
    expect(args).toContain('--extra-heartbeats')
    const payload = JSON.parse(stdinEnd.mock.calls[0]![0] as string) as Array<Record<string, unknown>>
    expect(payload).toHaveLength(2)
    expect(payload[0]).toMatchObject({ entity: '/repo/b.ts', ai_line_changes: -2, entity_type: 'file' })
    expect(payload[1]).toMatchObject({ entity: '/repo/c.ts', is_write: true })
  })

  it('resolves without spawning when there are no heartbeats', async () => {
    await sendHeartbeats([], 'dsh/0.1.0 dsh-wakatime/0.1.0')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('flushHeartbeats settles once all batches close', async () => {
    const first = fakeChild()
    const second = fakeChild()
    spawnMock.mockReturnValueOnce(first.child).mockReturnValueOnce(second.child)
    void sendHeartbeats([{ entity: '/repo/a.ts', projectFolder: '/repo' }], 'tag')
    void sendHeartbeats([{ entity: '/repo/b.ts', projectFolder: '/repo' }], 'tag')
    let flushed = false
    void flushHeartbeats().then(() => { flushed = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(flushed).toBe(false)
    first.triggerClose(0, null)
    second.triggerClose(0, null)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(flushed).toBe(true)
  })
})

describe('buildPluginTag', () => {
  it('uses the dsh client name for the default client', () => {
    expect(buildPluginTag('dsh')).toMatch(/^dsh\/.+ dsh-wakatime\/.+$/)
  })

  it('prefixes a custom client', () => {
    expect(buildPluginTag('web')).toMatch(/^dsh-web\/.+ dsh-wakatime\/.+$/)
  })
})
