/**
 * Per-project heartbeat rate limiting. Each project folder gets its own state
 * file under the plugin state directory, keyed by a short hash of the folder,
 * so parallel dsh processes sharing a home do not spam the WakaTime API.
 * State is written to disk (not just memory) so the rate limit survives
 * process restarts, matching the official WakaTime clients' cadence.
 * @module dsh-wakatime/state
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getWakatimeStateDir } from './paths.ts'

interface StateFile {
  lastHeartbeatAt?: number
}

/** The state file for one project folder. */
export function stateFileFor(projectFolder: string, stateDir: string = getWakatimeStateDir()): string {
  const hash = crypto.createHash('md5').update(projectFolder).digest('hex').slice(0, 8)
  return path.join(stateDir, `${hash}.json`)
}

/** Read the persisted last-heartbeat timestamp; `0` when absent or corrupt. */
export function readLastHeartbeatAt(stateFile: string): number {
  try {
    const content = fs.readFileSync(stateFile, 'utf-8')
    const state = JSON.parse(content) as StateFile
    return typeof state.lastHeartbeatAt === 'number' ? state.lastHeartbeatAt : 0
  } catch {
    return 0
  }
}

/** Persist the given epoch-second timestamp as the project's last heartbeat. */
export function writeLastHeartbeatAt(stateFile: string, timestamp: number): void {
  try {
    const dir = path.dirname(stateFile)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ lastHeartbeatAt: timestamp }))
  } catch {
    // State is a rate-limit hint only; a write failure must not break dsh.
  }
}

/** Whether a heartbeat may be sent now: `force` bypasses the interval. */
export function shouldSendHeartbeat(
  stateFile: string,
  intervalMs: number,
  force: boolean = false,
  now: number = Date.now(),
): boolean {
  if (force) return true
  const last = readLastHeartbeatAt(stateFile)
  return now - last * 1000 >= intervalMs
}

/** Record that a heartbeat batch was sent just now. */
export function updateLastHeartbeat(stateFile: string, now: number = Date.now()): void {
  writeLastHeartbeatAt(stateFile, Math.floor(now / 1000))
}
