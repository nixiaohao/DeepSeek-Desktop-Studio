/**
 * fs-tree.ts — pure logic for the file-tree / git sidebar.
 *
 * ZERO runtime imports on purpose (not even node:path). Every function here is
 * a decision or a parse, so it can be unit-tested in plain node without
 * stubbing Electron or touching the disk. Path *I/O* lives in git-service.ts;
 * path *safety* lives here as string comparison.
 *
 * Because there is no node:path, every path argument is compared after
 * normalising backslashes to forward slashes. Windows and POSIX both work, and
 * a Windows path never accidentally compares equal to a POSIX one here because
 * we only ever compare two paths that came from the same platform.
 */

/** One row of the sidebar's file tree. */
export interface DirEntry {
  /** File or directory name, not the full path. */
  name: string
  /** Absolute path, using the platform's separators. */
  path: string
  isDir: boolean
  /**
   * True when the directory has children we have not read yet — drives whether
   * the row renders a disclosure triangle. Always false for files.
   */
  expandable: boolean
}

/**
 * Names never shown in the tree.
 *
 * `node_modules` is the important one: a pnpm workspace puts tens of thousands
 * of entries under it and reading one directory level can take seconds, which
 * would freeze the panel. `.git` is only noise, and the rest are build output.
 */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv',
  '.DS_Store',
  'Thumbs.db',
])

/** Hide this name from the tree? */
export function isIgnoredName(name: string): boolean {
  if (!name) return true
  // Editor / OS droppings are hidden everywhere, not just at the top level.
  if (name.endsWith('.swp') || name.endsWith('~')) return true
  return IGNORED_NAMES.has(name)
}

/**
 * Sort tree rows: directories first, then files, each group by name.
 *
 * Comparison is case-insensitive with a case-sensitive tiebreak, so
 * `README.md` sorts next to `readme.txt` instead of being exiled after
 * everything lowercase, but two names differing only in case still have a
 * stable order.
 */
export function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const la = a.name.toLowerCase()
    const lb = b.name.toLowerCase()
    if (la !== lb) return la < lb ? -1 : 1
    // Tiebreak so the sort is total: equal-ignoring-case names must not swap
    // between runs (that reads as a flickering tree).
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    return 0
  })
}

/** Normalise separators so paths can be compared as strings. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Is `candidate` inside `root` (or is `root` itself)?
 *
 * This is the traversal guard for every path the renderer can ask for: the
 * sidebar sends us strings over IPC, and a renderer is not a trusted
 * boundary once a future bug lets it send something crafted. Every file read
 * and every `git` invocation must pass through this first.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  if (!root || !candidate) return false
  const r = norm(root)
  const c = norm(candidate)
  if (c === r) return true
  return c.startsWith(r + '/')
}

// ── git status parsing ──

/**
 * One line of `git status --porcelain=v1 -z`.
 *
 * The `-z` form is mandatory, not a preference: without it git quotes any path
 * containing a space, a quote or a non-ASCII character (as `"a\303\251.txt"`),
 * which silently breaks every path with a Chinese filename. We deal in NUL
 * bytes instead, which cannot appear in a path.
 */
export interface GitStatusEntry {
  /** The raw two-character XY code, e.g. `' M'`, `'A '`, `'??'`, `'UU'`. */
  code: string
  /** Repo-relative path; for a rename this is the destination. */
  path: string
  /** Rename/copy source, only present for R/C codes. */
  from?: string
  /** X (index) column says something is staged. */
  staged: boolean
  /** Y (worktree) column says something is modified. */
  unstaged: boolean
  untracked: boolean
  /** Unmerged — a conflict the user has to resolve before anything else. */
  conflicted: boolean
}

/**
 * Parse the NUL-separated porcelain output.
 *
 * Records are either `XY path\0` or, for renames/copies, `XY from\0to\0`. The
 * `-z` form has no NUL terminator on the last record, so a trailing empty
 * segment is normal and must be skipped — treating it as a file would put a
 * phantom `''` row in the tree.
 */
