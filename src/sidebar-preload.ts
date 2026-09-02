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

  /** Current sidebar geometry, so the page can restore its own splitter. */
  getPrefs: (): Promise<{ sidebarWidth: number; sidebarVisible: boolean }> =>
    ipcRenderer.invoke('sidebar:get-prefs'),

  /** True when this page is running inside Electron with the bridge installed. */
  ready: (): boolean => true,
})
