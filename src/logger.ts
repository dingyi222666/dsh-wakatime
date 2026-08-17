/**
 * Append-only file logger writing to `~/.wakatime/dsh-wakatime.log`
 * (`$WAKATIME_HOME/dsh-wakatime.log` when `WAKATIME_HOME` is set). Level is
 * DEBUG when the wakatime config declares `debug = true` or the plugin config
 * forces it; otherwise INFO. Logging never throws — a full disk or unwritable
 * home must not break dsh.
 * @module dsh-wakatime/logger
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getWakatimeLogFilePath } from './paths.ts'

/** Severity ordering; DEBUG is the most verbose. */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const

class FileLogger {
  private level: LogLevel = LogLevel.INFO

  /** Raise or lower the verbosity threshold. */
  setLevel(level: LogLevel): void {
    this.level = level
  }

  debug(msg: string): void {
    this.log(LogLevel.DEBUG, msg)
  }

  info(msg: string): void {
    this.log(LogLevel.INFO, msg)
  }

  warn(msg: string): void {
    this.log(LogLevel.WARN, msg)
  }

  error(msg: string): void {
    this.log(LogLevel.ERROR, msg)
  }

  /** Log an unknown thrown value as a warning line. */
  warnException(err: unknown): void {
    this.warn(err instanceof Error ? err.message : String(err))
  }

  /** Log an unknown thrown value as an error line. */
  errorException(err: unknown): void {
    this.error(err instanceof Error ? err.message : String(err))
  }

  private log(level: LogLevel, msg: string): void {
    if (level < this.level) return
    const line = `[${new Date().toISOString()}][${LEVEL_NAMES[level]}] ${msg}\n`
    try {
      const logFile = getWakatimeLogFilePath()
      const dir = path.dirname(logFile)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(logFile, line)
    } catch {
      // Logging is best-effort; an unwritable target must not affect dsh.
    }
  }
}

/** Process-wide logger singleton. */
export const logger = new FileLogger()
