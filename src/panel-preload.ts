/**
 * panel-preload.ts — bridge for the overlay panel and status bar.
 *
 * Separate from src/preload.ts on purpose: the main preload is exposed to the
 * dsh web page (a third-party asset we do not control), so it must stay
 * minimal. This one serves our own assets/panel.html and assets/statusbar.html
 * and can offer the richer API the panels need.
 *
 * Channels are namespaced `panel:*` so they can never collide with the main
 * preload's channels.
 *
 * LOADER DIAGNOSTICS
 * ------------------
 * Every overlay in window-manager.ts sets `sandbox: false`, so the static
 * requires below resolve normally inside `app.asar`. (Electron 22+ defaults
 * `webPreferences.sandbox` to true, and a sandboxed preload may only require
 * 'electron'/'events' — the requires here would throw before
 * `contextBridge.exposeInMainWorld` runs, leaving `window.dshPanel` undefined
 * and the panel stuck on "preload 未加载". This cost a debugging round-trip on
 * 2026-09-01; do not remove the `sandbox: false`.)
 *
 * If a top-level require ever fails again, NOTHING in this file can report it —
 * the reporting code is in the file that failed. That is why the diagnostic
 * lives on the main-process side: window-manager.ts listens for `preload-error`
 * / `render-process-gone` and writes the real reason to
 * %APPDATA%\deepseek-studio\logs\launcher.log, and panel.html points the user
 * at that log.
 *
 * NOTE: the bridge object is the inline literal `contextBridge.exposeInMainWorld(
 * 'dshPanel', { ... })` with keys at 2-space indent.
 * test/panel-api.contract.cjs parses this exact form via brace matching; do not
 * refactor it to a separate `const api = { ... }` without updating the test in
 * lock-step. (Doing so once turned 20 assertions red.)
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
// Pure logic (no Electron dependency) — safe to expose to the panel page so it
// can turn printed paths into clickable links without re-implementing the
// matcher in HTML.
import { findPaths } from './path-links.js'
// PHASE_LABEL is plain data and health-monitor.ts carries no runtime imports
// (its only import is `import type`), so this costs nothing at load time.
import { PHASE_LABEL, type HealthPhase } from './health-monitor.js'
// Zero runtime imports, like path-links — so the page can colour a code preview
// without shipping a grammar to the renderer or paying an IPC round-trip per
// card. Runs in the isolated world with node access (see `sandbox: false`).
import { highlightCode, languageForPath } from './highlight.js'

/** Remove a listener previously added by one of the `on*` helpers. */
function off(channel: string, cb: (...args: unknown[]) => void): void {
  ipcRenderer.removeListener(channel, cb as never)
}

contextBridge.exposeInMainWorld('dshPanel', {
  // ── backend output feed ──

  /** Live backend line. */
  onBackendLine: (cb: (line: { ts: number; stream: 'out' | 'err'; text: string }) => void): void => {
    ipcRenderer.on('panel:backend-line', (_e: IpcRendererEvent, line) => cb(line))
  },
  offBackendLine: (cb: (...args: unknown[]) => void): void => off('panel:backend-line', cb),

  /** Buffered history, oldest first. */
  getBackendHistory: (limit?: number): Promise<unknown[]> =>
    ipcRenderer.invoke('panel:backend-history', limit),

  // ── health ──

  onHealth: (cb: (snapshot: unknown) => void): void => {
    ipcRenderer.on('panel:health', (_e: IpcRendererEvent, snapshot) => cb(snapshot))
  },
  offHealth: (cb: (...args: unknown[]) => void): void => off('panel:health', cb),
  getHealth: (): Promise<unknown> => ipcRenderer.invoke('panel:health-now'),

  /**
   * Chinese label for a phase id.
   *
   * Resolved locally rather than over IPC: PHASE_LABEL is plain data and
   * health-monitor.ts has no runtime imports, so importing it keeps the status
   * bar from flashing raw phase ids while a round-trip is in flight.
   */
  phaseLabel: (phase: string): string =>
    PHASE_LABEL[phase as HealthPhase] ?? phase,

  /** Version / port / channel for the status bar's right-hand meta area. */
  getStatusInfo: (): Promise<{ version: string; port: number | null; channel: string } | null> =>
    ipcRenderer.invoke('panel:status-info'),

  // ── change review (dsh mux stream) ──

  /**
   * Fires when the change list or the approval inbox changed.
   *
   * Carries no payload: the panel re-reads `getChanges()` on its own schedule,
   * which keeps one throttle instead of one per event source.
   */
  onChangesChanged: (cb: () => void): void => {
    ipcRenderer.on('panel:changes-rev', () => cb())
  },
  offChangesChanged: (cb: (...args: unknown[]) => void): void => off('panel:changes-rev', cb),

  /** Changes, pending approvals and sessions in one call. */
  getChanges: (): Promise<{
    changes: unknown[]
    approvals: unknown[]
    sessions: unknown[]
    connected: boolean
  }> => ipcRenderer.invoke('panel:changes-now'),

  /**
   * Allow or reject one pending approval.
   * `outcome` is deliberately restricted to the two values a client may give;
   * cancelled/unavailable are host-side outcomes.
   */
  respondApproval: (
    approvalId: string,
    outcome: 'allowed-once' | 'rejected'
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('panel:respond', approvalId, outcome),

  // ── actions ──

  /** Restart only the backend process (a fresh token is minted — see main.ts). */
  restartBackend: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('panel:restart-backend'),

  /** Open a file in the configured external editor. */
  openInEditor: (file: string, line?: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('panel:open-in-editor', file, line),

  /** Show the file in the OS file manager. */
  revealPath: (file: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('panel:reveal-path', file),

  openLogs: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('panel:open-logs'),

  // ── geometry ──

  setMonitorHeight: (h: number): Promise<void> =>
    ipcRenderer.invoke('panel:set-monitor-height', h),
  setPanelWidth: (w: number): Promise<void> =>
    ipcRenderer.invoke('panel:set-panel-width', w),
  getPrefs: (): Promise<unknown> => ipcRenderer.invoke('panel:get-prefs'),

  // ── helpers ──

  /** Heuristic file-path detection, for clickable links in the output. */
  findPaths: (text: string): { text: string; index: number; length: number }[] =>
    findPaths(text),

  /**
   * Syntax-highlight a code preview for `filePath`, as an HTML fragment.
   *
   * Takes the PATH rather than a language id: choosing the language is an
   * implementation detail the page has no business knowing, and the path is
   * what a FileDiff actually carries.
   *
   * Returns escaped HTML — every token is escaped as it is emitted, so the
   * result is safe to assign to innerHTML even though the source is arbitrary
   * agent output. It emits `class="tok-*"` rather than inline styles, because
   * the pages run under a CSP that only permits their own <style> block.
   */
  highlight: (code: string, filePath: string): string =>
    highlightCode(code, languageForPath(filePath)),
})
