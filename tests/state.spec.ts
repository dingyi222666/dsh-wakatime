import { describe, expect, it } from 'vitest'
import { shouldSendHeartbeat, stateFileFor, updateLastHeartbeat } from '../src/state.ts'

describe('state', () => {
  it('derives one state file per project folder', () => {
    const a = stateFileFor('/repo/a', '/tmp/state')
    const b = stateFileFor('/repo/b', '/tmp/state')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^\/tmp\/state\/[0-9a-f]{8}\.json$/)
    // Same folder hashes identically.
    expect(stateFileFor('/repo/a', '/tmp/state')).toBe(a)
  })

  it('rate-limits within the interval and allows after it', () => {
    const file = stateFileFor('/repo/x', '/tmp/state-test')
    updateLastHeartbeat(file, 100_000)
    expect(shouldSendHeartbeat(file, 60_000, false, 130_000)).toBe(false)
    expect(shouldSendHeartbeat(file, 60_000, false, 170_000)).toBe(true)
  })

  it('force bypasses the interval', () => {
    const file = stateFileFor('/repo/y', '/tmp/state-test')
    updateLastHeartbeat(file, 100_000)
    expect(shouldSendHeartbeat(file, 60_000, true, 100_001)).toBe(true)
  })

  it('treats an absent state file as sendable', () => {
    expect(shouldSendHeartbeat('/tmp/state-test/does-not-exist.json', 60_000, false, 60_000)).toBe(true)
  })
})
