/**
 * Heartbeat dispatch: spawn `wakatime-cli` once per batch. The first heartbeat
 * rides the regular CLI arguments; additional heartbeats use the
 * `--extra-heartbeats` JSON input on stdin so a batch edit never spawns one
 * process per file. Active children are tracked and force-killed at process
 * exit so one-shot dsh runs cannot orphan them.
 * @module dsh-wakatime/heartbeat
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import * as os from 'node:os'
import { dependencies } from './cli.ts'
import { logger } from './logger.ts'

/** Default timeout for one heartbeat invocation (30 seconds). */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
/** Grace period between SIGTERM and SIGKILL on timeout. */
const HEARTBEAT_KILL_GRACE_MS = 2_000

const pendingHeartbeatBatches = new Set<Promise<void>>()
const activeHeartbeatProcesses = new Set<ChildProcess>()

/**
 * Process exit handlers cannot wait for pending promises. Force-kill any
 * remaining CLI children so one-shot dsh commands cannot orphan them.
 */
export function killActiveHeartbeats(): void {
  for (const child of activeHeartbeatProcesses) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try {
      child.kill('SIGKILL')
    } catch {
      // The process may have exited between the status check and the signal.
    }
  }
}

process.once('exit', killActiveHeartbeats)

/** One WakaTime heartbeat payload. */
export interface HeartbeatParams {
  /** Absolute path of the file being tracked. */
  entity: string
  /** Absolute project folder (sets `--project-folder`). */
  projectFolder: string
  /** Signed AI line change count (additions − deletions). */
  lineChanges?: number
  /** Heartbeat category; defaults to `ai coding`. */
  category?: string
  /** Whether the file was written. */
  isWrite?: boolean
}

function isWindows(): boolean {
  return os.platform() === 'win32'
}

function buildExecOptions(): SpawnOptions {
  const options: SpawnOptions = {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  }
  if (!isWindows() && !process.env.WAKATIME_HOME && !process.env.HOME) {
    options.env = { ...process.env, WAKATIME_HOME: os.homedir() }
  }
  return options
}

/** Format CLI args for the debug log without leaking secrets (there are none in args). */
export function formatArgs(args: string[]): string {
  return args
    .map((arg) => (arg.includes(' ') ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(' ')
}

/**
 * Send one batch of heartbeats in a single `wakatime-cli` invocation.
 * @param params - heartbeats to send; the first becomes the primary entity.
 * @param pluginTag - the `--plugin` tag (`Deepseek Harness/<version> dsh-wakatime/<version>`).
 * @param timeoutMs - per-invocation timeout (default 30 seconds).
 * @returns a promise settling when the CLI child exits or is terminated.
 */
export function sendHeartbeats(
  params: HeartbeatParams[],
  pluginTag: string,
  timeoutMs: number = DEFAULT_HEARTBEAT_TIMEOUT_MS,
): Promise<void> {
  const heartbeatBatch = new Promise<void>((resolve) => {
    if (params.length === 0) {
      resolve()
      return
    }
    const cliLocation = dependencies.getCliLocation()
    if (!dependencies.isCliInstalled()) {
      logger.warn('wakatime-cli not installed, skipping heartbeat')
      resolve()
      return
    }

    const [primary, ...extra] = params
    const args: string[] = [
      '--entity', primary.entity,
      '--entity-type', 'file',
      '--category', primary.category ?? 'ai coding',
      '--plugin', pluginTag,
    ]
    if (primary.projectFolder) {
      args.push('--project-folder', primary.projectFolder)
    }
    if (primary.lineChanges !== undefined && primary.lineChanges !== 0) {
      args.push('--ai-line-changes', primary.lineChanges.toString())
    }
    if (primary.isWrite) {
      args.push('--write')
    }
    if (extra.length > 0) {
      args.push('--extra-heartbeats')
    }

    logger.debug(`Sending ${params.length} heartbeat(s): wakatime-cli ${formatArgs(args)}`)

    const child = spawn(cliLocation, args, buildExecOptions())
    activeHeartbeatProcesses.add(child)

    let resolved = false
    let forceKillId: NodeJS.Timeout | undefined
    const resolveOnce = (): void => {
      if (resolved) return
      resolved = true
      activeHeartbeatProcesses.delete(child)
      clearTimeout(timeoutId)
      if (forceKillId) clearTimeout(forceKillId)
      resolve()
    }

    // Safety timeout — terminate the process, then force-kill if necessary.
    const timeoutId = setTimeout(() => {
      logger.warn(`Heartbeat batch timed out after ${timeoutMs}ms, terminating wakatime-cli`)
      try {
        child.kill('SIGTERM')
      } catch (error) {
        logger.error(`Failed to terminate wakatime-cli: ${error}`)
      }
      forceKillId = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        logger.warn('wakatime-cli did not exit after SIGTERM, sending SIGKILL')
        try {
          child.kill('SIGKILL')
        } catch (error) {
          logger.error(`Failed to kill wakatime-cli: ${error}`)
        }
      }, HEARTBEAT_KILL_GRACE_MS)
    }, timeoutMs)

    child.once('error', (error) => {
      logger.error(`wakatime-cli spawn error: ${error.message}`)
      resolveOnce()
    })

    child.once('close', (code, signal) => {
      if (code !== null && code !== 0) {
        logger.warn(`wakatime-cli exited with code ${code}`)
      } else if (signal) {
        logger.debug(`wakatime-cli terminated by signal ${signal}`)
      }
      resolveOnce()
    })

    const timestamp = Date.now() / 1000
    const extraHeartbeats = extra.map((heartbeat) => ({
      ai_line_changes: heartbeat.lineChanges !== undefined && heartbeat.lineChanges !== 0
        ? heartbeat.lineChanges
        : undefined,
      category: heartbeat.category ?? 'ai coding',
      entity: heartbeat.entity,
      entity_type: 'file',
      is_write: heartbeat.isWrite || undefined,
      time: timestamp,
    }))

    child.stdin?.on('error', (error) => {
      logger.error(`wakatime-cli stdin error: ${error.message}`)
    })
    child.stdin?.end(extraHeartbeats.length > 0 ? `${JSON.stringify(extraHeartbeats)}\n` : undefined)
  })

  if (params.length > 0) {
    pendingHeartbeatBatches.add(heartbeatBatch)
    void heartbeatBatch.then(
      () => pendingHeartbeatBatches.delete(heartbeatBatch),
      () => pendingHeartbeatBatches.delete(heartbeatBatch),
    )
  }

  return heartbeatBatch
}

/** Send one heartbeat. */
export function sendHeartbeat(
  params: HeartbeatParams,
  pluginTag: string,
  timeoutMs: number = DEFAULT_HEARTBEAT_TIMEOUT_MS,
): Promise<void> {
  return sendHeartbeats([params], pluginTag, timeoutMs)
}

/** Wait for every heartbeat batch currently in flight. */
export async function flushHeartbeats(): Promise<void> {
  while (pendingHeartbeatBatches.size > 0) {
    await Promise.all(pendingHeartbeatBatches)
  }
}

/** Whether a usable CLI exists (managed or global). */
export function isCliAvailable(): boolean {
  return dependencies.isCliInstalled() || dependencies.getCliLocationGlobal() !== undefined
}
