/**
 * sidebar-service.ts — the coordinator behind the file-tree / git sidebar.
 *
 * FileTree knows about directories, GitService knows about git, and this is
 * the only place that knows about BOTH: it keeps the git status that badges the
 * tree rows, decides when to refresh, and hands the renderer one snapshot.
 *
 * No Electron import, same as the modules it sits on, so the refresh and
 * throttling behaviour is unit-testable.
 */
import { FileTree } from './file-tree.js'
import { GitService, type GitDiffResult, type GitSnapshot, type GitWriteResult } from './git-service.js'
import type { GitStatusEntry, GitStatusSummary, TreeRow } from './fs-tree.js'

/**
 * Minimum gap between two git refreshes.
 *
 * `git status` on a large repo is not free, and the mux stream can fire many
 * times a second while an agent is working. Without a floor we would run status
 * on every frame.
 */
export const GIT_REFRESH_MIN_INTERVAL_MS = 3_000

/** How many changed files the sidebar lists before it says "and N more". */
export const CHANGED_FILES_LIMIT = 200

export interface SidebarGitState {
  isRepo: boolean
  branch: string
  /** Repo root, which may be above the tree root. */
  root: string
  summary: GitStatusSummary
  /** The directory is managed by the auto-updater: the shell will not write. */
  writeLocked: boolean
  /** Changed files, newest information first; capped at CHANGED_FILES_LIMIT. */
  files: GitStatusEntry[]
  /** Present only when something went wrong. */
  error?: string
}

export interface SidebarSnapshot {
  /** The directory whose children are the top-level rows. */
  root: string
  rows: TreeRow[]
  /** True when the row cap cut the walk short. */
  truncated: boolean
  /** Directories that could not be read. */
  errors: { path: string; message: string }[]
  git: SidebarGitState
  /**
   * Other directories worth offering — the session working directories dsh
   * reported. Empty when the stream is not up.
   */
  suggestions: string[]
}

