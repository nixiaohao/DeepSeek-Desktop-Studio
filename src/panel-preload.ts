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
// Zero runtime imports too. Exposed so the page groups approvals with the SAME
// rules the main process enforces — one implementation, and a page bug cannot
// offer an "allow" button spanning two tools.
import { groupApprovals } from './approval-groups.js'
// Zero runtime imports as well. The status bar renders the aggregated agent
// stats through THIS formatter, not its own copy — one implementation, and the
// unit tests pin exactly what the user reads.
import { formatStatsSummary } from './stats-model.js'

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

  /**
   * Allow or reject several approvals at once.
   *
   * `outcome: 'allowed-once'` is only accepted when every id belongs to ONE
   * tool — the main process re-checks this and refuses otherwise, so the page
   * does not have to be trusted with the rule. Rejection is unrestricted.
   *
   * The result reports per-id: `failed` names the ids that did not go through,
   * and `skipped` lists ids the agent had already resolved, which is not an
   * error and must not be shown as one.
   */
  /**
   * Group pending approvals by tool, oldest first (see approval-groups.ts).
   *
   * Resolved locally for the same reason findPaths is: it is pure logic, and
   * the ordering has to match what the main process will accept, so there is
   * exactly one implementation of it.
   */
  groupApprovals: (
    approvals: { approvalId: string; toolName?: string; ts?: number }[]
  ): { toolName: string; approvalIds: string[]; ts: number }[] =>
    groupApprovals(approvals),

  respondMany: (
    approvalIds: string[],
    outcome: 'allowed-once' | 'rejected'
  ): Promise<{
    ok: boolean
    answered: number
    failed: { approvalId: string; error: string }[]
    skipped: string[]
    total: number
    error?: string
  }> => ipcRenderer.invoke('panel:respond-many', approvalIds, outcome),

  // ── agent stats (dsh mux projections, main + subagents) ──

  /** Latest aggregated stats line ('' when there is nothing to show). */
  getStats: (): Promise<string> => ipcRenderer.invoke('panel:stats-now'),

  /** Live stats line; pushed only when it actually changed (see ipc-registry). */
  onStats: (cb: (line: string) => void): void => {
    ipcRenderer.on('panel:stats', (_e: IpcRendererEvent, line) => cb(line))
  },
  offStats: (cb: (...args: unknown[]) => void): void => off('panel:stats', cb),

  /** Format a stats aggregate locally — same implementation the push uses. */
  formatStats: (s: unknown): string => formatStatsSummary(s as never),

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

/**
 * Tell the main process this preload finished and the bridge is live.
 *
 * Placed AFTER `exposeInMainWorld` on purpose, so the ping means "the bridge
 * exists" and not merely "the module started executing". A preload that throws
 * on any require above never reaches this line, and the ABSENCE of the ping is
 * what the diagnostics report turns into a red row naming the real cause.
 *
 * The label is read from the page URL rather than hard-coded: this one file
 * serves both the panel and the status bar, and window-manager keys the report
 * on the same three labels.
 *
 * Wrapped in try/catch because a ping that fails must never take the bridge
 * down with it — the main process already treats a missing ping as "not ready".
 */
try {
  const view = new URLSearchParams(location.search).get('view') || 'panel'
  ipcRenderer.send('panel:view-ready', view)
} catch {
  /* the diagnostics report will show this view as never-ready */
}
