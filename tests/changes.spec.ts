import { describe, expect, it } from 'vitest'
import {
  countLineChanges,
  diffsFromMeta,
  extractFileChanges,
  resolveEntityPath,
  type FileDiffHunk,
} from '../src/changes.ts'

describe('countLineChanges', () => {
  it('counts a pure insertion', () => {
    expect(countLineChanges(null, 'a\nb\nc')).toEqual({ additions: 3, deletions: 0 })
  })

  it('counts a pure deletion', () => {
    expect(countLineChanges('a\nb\nc', null)).toEqual({ additions: 0, deletions: 3 })
  })

  it('trims identical context lines on both sides', () => {
    const oldText = 'keep\nold-line\nkeep2'
    const newText = 'keep\nnew-line\nkeep2'
    expect(countLineChanges(oldText, newText)).toEqual({ additions: 1, deletions: 1 })
  })

  it('handles empty strings', () => {
    expect(countLineChanges('', '')).toEqual({ additions: 0, deletions: 0 })
    expect(countLineChanges(null, null)).toEqual({ additions: 0, deletions: 0 })
  })

  it('counts a full replacement with no common lines', () => {
    expect(countLineChanges('x\ny', '1\n2\n3')).toEqual({ additions: 3, deletions: 2 })
  })
})

describe('diffsFromMeta', () => {
  it('accepts valid diff hunks', () => {
    const meta = { diffs: [{ path: '/a.ts', oldText: 'a', newText: 'b' }] }
    expect(diffsFromMeta(meta)).toEqual(meta.diffs)
  })

  it('rejects malformed meta', () => {
    expect(diffsFromMeta(undefined)).toBeUndefined()
    expect(diffsFromMeta({ diffs: 'nope' })).toBeUndefined()
    expect(diffsFromMeta({ diffs: [{ path: 1, oldText: 'a', newText: 'b' }] })).toBeUndefined()
    expect(diffsFromMeta({ diffs: [] })).toBeUndefined()
  })
})

describe('extractFileChanges', () => {
  it('uses edit meta hunks when present', () => {
    const meta = { diffs: [{ path: '/repo/a.ts', oldText: 'ctx\nold\nctx', newText: 'ctx\nnew\nctx' }] }
    const changes = extractFileChanges('edit', { file_path: '/repo/a.ts' }, meta)
    expect(changes).toEqual([{ file: '/repo/a.ts', additions: 1, deletions: 1, isWrite: false }])
  })

  it('falls back to the edit file_path without meta', () => {
    const changes = extractFileChanges('edit', { file_path: '/repo/a.ts' }, undefined)
    expect(changes).toEqual([{ file: '/repo/a.ts', additions: 0, deletions: 0, isWrite: false }])
  })

  it('extracts write changes from meta and marks them as writes', () => {
    const meta = { diffs: [{ path: '/repo/b.ts', oldText: null, newText: 'l1\nl2' }] }
    const changes = extractFileChanges('write', { file_path: '/repo/b.ts', content: 'l1\nl2' }, meta)
    expect(changes).toEqual([{ file: '/repo/b.ts', additions: 2, deletions: 0, isWrite: true }])
  })

  it('charges content lines for a write without meta (create)', () => {
    const changes = extractFileChanges('write', { file_path: '/repo/new.ts', content: 'a\nb\nc' }, undefined)
    expect(changes).toEqual([{ file: '/repo/new.ts', additions: 3, deletions: 0, isWrite: true }])
  })

  it('tracks reads with zero line changes', () => {
    const changes = extractFileChanges('read', { file_path: '/repo/a.ts', offset: 1, limit: 50 }, undefined)
    expect(changes).toEqual([{ file: '/repo/a.ts', additions: 0, deletions: 0, isWrite: false }])
  })

  it('handles str_replace_editor commands', () => {
    expect(extractFileChanges('str_replace_editor', { command: 'view', path: '/repo/a.ts' }, undefined))
      .toEqual([{ file: '/repo/a.ts', additions: 0, deletions: 0, isWrite: false }])
    expect(extractFileChanges('str_replace_editor', { command: 'create', path: '/repo/c.ts', file_text: 'x\ny' }, undefined))
      .toEqual([{ file: '/repo/c.ts', additions: 2, deletions: 0, isWrite: true }])
    expect(extractFileChanges('str_replace_editor', { command: 'str_replace', path: '/repo/d.ts', old_str: 'old\nold2', new_str: 'new' }, undefined))
      .toEqual([{ file: '/repo/d.ts', additions: 1, deletions: 2, isWrite: false }])
    expect(extractFileChanges('str_replace_editor', { command: 'insert', path: '/repo/e.ts', new_str: 'ins' }, undefined))
      .toEqual([{ file: '/repo/e.ts', additions: 1, deletions: 0, isWrite: false }])
  })

  it('ignores untracked tools', () => {
    expect(extractFileChanges('bash', { command: 'ls' }, undefined)).toEqual([])
    expect(extractFileChanges('glob', { pattern: '**/*.ts' }, undefined)).toEqual([])
    expect(extractFileChanges('todo_write', { todos: [] }, undefined)).toEqual([])
    expect(extractFileChanges('edit', { file_path: '' }, undefined)).toEqual([])
  })
})

describe('resolveEntityPath', () => {
  it('keeps absolute paths', () => {
    expect(resolveEntityPath('/repo/a.ts', '/repo')).toBe('/repo/a.ts')
  })

  it('resolves relative paths against the project folder', () => {
    expect(resolveEntityPath('a.ts', '/repo')).toBe('/repo/a.ts')
    expect(resolveEntityPath('src/a.ts', '/repo/')).toBe('/repo/src/a.ts')
  })

  it('keeps Windows absolute forms', () => {
    expect(resolveEntityPath('C:\\repo\\a.ts', '/repo')).toBe('C:\\repo\\a.ts')
    expect(resolveEntityPath('\\\\server\\share\\a.ts', '/repo')).toBe('\\\\server\\share\\a.ts')
  })
})
