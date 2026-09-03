/**
 * sidebar-preload.ts — bridge for the left file/git sidebar.
 *
 * Its own file rather than an extension of panel-preload.ts: that file's
 * exposed object is brace-matched by test/panel-api.contract.cjs, so every
 * sidebar method added there would have to satisfy the panel's contract too.
 * Separate file, separate contract — but the SAME rules:
 *
 *   - channels are namespaced `sidebar:*` so they can never collide;
 *   - the bridge is an inline object literal with keys at 2-space indent,
 *     because test/panel-api.contract.cjs parses that exact shape;
 *   - window-manager.ts sets `sandbox: false` for this view (see the long
 *     comment in panel-preload.ts) so any future local require keeps working.
 *
 * Nothing here is trusted input: every string crossing this boundary started
 * in a renderer and is re-validated in ipc-registry.ts.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
// Zero runtime imports (see highlight.ts) — the diff viewer colours its own
// hunks locally instead of round-tripping every line through IPC.
import { highlightCode, languageForPath } from './highlight.js'

/** Remove a listener previously added by one of the `on*` helpers. */
function off(channel: string, cb: (...args: unknown[]) => void): void {
  ipcRenderer.removeListener(channel, cb as never)
}

contextBridge.exposeInMainWorld('dshSidebar', {
  /**
   * Fires when the sidebar's own state changed (a git refresh landed, a folder
   * was opened, the root moved). Carries no payload — the page re-reads
   * `snapshot()` on its own schedule, which keeps ONE throttle instead of one
   * per event source.
   */
  onUpdate: (cb: () => void): void => {
    ipcRenderer.on('sidebar:update', () => cb())
  },
  offUpdate: (cb: (...args: unknown[]) => void): void => off('sidebar:update', cb),

  /** Everything the page needs, in one call. */
  snapshot: (): Promise<{
    root: string
    rows: {
      name: string
      path: string
      depth: number
      isDir: boolean
      expandable: boolean
      expanded: boolean
      badge: string
      status: string
    }[]
    truncated: boolean
    errors: { path: string; message: string }[]
    git: {
      isRepo: boolean
      branch: string
      root: string
      summary: { total: number; staged: number; unstaged: number; untracked: number; conflicted: number }
      writeLocked: boolean
      files: { code: string; path: string; staged: boolean; unstaged: boolean; untracked: boolean; conflicted: boolean; label?: string }[]
      error?: string
    }
    suggestions: string[]
  }> => ipcRenderer.invoke('sidebar:snapshot'),

  /** Point the sidebar at a directory. */
  setRoot: (dir: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:set-root', dir),

  /**
   * Session navigator rows: main sessions with log-backed titles, newest
   * first. cwd rides along so a click can re-root the file tree.
   */
  sessions: (): Promise<{
    sessionId: string
    cwd?: string
    running: boolean
    updatedAt: number
    title?: string
  }[]> => ipcRenderer.invoke('sidebar:sessions'),

  /**
   * Narrow the bottom log bar to one session's agent activity (double-click
   * in the navigator). Returns the title the filter is shown under, or
   * `{ok:false, error}` when the session is already gone.
   */
  focusSession: (sessionId: string): Promise<{ ok: boolean; title?: string; error?: string }> =>
    ipcRenderer.invoke('sidebar:focus-session', sessionId),

  /** Native directory picker. Returns '' when cancelled. */
  pickDir: (): Promise<string> => ipcRenderer.invoke('sidebar:pick-dir'),

  toggleDir: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:toggle-dir', path),
  collapseAll: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:collapse-all'),
  refresh: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:refresh'),

  /** Unified diff for one file. */
  diff: (path: string): Promise<{ ok: boolean; text: string; truncated: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:diff', path),

  /** Open a file in the configured external editor. */
  openFile: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:open', path),

  /** Show a path in the OS file manager. */
  revealPath: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:reveal', path),

  /**
   * Copy a path to the clipboard.
   *
   * Done in the main process because the page runs under
   * `default-src 'none'`, which blocks the async Clipboard API as well.
   */
  copyPath: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:copy', path),

  /** Resize the sidebar (dragged from its right edge in sidebar.html). */
  setWidth: (w: number): Promise<void> => ipcRenderer.invoke('sidebar:set-width', w),

  /**
   * Insert `@<path>` into dsh's chat input so the file becomes a reference in
   * the next user message. Best-effort: returns `{ok:false, error}` rather
   * than throwing when dsh's textarea is not found or the main window is
   * gone, so the sidebar can show a toast and the user can fall back to
   * dragging the file in.
   *
   * The IPC handler validates the path against the sidebar's current root
   * before any renderer-side string is built, so a stale view cannot smuggle
   * a foreign path into the chat.
   */
  addToChat: (path: string): Promise<{ ok: boolean; error?: string; target?: string; inserted?: string }> =>
    ipcRenderer.invoke('sidebar:add-to-chat', path),

  /** Current sidebar geometry, so the page can restore its own splitter. */
  getPrefs: (): Promise<{ sidebarWidth: number; sidebarVisible: boolean }> =>
    ipcRenderer.invoke('sidebar:get-prefs'),

  // ── git write operations (guarded in git-service.ts) ──
  //
  // The three §3.8 guards (managed directory, index.lock, message sanity)
  // live in the MAIN process — the renderer cannot bypass them, which is the
  // point of putting them there. The page only forwards user intent.

  /** Stage current worktree content for the given paths. */
  stageFiles: (paths: string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:stage', paths),

  /** Unstage (index → HEAD) for the given paths. */
  unstageFiles: (paths: string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:unstage', paths),

  /** Commit whatever is staged, with the given message. */
  commit: (message: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:commit', message),

  // ── destructive git operations (double-confirm lives in the page) ──

  /** Local branches, current one first and marked. */
  branches: (): Promise<{ ok: boolean; branches?: { name: string; current: boolean }[]; error?: string }> =>
    ipcRenderer.invoke('sidebar:branches'),

  /** Switch to a local branch. */
  checkoutBranch: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:checkout', name),

  /**
   * Discard ONE file's unstaged changes. The caller supplies the status
   * flags it already rendered; the main process re-checks them against git's
   * own view before touching anything.
   */
  discardFile: (
    path: string,
    status: { staged: boolean; unstaged: boolean; untracked: boolean },
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sidebar:discard', path, status),

  /** True when this page is running inside Electron with the bridge installed. */
  ready: (): boolean => true,

  // ── helpers ──

  /**
   * Syntax-highlight a code fragment for `filePath` (see panel-preload.ts).
   *
   * The diff viewer shows a UNIFIED diff, so this is not line-perfect — but the
   * per-line `+`/`-`/space prefix is one character and every family's plain-text
   * fallback path swallows it harmlessly, which is far better than a wall of
   * monochrome green and red.
   */
  highlight: (code: string, filePath: string): string =>
    highlightCode(code, languageForPath(filePath)),
})

// Same readiness ping as panel-preload.ts — see the comment there for why it
// sits after exposeInMainWorld and why it is wrapped in try/catch.
try {
  const view = new URLSearchParams(location.search).get('view') || 'sidebar'
  ipcRenderer.send('sidebar:view-ready', view)
} catch {
  /* the diagnostics report will show this view as never-ready */
}
