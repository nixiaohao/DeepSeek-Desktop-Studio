/**
 * diagnostics-preload.ts — bridge for the standalone self-check window.
 *
 * STAYS SANDBOXED ON PURPOSE, AND THAT IS THE WHOLE POINT.
 * ---------------------------------------------------------
 * panel-preload.js and sidebar-preload.js both require local modules (path-links,
 * health-monitor, highlight, approval-groups), which forces `sandbox: false` on
 * their views — and a sandboxed preload that requires a project file throws
 * before `contextBridge.exposeInMainWorld` runs, leaving the page dead. That is
 * the exact bug this window exists to report.
 *
 * So this preload requires NOTHING but 'electron'. It therefore runs fine with
 * Electron 22+ default sandboxing, which means a diagnostics window can still
 * open and explain itself when the panel's preload is the thing that is broken.
 * Adding a local require here would silently re-couple the self-check to the
 * category of failure it is meant to survive. Do not.
 *
 * Channels are namespaced `diag:*` for the same reason every other overlay
 * namespaces its own: a shared name is a collision waiting for a refactor.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDiag', {
  /** Full report + log tails, or `{error}` when the host is not ready. */
  report: (): Promise<unknown> => ipcRenderer.invoke('diag:report'),

  /** Open the log folder in the OS file manager. */
  openLogs: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('diag:open-logs'),

  /**
   * Copy the report to the clipboard.
   *
   * Goes through the main process rather than `navigator.clipboard` because a
   * `file://` page has no permission policy that reliably grants clipboard
   * write, and because main applies `redactTokenInText` on the way out — the
   * report embeds raw log lines, and a dsh launch token that reached the
   * clipboard would outlive the process it belonged to.
   */
  copy: (text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('diag:copy', text),
})