export function parsePorcelainZ(raw: string): GitStatusEntry[] {
  if (!raw) return []
  const parts = raw.split('\0')
  const out: GitStatusEntry[] = []
  let i = 0
  while (i < parts.length) {
    const record = parts[i]
    i++
    // Trailing separator after the final record.
    if (record === '') continue
    // A record is "XY path"; XY is exactly two chars and the third is a space.
    if (record.length < 4 || record[2] !== ' ') continue
    const code = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) continue

    // Rename / copy records carry a SECOND NUL-separated path. git writes them
    // as `XY <source>\0<destination>\0`, so the displayed path is the second
    // one and the first becomes `from`.
    const renamed = code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C'
    if (renamed) {
      const dest = parts[i]
      i++
      if (dest !== undefined && dest !== '') {
        out.push(makeEntry(code, dest, path))
        continue
      }
      // Malformed: the second path is missing. Fall through and show the
      // source rather than dropping the row entirely.
    }
    out.push(makeEntry(code, path))
  }
  return out
}

function makeEntry(code: string, path: string, from?: string): GitStatusEntry {
  const x = code[0]
  const y = code[1]
  const conflicted = x === 'U' || y === 'U' || code === 'DD' || code === 'AA'
  const untracked = code === '??'
  return {
    code,
    path,
    ...(from ? { from } : {}),
    // '?' and '!' mean "not in the index at all", so they are never staged.
    staged: !conflicted && x !== ' ' && x !== '?' && x !== '!',
    unstaged: !conflicted && y !== ' ' && y !== '?' && y !== '!',
    untracked,
    conflicted,
  }
}

