/**
 * ipc-registry.ts — single place where every IPC channel is registered.
 *
 * Replaces the inline `setupIPC()` that used to live in main.ts, which had
 * grown to the point where adding one panel action meant editing a 700-line
 * file. Everything is registered here and teardown is centralised: the
 * returned function unsubscribes the backend feed, which otherwise keeps a
 * closure alive for the lifetime of the process.
 *
 * Channel names:
 *   - legacy: `switch-theme`, `get-themes`, `get-version`, `window-*`
 *   - panel:  `panel:*` (namespaced so they cannot collide with the above)
 */
import { ipcMain, shell, BrowserWindow } from 'electron'
import { subscribeBackend, getBackendLines, getLogDir } from './logging.js'
import type { BackendLine } from './logging.js'
import { loadCurrentThemeCSS, listThemes } from './theme.js'
import { savePreferences, loadPanelPrefs, savePanelPrefs, loadExternalEditor } from './preferences.js'
import { openInEditor } from './external-editor.js'
import type { HealthMonitor } from './health-monitor.js'
import type { WindowManager } from './window-manager.js'
import type { DshStream, ApprovalOutcome } from './dsh-stream.js'

export interface IpcDeps {
  getWindowManager: () => WindowManager | null
  getHealthMonitor: () => HealthMonitor | null
  /**
   * The mux stream, or null before the first successful launch. Every channel
   * below degrades to an empty result rather than failing, because `/api/*`
   * carries no version promise upstream.
   */
  getStream: () => DshStream | null
  getAppVersion: () => string
  /**
   * Restart the backend process only. The caller (main.ts) must reload the
   * main window afterwards: a restarted backend mints a NEW per-process token,
   * so the existing session cookie stops working.
   */
  restartBackend: () => Promise<{ ok: boolean; error?: string }>
  /** dsh version / port / channel for the status bar. */
  getStatusInfo: () => { version: string; port: number | null; channel: string }
  quitApp: () => void
}

/** Push a message to both overlay views (panel + status bar). */
function broadcast(wm: WindowManager | null, channel: string, payload: unknown): void {
  if (!wm) return
  try {
    wm.panel?.webContents.send(channel, payload)
  } catch { /* view destroyed mid-send */ }
  try {
    wm.statusBar?.webContents.send(channel, payload)
  } catch { /* view destroyed mid-send */ }
}

/**
 * Register all IPC handlers.
 * @returns a teardown function that must be called before the app quits.
 */
