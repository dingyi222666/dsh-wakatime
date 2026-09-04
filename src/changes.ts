/**
 * Extract WakaTime file-change records from dsh `tool/call` + `tool/result`
 * session events. The fs tools (`edit`, `write`, `read`, `read_image`) and
 * the optional `str_replace_editor` carry the affected file in their call
 * arguments (`file_path` / `path`). Since dsh 0.1.3-alpha.1 every fs tool
 * also attaches a tool-private `meta` presentation payload to its durable
 * `tool/result` record:
 *
 * - `edit` / `write` → `{ diffs: FileDiff[] }` — exact per-hunk line counts
 *   after trimming the shared context lines;
 * - `read` / `read_image` → `{ path: <resolved display path>, … }` — the
 *   authoritative (sandbox-resolved) entity path.
 *
 * Meta is preferred over raw arguments whenever it carries more information;
 * the argument-derived fallbacks keep older hosts (meta-less results) and
 * `str_replace_editor` (which ships no result-time meta) working.
 * @module dsh-wakatime/changes
 */

/** One tracked file change, merged per file within a heartbeat window. */
export interface FileChange {
  /** Absolute path of the affected file, resolved against the project folder. */
  file: string
  /** Lines added by the operation. */
  additions: number
  /** Lines removed by the operation. */
  deletions: number
  /** Whether the operation wrote the file (new file or overwrite). */
  isWrite: boolean
}

/** A tool-result diff hunk as carried by the fs tools' `meta`. */
export interface FileDiffHunk {
  path: string
  oldText: string | null
  newText: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a path is absolute on any supported platform (POSIX, drive, UNC). */
export function isAbsolutePathLike(file: string): boolean {
  return file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith('\\\\')
}

/** Narrow an opaque `tool/result` `meta` value to the fs tools' diff hunks. */
export function diffsFromMeta(meta: unknown): FileDiffHunk[] | undefined {
  if (!isRecord(meta)) return undefined
  const diffs = meta.diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const valid = diffs.every((diff): diff is FileDiffHunk => {
    if (!isRecord(diff)) return false
    const { path, oldText, newText } = diff
    return typeof path === 'string'
      && (oldText === null || typeof oldText === 'string')
      && typeof newText === 'string'
  })
  return valid ? (diffs as FileDiffHunk[]) : undefined
}

/** The resolved entity path a read-like tool attaches to its result `meta`. */
export function metaEntityPath(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined
  const path = meta.path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

/**
 * Count added/removed lines in one diff hunk. The hunk's `oldText`/`newText`
 * carry unchanged context lines on each side; trimming the identical prefix
 * and suffix recovers the changed region, whose length difference is the
 * exact line delta.
 * @param oldText - the hunk's old lines (context + removals), or `null` for a pure insertion.
 * @param newText - the hunk's new lines (context + additions).
 * @returns added and removed line counts within the hunk.
 */
export function countLineChanges(
  oldText: string | null,
  newText: string | null,
): { additions: number; deletions: number } {
  const oldLines = oldText === null ? [] : oldText.split('\n')
  const newLines = newText === null ? [] : newText.split('\n')
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  }
}

/**
 * Count the non-empty lines of a string (a write's content when no hunk
 * exists). `null` counts as omitted: `str_replace_editor` (dsh >= 0.1.2-alpha)
 * accepts `null` placeholders for parameters a command does not use.
 */
function countLines(text: string | null | undefined): number {
  if (text == null || text.length === 0) return 0
  return text.split('\n').length
}

/**
 * Pick the entity path for one completed tool call: the absolute resolved
 * path from the result `meta` wins (it reflects what the sandbox actually
 * touched), otherwise the model-visible argument path is used.
 * @param argsPath - the raw argument value (`file_path` / `path`), if any.
 * @param metaPath - the resolved display path from the result `meta`, if any.
 * @returns the preferred entity path, or `undefined` when neither exists.
 */
function entityPath(argsPath: unknown, metaPath: string | undefined): string | undefined {
  if (metaPath !== undefined && isAbsolutePathLike(metaPath)) return metaPath
  if (typeof argsPath === 'string' && argsPath.length > 0) return argsPath
  return metaPath
}

/** Map diff hunks to per-file change records. */
function changesFromHunks(hunks: FileDiffHunk[], isWrite: boolean): FileChange[] {
  return hunks.map((hunk) => {
    const { additions, deletions } = countLineChanges(hunk.oldText, hunk.newText)
    return { file: hunk.path, additions, deletions, isWrite }
  })
}

/**
 * Derive file changes from one completed tool call. Reads report the file
 * with zero line changes (a heartbeat entity); writes and edits report line
 * deltas; searches and shell commands are ignored.
 * @param tool - the model-facing tool name from the `tool/call` event.
 * @param args - the parsed `tool/call` arguments.
 * @param meta - the `tool/result` `meta` payload (fs diff hunks / resolved path when attached).
 * @returns the changes to track, or an empty array when the tool is not tracked.
 */
export function extractFileChanges(
  tool: string,
  args: Record<string, unknown>,
  meta: unknown,
): FileChange[] {
  const hunks = diffsFromMeta(meta)
  const metaPath = metaEntityPath(meta)
  switch (tool) {
    case 'edit': {
      if (hunks !== undefined) return changesFromHunks(hunks, false)
      const file = entityPath(args.file_path, metaPath)
      if (file !== undefined) return [{ file, additions: 0, deletions: 0, isWrite: false }]
      return []
    }
    case 'write': {
      const file = entityPath(args.file_path, metaPath)
      if (file === undefined) return []
      if (hunks !== undefined) return changesFromHunks(hunks, true)
      // A create (or identical overwrite) has no hunk: charge the content lines.
      return [{ file, additions: countLines(args.content as string | null | undefined), deletions: 0, isWrite: true }]
    }
    case 'read':
    case 'read_image': {
      const file = entityPath(args.file_path, metaPath)
      if (file === undefined) return []
      return [{ file, additions: 0, deletions: 0, isWrite: false }]
    }
    case 'str_replace_editor': {
      // Some hosts attach result-time diff hunks (dsh >= 0.1.3-alpha.1 tool
      // plugins may); prefer their exact counts when present.
      if (hunks !== undefined) return changesFromHunks(hunks, false)
      const file = entityPath(args.path, metaPath)
      if (file === undefined) return []
      const command = args.command
      if (command === 'view') {
        return [{ file, additions: 0, deletions: 0, isWrite: false }]
      }
      if (command === 'create') {
        return [{ file, additions: countLines(args.file_text as string | null | undefined), deletions: 0, isWrite: true }]
      }
      if (command === 'str_replace') {
        return [{
          file,
          additions: countLines(args.new_str as string | null | undefined),
          deletions: countLines(args.old_str as string | null | undefined),
          isWrite: false,
        }]
      }
      if (command === 'insert') {
        return [{ file, additions: countLines(args.new_str as string | null | undefined), deletions: 0, isWrite: false }]
      }
      return []
    }
    default:
      // bash, glob, grep, todo_write, and every other tool carry no file change.
      return []
  }
}

/** Resolve a possibly-relative tool path against the session's project folder. */
export function resolveEntityPath(file: string, projectFolder: string): string {
  if (isAbsolutePathLike(file)) return file
  return `${projectFolder.replace(/\/$/, '')}/${file}`
}
