/**
 * Extract WakaTime file-change records from dsh `tool/call` + `tool/result`
 * session events. The fs tools (`edit`, `write`, `read`, `read_image`) and
 * the optional `str_replace_editor` carry the affected file in their call
 * arguments (`file_path` / `path`); `edit` and `write` results attach a
 * private `meta`
 * payload of applied diff hunks (`{ diffs: FileDiff[] }`) that yields exact
 * per-hunk line counts after trimming the shared context lines.
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

/** Narrow an opaque `tool/result` `meta` value to the fs tools' diff hunks. */
export function diffsFromMeta(meta: unknown): FileDiffHunk[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const valid = diffs.every((diff): diff is FileDiffHunk => {
    if (typeof diff !== 'object' || diff === null || Array.isArray(diff)) return false
    const { path, oldText, newText } = diff as Record<string, unknown>
    return typeof path === 'string'
      && (oldText === null || typeof oldText === 'string')
      && typeof newText === 'string'
  })
  return valid ? (diffs as FileDiffHunk[]) : undefined
}

/**
 * Count added/removed lines in one diff hunk. The hunk's `oldText`/`newText`
 * carry up to {@link DIFF_CONTEXT} unchanged context lines on each side;
 * trimming the identical prefix and suffix recovers the changed region, whose
 * length difference is the exact line delta.
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

/** Count the non-empty lines of a string (a write's content when no hunk exists). */
function countLines(text: string | undefined): number {
  if (text === undefined || text.length === 0) return 0
  return text.split('\n').length
}

/**
 * Derive file changes from one completed tool call. Reads report the file
 * with zero line changes (a heartbeat entity); writes and edits report line
 * deltas; searches and shell commands are ignored.
 * @param tool - the model-facing tool name from the `tool/call` event.
 * @param args - the parsed `tool/call` arguments.
 * @param meta - the `tool/result` `meta` payload (fs diff hunks when attached).
 * @returns the changes to track, or an empty array when the tool is not tracked.
 */
export function extractFileChanges(
  tool: string,
  args: Record<string, unknown>,
  meta: unknown,
): FileChange[] {
  switch (tool) {
    case 'edit': {
      const hunks = diffsFromMeta(meta)
      if (hunks !== undefined) {
        return hunks.map((hunk) => {
          const { additions, deletions } = countLineChanges(hunk.oldText, hunk.newText)
          return { file: hunk.path, additions, deletions, isWrite: false }
        })
      }
      const file = args.file_path
      if (typeof file === 'string' && file.length > 0) {
        return [{ file, additions: 0, deletions: 0, isWrite: false }]
      }
      return []
    }
    case 'write': {
      const file = args.file_path
      if (typeof file !== 'string' || file.length === 0) return []
      const hunks = diffsFromMeta(meta)
      if (hunks !== undefined) {
        return hunks.map((hunk) => {
          const { additions, deletions } = countLineChanges(hunk.oldText, hunk.newText)
          return { file: hunk.path, additions, deletions, isWrite: true }
        })
      }
      // A create (or identical overwrite) has no meta: charge the content lines.
      return [{ file, additions: countLines(args.content as string | undefined), deletions: 0, isWrite: true }]
    }
    case 'read':
    case 'read_image': {
      const file = args.file_path
      if (typeof file !== 'string' || file.length === 0) return []
      return [{ file, additions: 0, deletions: 0, isWrite: false }]
    }
    case 'str_replace_editor': {
      const file = args.path
      if (typeof file !== 'string' || file.length === 0) return []
      const command = args.command
      if (command === 'view') {
        return [{ file, additions: 0, deletions: 0, isWrite: false }]
      }
      if (command === 'create') {
        return [{ file, additions: countLines(args.file_text as string | undefined), deletions: 0, isWrite: true }]
      }
      if (command === 'str_replace') {
        return [{
          file,
          additions: countLines(args.new_str as string | undefined),
          deletions: countLines(args.old_str as string | undefined),
          isWrite: false,
        }]
      }
      if (command === 'insert') {
        return [{ file, additions: countLines(args.new_str as string | undefined), deletions: 0, isWrite: false }]
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
  if (file.startsWith('/')) return file
  // Windows absolute forms and drive-relative forms stay untouched.
  if (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('\\\\')) return file
  return `${projectFolder.replace(/\/$/, '')}/${file}`
}
