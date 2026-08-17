/**
 * Plugin configuration: a schemastery-validated object the profile can set by
 * overriding the `wakatime` row's `config` key. Every field is optional;
 * defaults are applied in `resolveConfig` so a bare row works out of the box.
 * @module dsh-wakatime/config
 */

import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wakatime'

/** Raw config accepted from cordis.yml; all fields optional. */
export interface Config {
  /** Minimum milliseconds between heartbeats for one project. Default 60_000. */
  heartbeatIntervalMs?: number
  /** Force DEBUG logging. Default: the wakatime config's `debug = true`. */
  debug?: boolean
  /** Client qualifier appended to the harness name in the WakaTime `--plugin` tag. Default `dsh`. */
  client?: string
  /** Milliseconds before a heartbeat CLI invocation is terminated. Default 30_000. */
  timeoutMs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  heartbeatIntervalMs: z.number(),
  debug: z.boolean(),
  client: z.string(),
  timeoutMs: z.number(),
})

/** Defaults applied when a field is absent. */
export interface ResolvedConfig {
  heartbeatIntervalMs: number
  debug: boolean
  client: string
  timeoutMs: number
}

/** The dsh host version for the `--plugin` tag; best-effort, `unknown` when unresolvable. */
export const dshVersion: string = readDshVersion()

/** The plugin's own version for the `--plugin` tag; `unknown` when unresolvable. */
export const pluginVersion: string = readPluginVersion()

function readDshVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    return (require('@deepseek-ai/dsh/package.json') as { version: string }).version
  } catch {
    return 'unknown'
  }
}

function readPluginVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    return (require('../package.json') as { version: string }).version
  } catch {
    return 'unknown'
  }
}

/**
 * Apply defaults to a raw (possibly `undefined`) config value.
 * @param config - validated config, or `undefined` when the row supplies none.
 * @returns the effective configuration.
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  return {
    heartbeatIntervalMs: config?.heartbeatIntervalMs ?? 60_000,
    debug: config?.debug ?? false,
    client: config?.client ?? 'dsh',
    timeoutMs: config?.timeoutMs ?? 30_000,
  }
}

/**
 * The `--plugin` tag identifying DeepSeek Harness and this plugin to WakaTime.
 * @param client - the resolved client name (`dsh` for the default harness surface).
 * @returns a tag like `Deepseek Harness/0.1.0-rc.6 dsh-wakatime/0.1.1`.
 */
export function buildPluginTag(client: string): string {
  const clientTag = client === 'dsh' ? 'Deepseek Harness' : `Deepseek Harness-${client}`
  return `${clientTag}/${dshVersion} dsh-wakatime/${pluginVersion}`
}