/** Counts for the sidebar header. */
export interface GitStatusSummary {
  total: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

export function summarizeGitStatus(entries: readonly GitStatusEntry[]): GitStatusSummary {
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0
  for (const e of entries) {
    if (e.conflicted) conflicted++
    else if (e.untracked) untracked++
    else {
      if (e.staged) staged++
      if (e.unstaged) unstaged++
    }
    // A conflicted file is counted ONLY as conflicted: telling the user "1
    // staged, 1 conflicted" for the same file double-counts and reads as a
    // bigger change than it is.
  }
  return { total: entries.length, staged, unstaged, untracked, conflicted }
}

/**
 * Chinese label for one XY code.
 *
 * The status bar shows this next to each file, and anything unrecognised
 * degrades to the raw code rather than an empty string — a visible code is
 * debuggable, a blank cell is not.
 */
export function gitStatusLabel(code: string): string {
  const x = code[0]
  const y = code[1]
  if (x === 'U' || y === 'U' || code === 'DD' || code === 'AA') return '冲突'
  if (code === '??') return '未跟踪'
  if (code === '!!') return '已忽略'
  if (x === 'R') return '重命名(已暂存)'
  if (y === 'R') return '重命名'
  if (x === 'C') return '复制(已暂存)'
  if (y === 'C') return '复制'
  if (x === 'A') return y === ' ' ? '新增(已暂存)' : '新增(暂存后又有改动)'
  if (y === 'A') return '新增'
  if (x === 'D' || y === 'D') {
    if (x === 'D' && y === 'D') return '冲突'
    if (x === 'D') return '删除(已暂存)'
    return '已删除'
  }
  if (x === 'M' && y === 'M') return '修改(暂存+未暂存)'
  if (x === 'M') return '修改(已暂存)'
  if (y === 'M') return '已修改'
  return code.trim() === '' ? '无改动' : code
}

/** Short marker for the tree row, so a file's state is visible at a glance. */
export function gitStatusBadge(entry: GitStatusEntry): string {
  if (entry.conflicted) return '!'
  if (entry.untracked) return '?'
  if (entry.staged && entry.unstaged) return 'M'
  if (entry.staged) return '●'
  if (entry.unstaged) return 'M'
  return ''
}

/**
 * Fold a flat status list into a lookup keyed by repo-relative path.
 *
 * The tree renders one row per directory entry, so it needs O(1) "is this file
 * dirty" while walking. Keys are normalised to forward slashes because git
 * always reports forward slashes even on Windows, while our own paths use
 * backslashes.
 */
export function indexGitStatus(entries: readonly GitStatusEntry[]): Map<string, GitStatusEntry> {
  const map = new Map<string, GitStatusEntry>()
  for (const e of entries) map.set(e.path.replace(/\\/g, '/'), e)
  return map
}

/**
 * Look a path up in an index built by `indexGitStatus`.
 *
 * Keys are stored with forward slashes because git always reports them that
 * way, but the file tree walks directories with the PLATFORM separator
 * (backslash on Windows). Without normalising the query every Windows file
 * would look clean, which is the kind of bug that survives review — the panel
 * renders, the numbers are just wrong.
 */
export function gitStatusFor(
  index: ReadonlyMap<string, GitStatusEntry>,
  path: string
): GitStatusEntry | undefined {
  return index.get(path.replace(/\\/g, '/'))
}

/**
 * First line of `git rev-parse --abbrev-ref HEAD`, or '' when detached/absent.
 * `HEAD` on its own line means a detached checkout, which is not a branch name.
 */
export function parseBranch(raw: string): string {
  const line = (raw ?? '').split('\n')[0].trim()
  return line === '' || line === 'HEAD' ? '' : line
}

// ── tree flattening ──

/** One rendered row of the file tree, already flattened and depth-tagged. */
export interface TreeRow {
  name: string
  path: string
  isDir: boolean
  depth: number
  /** Whether the row shows a disclosure triangle. */
  expandable: boolean
  /**
   * Whether an expandable row is currently open.
   *
   * The renderer could derive this from the next row's depth, but that breaks
   * on the last row and on an empty directory — and getting a triangle pointing
   * the wrong way is exactly the kind of tiny wrongness that makes a file tree
   * feel broken.
   */
  expanded: boolean
  /** Short git marker ('' when clean) — see gitStatusBadge. */
  badge: string
  /** Chinese git status label ('' when clean). */
  status: string
}

/**
 * Hard cap on rows returned to the renderer.
 *
 * A monorepo or a directory with a forgotten `node_modules` exclusion is
 * thousands of rows per level; without a cap the IPC payload alone would stall
 * the panel. Reaching the cap is reported so the UI can say so.
 */
export const MAX_TREE_ROWS = 2000
/** Depth cap. Bounds the walk even if the filesystem has a symlink cycle. */
export const MAX_TREE_DEPTH = 12

export interface BuildTreeOptions {
  /** Directory whose CHILDREN become the top-level rows. */
  root: string
  /** Read one directory level. Supplied by the caller so this stays pure. */
  readDir: (dir: string) => DirEntry[]
  /** Absolute paths whose children should be included. */
  expanded: ReadonlySet<string>
  /** Git status lookup by absolute path; omit when the dir is not a repo. */
  statusFor?: (absPath: string) => GitStatusEntry | undefined
  maxRows?: number
  maxDepth?: number
}

export interface TreeResult {
  rows: TreeRow[]
  /** True when maxRows stopped the walk — the tree shown is incomplete. */
  truncated: boolean
}

/**
 * Make `path` relative to `root`, or return it unchanged when it is not
 * underneath `root`.
 *
 * Needed because git reports status paths relative to the REPO root (which can
 * sit above the directory the tree is showing), while the tree works in
 * absolute paths. Without this every file would look clean whenever the repo
 * root is not exactly the tree root.
 */
export function relativeTo(root: string, path: string): string {
  if (!root || !path) return path
  const r = norm(root)
  const p = norm(path)
  if (p === r) return ''
  if (!p.startsWith(r + '/')) return path
  return p.slice(r.length + 1)
}

/**
 * Flatten the visible tree into rows, honouring the expanded set.
 *
 * The renderer gets a flat list and draws it; all the tree shape decisions
 * live here where they can be tested. Recursion is bounded by maxDepth, and
 * the row count by maxRows, so a pathological directory cannot hang the app.
 */
export function buildTreeRows(opts: BuildTreeOptions): TreeResult {
  const maxRows = opts.maxRows ?? MAX_TREE_ROWS
  const maxDepth = opts.maxDepth ?? MAX_TREE_DEPTH
  const rows: TreeRow[] = []
  let truncated = false

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    if (rows.length >= maxRows) {
      truncated = true
      return
    }
    for (const e of sortEntries(opts.readDir(dir))) {
      if (rows.length >= maxRows) {
        truncated = true
        return
      }
      const entry = opts.statusFor?.(e.path)
      rows.push({
        name: e.name,
        path: e.path,
        isDir: e.isDir,
        depth,
        // Every directory gets a triangle. Deciding properly would mean
        // reading one level deeper for every row, and an empty directory with a
        // triangle is a far cheaper mistake than an eager recursive read.
        expandable: e.isDir,
        expanded: e.isDir && opts.expanded.has(e.path),
        badge: entry ? gitStatusBadge(entry) : '',
        status: entry ? gitStatusLabel(entry.code) : '',
      })
      if (e.isDir && opts.expanded.has(e.path)) walk(e.path, depth + 1)
    }
  }

  walk(opts.root, 0)
  return { rows, truncated }
}
