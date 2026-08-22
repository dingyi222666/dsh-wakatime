/**
 * dsh-wakatime: WakaTime plugin for DeepSeek Harness (dsh).
 *
 * Tracks the file operations the agent performs (`edit`, `write`, `read`,
 * `read_image`, `str_replace_editor`) through the session event firehose,
 * batches the
 * resulting line changes per project, and sends rate-limited heartbeats to
 * WakaTime through `wakatime-cli` (auto-installed when missing). A final
 * forced flush runs when a session is disposed and when the plugin tree
 * tears down, so one-shot `dsh --profile headless` runs still report their
 * activity.
 *
 * Loaded as a bundle plugin: `dsh plugin --profile web add <this package>`.
 * @module dsh-wakatime
 */

import * as fs from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { Config, name, resolveConfig, buildPluginTag, type Config as ConfigShape } from './config.ts'
import { extractFileChanges, resolveEntityPath, type FileChange } from './changes.ts'
import { sendHeartbeats, flushHeartbeats, type HeartbeatParams } from './heartbeat.ts'
import { ensureCliInstalled } from './cli.ts'
import { logger, LogLevel } from './logger.ts'
import { getWakatimeConfigFilePath } from './paths.ts'
import { shouldSendHeartbeat, stateFileFor, updateLastHeartbeat } from './state.ts'

export { Config, name }
export type { Config as WakatimeConfig } from './config.ts'

/** A recorded `tool/call`, kept until its `tool/result` arrives. */
interface PendingCall {
  tool: string
  args: Record<string, unknown>
}

/** Cap for the callId join map; the oldest half is dropped when exceeded. */
const MAX_PENDING_CALLS = 1000

/** Cap for pending changes per project, preventing unbounded growth on spam. */
const MAX_CHANGES_PER_PROJECT = 5000

/** Read `debug = true` from `~/.wakatime.cfg` (`$WAKATIME_HOME/.wakatime.cfg`). */
function readDebugFromWakatimeConfig(): boolean {
  try {
    const cfg = fs.readFileSync(getWakatimeConfigFilePath(), 'utf-8')
    return /^\s*debug\s*=\s*true\s*$/m.test(cfg)
  } catch {
    return false
  }
}

/** Plugin entry: subscribe to session events and dispatch heartbeats. */
export function apply(ctx: Context, rawConfig: ConfigShape | undefined): void {
  const config = resolveConfig(rawConfig)
  const cfgDebug = readDebugFromWakatimeConfig()
  if (config.debug || cfgDebug) logger.setLevel(LogLevel.DEBUG)
  const pluginTag = buildPluginTag(config.client)

  // CLI installation runs in the background: boot must not block on a download.
  void ensureCliInstalled().then((installed) => {
    if (installed) {
      logger.info(`dsh-wakatime initialized (${pluginTag})`)
    } else {
      logger.warn('wakatime-cli could not be installed; install it manually from https://wakatime.com/terminal')
    }
  })

  const pendingCalls = new Map<string, PendingCall>()
  const changesByProject = new Map<string, Map<string, FileChange>>()

  /** The project folder for a session: its header cwd, else the process cwd. */
  const projectFolderOf = (session: Session): string => session.header.cwd ?? process.cwd()

  /** Merge one change into the project's pending map (aggregating per file). */
  const trackChange = (projectFolder: string, change: FileChange): void => {
    let changes = changesByProject.get(projectFolder)
    if (changes === undefined) {
      changes = new Map()
      changesByProject.set(projectFolder, changes)
    }
    if (changes.size >= MAX_CHANGES_PER_PROJECT) return
    const existing = changes.get(change.file) ?? { file: change.file, additions: 0, deletions: 0, isWrite: false }
    changes.set(change.file, {
      file: change.file,
      additions: existing.additions + change.additions,
      deletions: existing.deletions + change.deletions,
      isWrite: existing.isWrite || change.isWrite,
    })
  }

  /**
   * Send the pending heartbeats for one project. Rate-limited unless `force`;
   * a forced flush also awaits every in-flight CLI invocation.
   */
  const processHeartbeat = async (projectFolder: string, force: boolean): Promise<void> => {
    const stateFile = stateFileFor(projectFolder)
    if (!shouldSendHeartbeat(stateFile, config.heartbeatIntervalMs, force)) {
      logger.debug(`Skipping heartbeat for ${projectFolder} (rate limited)`)
      return
    }
    const changes = changesByProject.get(projectFolder)
    if (changes === undefined || changes.size === 0) {
      if (force) await flushHeartbeats()
      return
    }
    const heartbeats: HeartbeatParams[] = []
    for (const [file, info] of changes) {
      heartbeats.push({
        entity: file,
        projectFolder,
        lineChanges: info.additions - info.deletions,
        category: 'ai coding',
        isWrite: info.isWrite,
      })
    }
    changes.clear()
    updateLastHeartbeat(stateFile)
    logger.debug(`Sending ${heartbeats.length} heartbeat(s) for ${projectFolder}`)
    void sendHeartbeats(heartbeats, pluginTag, config.timeoutMs)
    if (force) await flushHeartbeats()
  }

  /** Force-flush every project with pending changes. */
  const flushAllProjects = async (): Promise<void> => {
    for (const projectFolder of changesByProject.keys()) {
      await processHeartbeat(projectFolder, true)
    }
  }

  ctx.on('session/event', (session, event: SessionEvent) => {
    const projectFolder = projectFolderOf(session)
    switch (event.type) {
      case 'tool/call': {
        if (pendingCalls.size >= MAX_PENDING_CALLS) {
          const ids = [...pendingCalls.keys()]
          for (let i = 0; i < MAX_PENDING_CALLS / 2; i++) pendingCalls.delete(ids[i]!)
        }
        let args: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(event.data.arguments)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>
          }
        } catch {
          // Malformed model arguments: still record the call with empty args.
        }
        pendingCalls.set(String(event.data.callId), { tool: event.data.name, args })
        break
      }
      case 'tool/result': {
        const callId = String(event.data.message.source.callId)
        const pending = pendingCalls.get(callId)
        pendingCalls.delete(callId)
        if (pending === undefined || event.data.error !== undefined) break
        const changes = extractFileChanges(pending.tool, pending.args, event.data.meta)
        if (changes.length === 0) break
        for (const change of changes) {
          trackChange(projectFolder, { ...change, file: resolveEntityPath(change.file, projectFolder) })
        }
        void processHeartbeat(projectFolder, false)
        break
      }
      case 'user/message':
      case 'assistant/message':
      case 'turn/end': {
        // Chat activity and turn boundaries are natural checkpoints: send any
        // pending changes, subject to the per-project rate limit.
        const changes = changesByProject.get(projectFolder)
        if (changes !== undefined && changes.size > 0) {
          void processHeartbeat(projectFolder, false)
        }
        break
      }
      default:
        // Merge-extensible session events: non-tracking records are ignored.
        break
    }
  })

  ctx.on('session/disposed', (session) => {
    void processHeartbeat(projectFolderOf(session), true)
  })

  // App teardown: flush whatever is still pending (headless runs dispose the
  // tree right after the task settles, with no session/disposed event).
  ctx.effect(() => () => flushAllProjects(), 'dsh-wakatime: final heartbeat flush')
}
