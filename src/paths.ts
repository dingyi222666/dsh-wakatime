/**
 * WakaTime path resolution: the home directory, the resources directory
 * (where dsh-wakatime keeps the downloaded CLI and its state/log files), and
 * the `~/.wakatime.cfg` config file. Honors `WAKATIME_HOME` with `~` tilde
 * expansion, matching the official WakaTime clients.
 * @module dsh-wakatime/paths
 */

import * as os from 'node:os'
import * as path from 'node:path'

/** Resolve `WAKATIME_HOME` (with `~` expansion) when set. */
function wakatimeHomeFromEnv(): string | undefined {
  const value = process.env.WAKATIME_HOME?.trim()
  if (!value) return undefined
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

/** The directory holding `.wakatime.cfg` — `$WAKATIME_HOME` or the home directory. */
export function getWakatimeHomeDir(): string {
  return wakatimeHomeFromEnv() ?? os.homedir()
}

/** The directory holding CLI downloads and plugin state — `$WAKATIME_HOME` or `~/.wakatime`. */
export function getWakatimeResourcesDir(): string {
  return wakatimeHomeFromEnv() ?? path.join(os.homedir(), '.wakatime')
}

/** The `~/.wakatime.cfg` (or `$WAKATIME_HOME/.wakatime.cfg`) settings file. */
export function getWakatimeConfigFilePath(): string {
  return path.join(getWakatimeHomeDir(), '.wakatime.cfg')
}

/** The per-project rate-limit state directory inside the resources dir. */
export function getWakatimeStateDir(): string {
  return path.join(getWakatimeResourcesDir(), 'dsh-wakatime')
}

/** The plugin log file inside the resources dir. */
export function getWakatimeLogFilePath(): string {
  return path.join(getWakatimeResourcesDir(), 'dsh-wakatime.log')
}