export function registerIpc(deps: IpcDeps): () => void {
  const { getWindowManager, getHealthMonitor } = deps

  // ── Legacy channels (moved verbatim from main.ts) ──

  ipcMain.on('switch-theme', (_event, themeId: string) => {
    savePreferences({ themeId })
    // Prefer the manager's window: matching on title also caught the splash
    // and the market window, which do not have a dsh page to re-theme.
    const win = getWindowManager()?.window ?? null
    if (!win) return
    const css = loadCurrentThemeCSS()
    win.webContents.reload()
    win.webContents.once('did-finish-load', () => {
      if (css) win.webContents.insertCSS(css)
    })
  })

  ipcMain.handle('get-themes', () => listThemes())
  ipcMain.handle('get-version', () => deps.getAppVersion())

  ipcMain.on('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) win.unmaximize()
    else win?.maximize()
  })
  ipcMain.on('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
    deps.quitApp()
  })

  // ── Panel: backend output ──

  ipcMain.handle('panel:backend-history', (_e, limit?: number) =>
    getBackendLines(typeof limit === 'number' && limit > 0 ? limit : 200)
  )

  // ── Panel: health ──

  ipcMain.handle('panel:health-now', () => getHealthMonitor()?.snapshot() ?? null)

  ipcMain.handle('panel:status-info', () => {
    try {
      return deps.getStatusInfo()
    } catch {
      return null
    }
  })

  // ── Panel: change review (dsh mux stream) ──

  ipcMain.handle('panel:changes-now', () => {
    const stream = deps.getStream()
    return stream
      ? stream.panelSnapshot()
      : { changes: [], approvals: [], sessions: [], dropped: 0, connected: false }
  })

  ipcMain.handle('panel:respond', async (_e, approvalId: unknown, outcome: unknown) => {
    if (typeof approvalId !== 'string' || approvalId.length === 0) {
      return { ok: false, error: '缺少 approvalId' }
    }
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      return { ok: false, error: `未知的审批结果：${String(outcome)}` }
    }
    const stream = deps.getStream()
    if (!stream) return { ok: false, error: '变更流尚未连接' }
    try {
      return await stream.respond(approvalId, outcome as ApprovalOutcome)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Panel: actions ──

  ipcMain.handle('panel:restart-backend', () => deps.restartBackend())

  ipcMain.handle('panel:open-in-editor', async (_e, file: string, line?: number) => {
    if (typeof file !== 'string' || file.length === 0) {
      return { ok: false, error: '空路径' }
    }
    try {
      return await openInEditor(loadExternalEditor(), file, line)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('panel:reveal-path', (_e, file: string) => {
    if (typeof file !== 'string' || file.length === 0) {
      return { ok: false, error: '空路径' }
    }
    shell.showItemInFolder(file)
    return { ok: true }
  })

  ipcMain.handle('panel:open-logs', async () => {
    const err = await shell.openPath(getLogDir())
    return err ? { ok: false, error: err } : { ok: true }
  })

  // ── Panel: geometry ──

  ipcMain.handle('panel:set-monitor-height', (_e, h: number) => {
    if (typeof h !== 'number' || !Number.isFinite(h)) return
    savePanelPrefs({ monitorHeight: Math.max(80, Math.round(h)) })
  })

  ipcMain.handle('panel:set-panel-width', (_e, w: number) => {
    if (typeof w !== 'number' || !Number.isFinite(w)) return
    getWindowManager()?.setPanelWidth(w)
  })

  ipcMain.handle('panel:get-prefs', () => {
    const wm = getWindowManager()
    return wm ? wm.panelPrefs : loadPanelPrefs()
  })

  // ── Live feeds ──

  // ONE subscription feeds both consumers. The health monitor deliberately
  // takes its input here rather than subscribing from main.ts: two independent
  // subscriptions would make the order in which panels and health see a line
  // depend on registration order.
  const unsubBackend = subscribeBackend((line: BackendLine) => {
    broadcast(getWindowManager(), 'panel:backend-line', line)
    getHealthMonitor()?.feedLine(line)
  })

  // Change review is push-notified but pull-loaded. A payload-less revision
  // bump keeps the broadcast cheap (diffs carry whole file contents, and a
  // chatty agent would otherwise ship megabytes per second over IPC), while the
  // panel's own 100ms batching stays the single throttle point.
  let revision = 0
  const stream = deps.getStream()
  stream?.setOnChange(() => {
    revision += 1
    broadcast(getWindowManager(), 'panel:changes-rev', revision)
  })

  // Health has no feed of its own: the monitor emits on change, and a ticker
  // keeps time-dependent states (idle/degraded) fresh even when output is
  // quiet — otherwise a silent backend would never leave `ready`.
  const monitor = getHealthMonitor()
  const unsubHealth = monitor?.subscribe((snapshot) => {
    broadcast(getWindowManager(), 'panel:health', snapshot)
  })
  const ticker = setInterval(() => {
    const snap = getHealthMonitor()?.snapshot()
    if (snap) broadcast(getWindowManager(), 'panel:health', snap)
  }, 5_000)
  // Do not hold the process open for the ticker.
  ticker.unref?.()

  return () => {
    unsubBackend()
    unsubHealth?.()
    stream?.setOnChange(undefined)
    clearInterval(ticker)
  }
}