const EMPTY_GIT: SidebarGitState = {
  isRepo: false,
  branch: '',
  root: '',
  summary: { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  writeLocked: false,
  files: [],
}

export interface SidebarServiceOptions {
  tree: FileTree
  git: GitService
  /** Candidate roots (dsh session cwds). Read fresh on every snapshot. */
  getSuggestions?: () => string[]
  /** Called after any state change so the IPC layer can push an update. */
  onChange?: () => void
}

export class SidebarService {
  private readonly tree: FileTree
  private readonly git: GitService
  private readonly getSuggestions: () => string[]
  private readonly onChange: () => void
  private gitState: SidebarGitState = EMPTY_GIT
  private lastGitAt = 0
  /** In-flight refresh, so concurrent callers coalesce instead of racing. */
  private refreshing: Promise<void> | null = null
  /** Which directory the in-flight refresh is reading. */
  private refreshingFor: string | null = null

  constructor(opts: SidebarServiceOptions) {
    this.tree = opts.tree
    this.git = opts.git
    this.getSuggestions = opts.getSuggestions ?? (() => [])
    this.onChange = opts.onChange ?? (() => {})
  }

  get root(): string {
    return this.tree.root
  }

  get gitInfo(): SidebarGitState {
    return this.gitState
  }

  /**
   * Point the sidebar at a directory.
   *
   * Expansion state is intentionally dropped (FileTree does that) and git is
   * re-read: the badges from the old directory are meaningless here.
   */
  async setRoot(dir: string): Promise<void> {
    if (!dir || dir === this.tree.root) return
    this.tree.setRoot(dir)
    this.gitState = EMPTY_GIT
    this.lastGitAt = 0
    // Announced by the refresh itself, which always runs with force=true.
    await this.refreshGit(true)
  }

  /** Open or close one folder. Cheap: no I/O beyond a possible directory read. */
  toggleDir(path: string): void {
    this.tree.toggle(path)
    this.onChange()
  }

  collapseAll(): void {
    this.tree.collapseAll()
    this.onChange()
  }

  /**
   * Re-read git status, subject to a minimum interval.
   *
   * @returns whether a refresh actually ran, so callers can tell "already
   * fresh" from "done".
   */
  async refreshGit(force = false): Promise<boolean> {
    if (!this.tree.root) return false
    const now = Date.now()
    if (!force && now - this.lastGitAt < GIT_REFRESH_MIN_INTERVAL_MS) return false

    // Coalesce concurrent callers. Two refreshes in flight would both write
    // gitState and the slower one could land last, leaving the panel showing
    // stale data that looks current.
    //
    // But ONLY for the same directory. A read started before the user switched
    // directories belongs to the previous one: coalescing onto it would show
    // its branch and status against the new tree for as long as the throttle
    // holds, which is wrong in a way that looks plausible.
    if (this.refreshing) {
      const sameDir = this.refreshingFor === this.tree.root
      await this.refreshing
      if (sameDir) return false
      // Different directory: that read is done and irrelevant, so fall through
      // and read ours.
    }

    this.refreshingFor = this.tree.root
    this.refreshing = this.doRefreshGit()
    try {
      await this.refreshing
    } finally {
      this.refreshing = null
      this.refreshingFor = null
      // Stamped even on failure: a broken git must not be re-spawned on every
      // mux frame.
      this.lastGitAt = Date.now()
    }
    return true
  }

  private async doRefreshGit(): Promise<void> {
    try {
      const snap: GitSnapshot = await this.git.snapshot(this.tree.root)
      this.gitState = {
        isRepo: snap.isRepo,
        branch: snap.branch,
        root: snap.root,
        summary: snap.summary,
        writeLocked: snap.writeLocked,
        // The tree badges rows by walking the whole tree, so it needs every
        // entry; only the list RENDERED in the git section is capped.
        files: snap.entries.slice(0, CHANGED_FILES_LIMIT),
        ...(snap.error ? { error: snap.error } : {}),
      }
      // The directory listing is cached, so a file the agent just created
      // would stay invisible. Drop the cache and let the next snapshot()
      // re-read.
      this.tree.refresh()
    } catch (err) {
      // GitService is documented never to reject, but it is INJECTED, and a
      // throw here would propagate out of setRoot() into an IPC handler and
      // reach the renderer as "Error invoking remote method". Drop everything
      // we thought we knew and say why instead.
      this.gitState = {
        ...EMPTY_GIT,
        error: `读取 git 状态失败：${(err as Error).message || String(err)}`,
      }
    }
    // Refreshes are driven from the mux stream, i.e. in the background with
    // nobody holding the return value. If the state change were not announced
    // here the panel would sit on stale git data until the user clicked
    // something. Both paths announce — an error is a state change too.
    this.onChange()
  }

  /** Refresh git and the tree together. */
  async refreshAll(force = false): Promise<void> {
    const ran = await this.refreshGit(force)
    if (ran) return // doRefreshGit already announced.
    // Git was fresh, but that says nothing about the disk.
    this.tree.refresh()
    this.onChange()
  }

  /** Everything the renderer needs, in one call. */
  snapshot(): SidebarSnapshot {
    const { rows, truncated, errors } = this.tree.snapshot({
      entries: this.gitState.files,
      repoRoot: this.gitState.root || this.tree.root,
    })
    const suggestions = this.getSuggestions().filter((d) => d && d !== this.tree.root)
    return {
      root: this.tree.root,
      rows,
      truncated,
      errors,
      git: this.gitState,
      suggestions,
    }
  }

  /** Unified diff for one file in the current tree. */
  async diff(path: string): Promise<GitDiffResult> {
    if (!this.tree.root) {
      return { ok: false, text: '', truncated: false, error: '尚未选择目录' }
    }
    return this.git.diffText(this.tree.root, path)
  }

  // ── git write operations ──
  //
  // Thin forwarders to GitService, which owns every §3.8 guard. The value
  // added here is the AFTERMATH: a successful write invalidates the cached
  // status (the whole point of the write was to change it) and forces an
  // immediate refresh + announcement, so the panel reflects reality instead
  // of waiting out the 3s refresh floor.

  /** Stage current worktree content for the given paths. */
  async stage(files: readonly string[]): Promise<GitWriteResult> {
    return this.write(() => this.git.stage(this.tree.root, files))
  }

  /** Unstage (index → HEAD) for the given paths. */
  async unstage(files: readonly string[]): Promise<GitWriteResult> {
    return this.write(() => this.git.unstage(this.tree.root, files))
  }

  /** Commit whatever is staged. Hooks run normally — never skipped. */
  async commit(message: string): Promise<GitWriteResult> {
    return this.write(() => this.git.commit(this.tree.root, message))
  }

  // ── destructive git operations ──
  //
  // Same forwarder shape as the writes above (the page's double-confirm is
  // the §3.8 human gate; these invalidate the cache afterwards so the panel
  // cannot show a tree that no longer exists).

  /** Local branches of the current root, current one marked. */
  async branches(): Promise<
    { ok: boolean; branches?: { name: string; current: boolean }[]; error?: string }
  > {
    if (!this.tree.root) return { ok: false, error: '尚未选择目录' }
    return this.git.listBranches(this.tree.root)
  }

  /** Switch the current root's repo to a local branch. */
  async checkoutBranch(name: string): Promise<GitWriteResult> {
    return this.write(() => this.git.checkoutBranch(this.tree.root, name))
  }

  /** Discard ONE file's unstaged changes (worktree → index). */
  async discardFile(
    path: string,
    status: { staged: boolean; unstaged: boolean; untracked: boolean },
  ): Promise<GitWriteResult> {
    return this.write(() => this.git.discardFile(this.tree.root, path, status))
  }

  private async write(run: () => Promise<GitWriteResult>): Promise<GitWriteResult> {
    if (!this.tree.root) return { ok: false, error: '尚未选择目录' }
    const r = await run()
    // Announce even on failure: the error text rides the snapshot's git
    // error field only for reads, so the page's own result handling shows
    // write failures — but the forced refresh must happen regardless.
    this.lastGitAt = 0
    await this.refreshGit(true)
    return r
  }
}
