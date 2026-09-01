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
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
// Pure logic (no Electron dependency) — safe to expose to the panel page so it
// can turn printed paths into clickable links without re-implementing the
// matcher in HTML.
import { findPaths } from './path-links.js'
// PHASE_LABEL is plain data and health-monitor.ts carries no runtime imports
// (its only import is `import type`), so this costs nothing at load time.
import { PHASE_LABEL, type HealthPhase } from './health-monitor.js'

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
})
