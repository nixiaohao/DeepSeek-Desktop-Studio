/**
 * file-tree.ts — the sidebar's tree state: which directory is showing, which
 * folders are open, and what has been read from disk.
 *
 * The renderer never walks the filesystem. It asks for a flat list of rows and
 * draws them; every decision about shape, ordering and what to hide lives here
 * or in fs-tree.ts. That keeps the HTML dumb, and keeps the tree testable
 * without Electron.
 *
 * Two things are cached on purpose:
 *  - directory listings, so re-rendering (which happens on every git refresh)
 *    does not re-stat the disk;
 *  - nothing else. File contents are never read here; the sidebar is a
 *    navigator, not an editor.
 *
 * Symlinked directories are listed but NOT descended into: `isDirectory()` is
 * false for a symlink, so a link pointing at an ancestor cannot send the walk
 * into a cycle. That is a deliberate trade — such folders show no triangle.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isIgnoredName,
  buildTreeRows,
  indexGitStatus,
  gitStatusFor,
  relativeTo,
  type DirEntry,
  type TreeRow,
  type GitStatusEntry,
} from './fs-tree.js'

/** Read one directory level. Injected so tests need no filesystem. */
export type ReadDirFn = (dir: string) => DirEntry[]

export interface FileTreeOptions {
  readDirSync?: ReadDirFn
}

export interface TreeSnapshot {
  /** The directory whose children are the top-level rows. */
  root: string
  rows: TreeRow[]
  /** True when MAX_TREE_ROWS cut the walk short. */
  truncated: boolean
  /** Directories that could not be read, with why. */
  errors: { path: string; message: string }[]
}

export class FileTree {
  private rootDir = ''
  private readonly expanded = new Set<string>()
  private readonly cache = new Map<string, DirEntry[]>()
  private readonly broken = new Map<string, string>()
  private readonly readDirFn: ReadDirFn

  constructor(opts: FileTreeOptions = {}) {
    this.readDirFn = opts.readDirSync ?? defaultReadDir
  }

  get root(): string {
    return this.rootDir
  }

  /** Point the tree at a new directory. Expansion state is deliberately lost. */
  setRoot(dir: string): void {
    if (dir === this.rootDir) return
    this.rootDir = dir
    this.expanded.clear()
    this.cache.clear()
    this.broken.clear()
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(path)
  }

  /** Open a folder, or close it if it is already open. */
  toggle(path: string): void {
    if (this.expanded.has(path)) this.expanded.delete(path)
    else this.expanded.add(path)
  }

  collapseAll(): void {
    this.expanded.clear()
  }

  /**
   * Drop cached listings so the next `snapshot()` re-reads the disk.
   *
   * Called after a git refresh: a directory that just gained a file must show
   * it, and there is no filesystem watcher here to notice on its own.
   */
  refresh(): void {
    this.cache.clear()
    this.broken.clear()
  }

  /**
   * The rows to draw, with git badges when a status list is supplied.
   *
   * `repoRoot` matters when the tree is showing a SUBDIRECTORY of the repo —
   * git reports paths relative to the repo root, so they have to be re-based
   * before a lookup, or every file looks clean.
   */
  snapshot(git?: { entries: readonly GitStatusEntry[]; repoRoot?: string }): TreeSnapshot {
    if (!this.rootDir) {
      return { root: '', rows: [], truncated: false, errors: [] }
    }
    const index = git?.entries?.length ? indexGitStatus(git.entries) : null
    const base = git?.repoRoot || this.rootDir
    const { rows, truncated } = buildTreeRows({
      root: this.rootDir,
      readDir: (dir) => this.readDir(dir),
      expanded: this.expanded,
      ...(index
        ? {
            statusFor: (absPath: string): GitStatusEntry | undefined =>
              gitStatusFor(index, relativeTo(base, absPath)),
          }
        : {}),
    })
    return {
      root: this.rootDir,
      rows,
      truncated,
      errors: [...this.broken].map(([path, message]) => ({ path, message })),
    }
  }

  /** Cached listing for one directory, reading it on first use. */
  private readDir(dir: string): DirEntry[] {
    const cached = this.cache.get(dir)
    if (cached) return cached
    let entries: DirEntry[]
    try {
      entries = this.readDirFn(dir)
    } catch (err) {
      // A directory we cannot read (permissions, gone mid-walk) must not take
      // down the whole tree — record it and show the level as empty.
      this.broken.set(dir, (err as Error).message || String(err))
      entries = []
    }
    this.cache.set(dir, entries)
    return entries
  }
}

/** Real directory read. Hidden names are dropped; symlinks are not followed. */
export function defaultReadDir(dir: string): DirEntry[] {
  const out: DirEntry[] = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (isIgnoredName(d.name)) continue
    const isDir = d.isDirectory()
    out.push({ name: d.name, path: join(dir, d.name), isDir, expandable: isDir })
  }
  return out
}
