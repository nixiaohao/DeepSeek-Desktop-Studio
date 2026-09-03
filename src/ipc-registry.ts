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
 *   - legacy:   `switch-theme`, `get-themes`, `get-version`, `window-*`
 *   - panel:    `panel:*`   (namespaced so they cannot collide with the above)
 *   - sidebar:  `sidebar:*` (the file/git sidebar; likewise namespaced)
 *   - diag:     `diag:*`    (the standalone diagnostics window)
 *
 * Every channel STRING in the app lives in this file, because that is what
 * test/panel-api.contract.cjs correlates against: a name defined anywhere else
 * is invisible to it, and an unregistered name fails only at runtime, for the
 * user, in a packaged app with no devtools.
 */
import { ipcMain, shell, clipboard, dialog, BrowserWindow, Notification } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { subscribeBackend, getBackendLines, getLogDir, getRecentLines, log, subscribeLog } from './logging.js'
import type { BackendLine } from './logging.js'
import { buildView, entryFromBackend, entryFromAgent, parseShellLine, matchesSession, LOG_SOURCES, LOG_SOURCE_LABELS } from './log-model.js'
import type { LogEntry } from './log-model.js'
import { aggregateOverview, formatStatusLine, estimateCost, pickPrice, parsePriceOverrides, BUILTIN_PRICES, type StatsSessionRow, type OverviewSessionRow, type CostSummary, type StatusBarView } from './stats-model.js'
import { loadPriceOverridesText } from './preferences.js'
import { filterCommands } from './command-model.js'
import { buildCommandList, dispatchCommand, type CommandSource } from './command-registry.js'
import { hideCommandPalette } from './command-palette-window.js'
import { loadCurrentThemeCSS, listThemes } from './theme.js'
import {
  savePreferences,
  loadPreferences,
  loadPanelPrefs,
  savePanelPrefs,
  loadExternalEditor,
  saveExternalEditor,
  prefsPath,
  normalizeUiScale,
  UI_SCALES,
} from './preferences.js'
import { openInEditor, describeEditorConfig, EDITOR_PRESETS } from './external-editor.js'
import { CHANNELS, isChannelId, normalizeChannel } from './channels.js'
import {
  changedFields,
  needsRestart,
  normalizeTextField,
  type SettingsState,
} from './settings-model.js'
import { notifySettingsSaved } from './settings-window.js'
import { relaunchApp } from './relaunch.js'
import { isWithinRoot } from './fs-tree.js'
import { redactTokenInText } from './redact.js'
import { commonTool, normalizeIds } from './approval-groups.js'
import { collectDiagnostics } from './diagnostics-host.js'
import type { DiagnosticsHostDeps } from './diagnostics-host.js'
import { buildChatInsert, buildInsertScript, type ChatInsertResult } from './dsh-input.js'
import { findPaths } from './path-links.js'
import type { HealthMonitor } from './health-monitor.js'
import type { WindowManager } from './window-manager.js'
import type { SidebarService } from './sidebar-service.js'
import type { DshStream, ApprovalOutcome } from './dsh-stream.js'
import type { ActivityEntry, SessionInfo } from './event-store.js'

export interface IpcDeps {
  getWindowManager: () => WindowManager | null
  getHealthMonitor: () => HealthMonitor | null
  /**
   * The mux stream, or null before the first successful launch. Every channel
   * below degrades to an empty result rather than failing, because `/api/*`
   * carries no version promise upstream.
   */
  getStream: () => DshStream | null
  /**
   * The file/git sidebar, or null when it was never created. Optional because
   * registerIpc() must stay callable before the app has a workspace — the
   * smoke test calls it with neither a stream nor a sidebar.
   */
  getSidebar?: () => SidebarService | null
  /**
   * Getters behind the diagnostics self-check, or null before the app has
   * finished booting. main.ts owns every subsystem they touch, so it is the
   * only place that can build this.
   *
   * Optional for the same reason `getSidebar` is: `registerIpc()` has to stay
   * callable before any of those subsystems exist.
   */
  getDiagnosticsHost?: () => DiagnosticsHostDeps | null
  /**
   * Command source for the Ctrl+K palette (menu actions + scale steps), or
   * null before the app has booted. Optional for the same reason
   * `getDiagnosticsHost` is: registerIpc() must stay callable early, and the
   * palette then degrades to an empty list instead of failing.
   */
  getPaletteSource?: () => CommandSource | null
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

/**
 * Late-bound lookup for the WindowManager, so helpers defined OUTSIDE
 * registerIpc (notifyApprovalRequired, pushSidebarUpdate) can still reach it.
 *
 * main.ts is the only place that knows about the manager, so it wires this
 * once on boot. Without it, a notification or a sidebar push that fired before
 * the window existed would throw instead of being silently dropped.
 */
let getWindowManagerCached: (() => WindowManager | null) | null = null
export function setWindowManagerAccessor(fn: () => WindowManager | null): void {
  getWindowManagerCached = fn
}

/**
 * Push a `panel:*` message to the two views that consume it.
 *
 * The sidebar is deliberately NOT in this list, even though it is a sibling
 * overlay: it has its own preload and listens to exactly one channel
 * (`sidebar:update`, via pushSidebarUpdate). Fanning every health tick and
 * every change-review revision out to it would be pure overhead, and would
 * silently couple the sidebar to the panel's payload shapes.
 */
function broadcast(wm: WindowManager | null, channel: string, payload: unknown): void {
  if (!wm) return
  for (const view of [wm.panel, wm.statusBar]) {
    try {
      view?.webContents.send(channel, payload)
    } catch { /* view destroyed mid-send */ }
  }
}

/**
 * The sidebar snapshot handed back when there is no sidebar at all.
 *
 * Returning a well-typed EMPTY state instead of null keeps sidebar.html free of
 * null checks on every field: it renders "未选择目录" and waits, which is also
 * what it should do before the app has picked a workspace.
 */
const EMPTY_SIDEBAR = {
  root: '',
  rows: [] as unknown[],
  truncated: false,
  errors: [] as { path: string; message: string }[],
  git: {
    isRepo: false,
    branch: '',
    root: '',
    summary: { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    writeLocked: false,
    files: [] as unknown[],
  },
  suggestions: [] as string[],
}

/**
 * Tell the sidebar page to re-read its snapshot.
 *
 * Exported rather than defined in main.ts because main.ts constructs the
 * SidebarService (and therefore needs this callback) BEFORE registerIpc()
 * exists, and because keeping the channel string here is what lets the
 * contract test prove the producer and the consumer agree.
 *
 * Resolved through the late-bound accessor, not a captured manager: the
 * sidebar outlives individual windows, and a captured one would be stale
 * after a relaunch.
 */
export function pushSidebarUpdate(): void {
  const view = getWindowManagerCached?.()?.sidebar ?? null
  if (!view) return
  try {
    view.webContents.send('sidebar:update')
  } catch { /* view destroyed mid-send */ }
}

/**
 * The log bar's session filter: set by a double-click in the sidebar's session
 * navigator, cleared from the filter chip inside the log bar itself.
 *
 * MODULE-LEVEL on purpose, even though it is display state: `pushLogbar` is
 * exported and therefore runs outside registerIpc's closure, and the filter
 * has to hold for every live line, not just for snapshots. It is reset at the
 * top of registerIpc so a relaunch never inherits a session id from the
 * previous backend — a stale id would show an empty log bar, which reads
 * exactly like "the app is broken".
 *
 * `title` is captured when the filter is set (the session may well be gone by
 * the time the user clears it) and is what the chip shows.
 */
let logSessionFilter: { sessionId: string; title: string } | null = null

/**
 * Push one structured log entry to the bottom log panel.
 *
 * Mirrors pushSidebarUpdate(): late-bound manager lookup (the logbar outlives
 * individual windows and the feed runs before/after window rebuilds), and a
 * try/catch because the view may be torn down mid-send. The page batches its
 * own rendering through requestAnimationFrame, so per-line sends are fine.
 *
 * Filtering happens HERE rather than in the page so the rule lives in exactly
 * one place (log-model's matchesSession, unit-tested): the page would have to
 * duplicate it, and a duplicate that drifts shows lines from the wrong session
 * with nothing to flag it.
 */
export function pushLogbar(entry: LogEntry): void {
  if (logSessionFilter && !matchesSession(entry, logSessionFilter.sessionId)) return
  const view = getWindowManagerCached?.()?.logBar ?? null
  if (!view) return
  try {
    view.webContents.send('logs:lines', [entry])
  } catch { /* view destroyed mid-send */ }
}

/**
 * Tell the log bar its session filter changed, so it can drop its buffer and
 * re-read the (now filtered) snapshot.
 *
 * Payload-only push, like `sidebar:update`: the page already knows how to
 * fetch, and a filter object small enough to send would still be a second
 * copy of the truth to keep in sync.
 */
function pushSessionFilter(): void {
  const view = getWindowManagerCached?.()?.logBar ?? null
  if (!view) return
  try {
    view.webContents.send('logs:session-filter', logSessionFilter)
  } catch { /* view destroyed mid-send */ }
}

/**
 * Refuse any path from the renderer that is not inside the sidebar's root.
 *
 * The renderer is our own asset and contextIsolation is on, so this is not
 * defending against an attacker — it is defending against a STALE view: the
 * sidebar can hold rows from a directory it is no longer showing, and acting on
 * one of those would open or diff a file the user never pointed at.
 */
function safeSidebarPath(sidebar: SidebarService | null, path: unknown): string {
  if (!sidebar || !sidebar.root) return ''
  if (typeof path !== 'string' || path.length === 0) return ''
  return isWithinRoot(sidebar.root, path) ? path : ''
}

/**
 * Register all IPC handlers.
 * @returns a teardown function that must be called before the app quits.
 */
export function registerIpc(deps: IpcDeps): () => void {
  const { getWindowManager, getHealthMonitor } = deps

  // A fresh registration means a fresh backend — see the note on the
  // declaration: keeping a session id from a previous process would filter
  // the log bar down to a conversation that no longer exists.
  logSessionFilter = null

  // ── Legacy channels (moved verbatim from main.ts) ──

  /**
   * Persist a theme and restyle the dsh page.
   *
   * pageContents, NOT window.webContents: the dsh page lives in its own
   * WebContentsView, and reloading the window's own (empty) webContents would
   * leave the visible page untouched. (An earlier version matched windows by
   * title and re-themed the splash screen too.)
   *
   * Shared by `switch-theme` and the settings window so the two paths cannot
   * drift — a theme that applies from the menu but not from 设置 would be a
   * bug nobody thinks to look for.
   */
  const applyTheme = (themeId: string): void => {
    savePreferences({ themeId })
    const page = getWindowManager()?.pageContents ?? null
    if (!page) return
    const css = loadCurrentThemeCSS()
    page.reload()
    page.once('did-finish-load', () => {
      if (css) page.insertCSS(css)
    })
  }

  ipcMain.on('switch-theme', (_event, themeId: string) => {
    applyTheme(themeId)
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

  // ── Preload readiness (feeds the diagnostics report) ──
  //
  // One listener per namespace because the channel is namespaced, NOT because
  // the two behave differently — panel-preload.js serves both the panel and the
  // status bar and reports which one it is via the label argument.
  //
  // The label is renderer-supplied and therefore untrusted: markViewReady()
  // ignores anything it does not already know about, so a hostile or merely
  // confused page cannot invent a fourth overlay in the report.
  const onViewReady = (_e: unknown, label: unknown): void => {
    if (typeof label !== 'string') return
    getWindowManager()?.markViewReady(label)
  }
  //
  // Literal channel names, NOT a loop over an array of names. The shared body
  // is hoisted instead of repeated. A computed name would be invisible to
  // panel-api.contract.cjs, which scans this file as TEXT for `ipcMain.on('…')`
  // — and an unlistened send is exactly the silent failure this ping exists to
  // prevent, so it must stay greppable.
  ipcMain.on('panel:view-ready', onViewReady)
  ipcMain.on('sidebar:view-ready', onViewReady)
  ipcMain.on('logs:view-ready', onViewReady)

  // ── Panel: backend output ──
  //
  // The panel no longer renders backend output — it lives in the bottom log
  // bar (logs:*), which merges it with shell and agent feeds. The subscribe
  // callback below therefore only feeds the health monitor and the logbar.

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
    const stream = deps.getStream?.() ?? null
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
    const stream = deps.getStream?.() ?? null
    if (!stream) return { ok: false, error: '变更流尚未连接' }
    try {
      return await stream.respond(approvalId, outcome as ApprovalOutcome)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /**
   * Batch answer.
   *
   * The allow restriction is enforced HERE rather than only in the page,
   * because it is a safety rule, not a layout preference: a page bug (or a
   * stale cached page) must not be able to turn one click into blanket consent
   * across every tool at once. `commonTool()` returns null both when the ids
   * span several tools and when any id is no longer pending.
   *
   * Rejection is unrestricted — refusing work cannot cause damage.
   */
  ipcMain.handle('panel:respond-many', async (_e, approvalIds: unknown, outcome: unknown) => {
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      return { ok: false, error: `未知的审批结果：${String(outcome)}` }
    }
    const ids = normalizeIds(approvalIds)
    if (ids.length === 0) {
      return { ok: false, error: '没有选中任何审批' }
    }

    const stream = deps.getStream?.() ?? null
    if (!stream) return { ok: false, error: '变更流尚未连接' }

    if (outcome === 'allowed-once') {
      const tool = commonTool(stream.approvals(), ids)
      if (tool === null) {
        return { ok: false, error: '批量允许只能对同一工具执行（或有审批已失效）' }
      }
    }

    try {
      return await stream.respondMany(ids, outcome as ApprovalOutcome)
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

  ipcMain.handle('panel:set-panel-width', (_e, w: number) => {
    if (typeof w !== 'number' || !Number.isFinite(w)) return
    getWindowManager()?.setPanelWidth(w)
  })

  ipcMain.handle('panel:get-prefs', () => {
    const wm = getWindowManager()
    return wm ? wm.panelPrefs : loadPanelPrefs()
  })

  // ── Diagnostics: standalone self-check window ──

  /**
   * Full self-check report plus the tail of each log file.
   *
   * Returns `{error}` rather than throwing when the host is not wired up yet:
   * the diagnostics window is what the user opens when the app looks broken,
   * and a rejected IPC promise there shows an empty page with no explanation —
   * the one outcome this feature exists to prevent.
   */
  ipcMain.handle('diag:report', () => {
    const host = deps.getDiagnosticsHost?.() ?? null
    if (!host) return { error: '自检数据尚未就绪（应用还在启动）' }
    try {
      return collectDiagnostics(host)
    } catch (err) {
      return { error: (err as Error).message || '收集自检数据失败' }
    }
  })

  ipcMain.handle('diag:open-logs', async () => {
    const err = await shell.openPath(getLogDir())
    return err ? { ok: false, error: err } : { ok: true }
  })

  /**
   * Copy report text to the clipboard, redacted on the way out.
   *
   * The report embeds raw log lines, and the dsh launch token is minted per
   * process. Redacting here rather than in the page means the guarantee cannot
   * be bypassed by a page-side change, and it covers text the user selected out
   * of a log tail as well as the generated report.
   */
  ipcMain.handle('diag:copy', (_e, text: unknown) => {
    if (typeof text !== 'string' || !text) return { ok: false, error: '没有可复制的内容' }
    try {
      clipboard.writeText(redactTokenInText(text))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Sidebar: file tree + git ──

  /**
   * Session ids → the title the session navigator shows, from the 'title'
   * projection. Shared by the navigator itself and by the log bar's filter so
   * the chip names the same session, in the same words, the user just clicked.
   */
  const sessionTitles = (): Map<string, string> => {
    const store = deps.getStream?.()?.store
    if (!store) return new Map()
    const titles = new Map<string, string>()
    for (const p of store.projectionEntries()) {
      if (p.key === 'title' && typeof p.value === 'string' && p.value.length > 0) {
        titles.set(p.sessionId, p.value)
      }
    }
    return titles
  }

  ipcMain.handle('sidebar:snapshot', () => deps.getSidebar?.()?.snapshot() ?? EMPTY_SIDEBAR)

  /**
   * The session navigator's rows: main sessions (subagents excluded — they
   * are the agent's internals, not things a user switches between) with the
   * log-backed title merged in from the 'title' projection. Newest first;
   * the store's own poll keeps running/updatedAt current.
   */
  ipcMain.handle('sidebar:sessions', () => {
    const store = deps.getStream?.()?.store
    if (!store) return []
    const snap = store.snapshot()
    const titles = sessionTitles()
    return snap.sessions
      .filter((s) => !s.parentSessionId)
      .map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        running: s.running,
        updatedAt: s.updatedAt,
        title: titles.get(s.sessionId),
      }))
  })

  /**
   * Point the log bar at ONE session (double-click in the session navigator).
   *
   * The click next to it re-roots the file tree; this one narrows the log bar
   * to that conversation's agent activity — the second half of phase 2, which
   * the first pass left out.
   *
   * The log bar is shown if it was hidden: setting a filter nobody can see
   * looks like nothing happened. `title` is resolved from the same projection
   * the navigator renders, falling back to the raw id for an untitled session.
   */
  ipcMain.handle('sidebar:focus-session', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, error: '空会话 id' }
    }
    const sessions = deps.getStream?.()?.snapshot().sessions ?? []
    if (!sessions.some((s) => s.sessionId === sessionId)) {
      return { ok: false, error: '会话已不存在' }
    }
    const title = sessionTitles().get(sessionId) || sessionId
    logSessionFilter = { sessionId, title }
    pushSessionFilter()
    const wm = getWindowManager()
    if (wm && !wm.panelPrefs.logbarVisible) wm.setLogbarVisible(true)
    return { ok: true, title }
  })

  ipcMain.handle('sidebar:set-root', async (_e, dir: unknown) => {
    const sidebar = deps.getSidebar?.() ?? null
    if (!sidebar) return { ok: false, error: '侧栏尚未就绪' }
    if (typeof dir !== 'string' || dir.length === 0) return { ok: false, error: '空路径' }
    if (!existsSync(dir)) return { ok: false, error: `目录不存在：${dir}` }
    try {
      await sidebar.setRoot(dir)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('sidebar:pick-dir', async () => {
    const win = getWindowManager()?.window ?? null
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths.length) return ''
    return res.filePaths[0]
  })

  ipcMain.handle('sidebar:toggle-dir', (_e, path: unknown) => {
    const sidebar = deps.getSidebar?.() ?? null
    const safe = safeSidebarPath(sidebar, path)
    if (!safe) return { ok: false, error: '路径不在侧栏目录内' }
    sidebar!.toggleDir(safe)
    return { ok: true }
  })

  ipcMain.handle('sidebar:collapse-all', () => {
    const sidebar = deps.getSidebar?.() ?? null
    sidebar?.collapseAll()
    return { ok: true }
  })

  ipcMain.handle('sidebar:refresh', async () => {
    const sidebar = deps.getSidebar?.() ?? null
    if (!sidebar) return { ok: false, error: '侧栏尚未就绪' }
    await sidebar.refreshAll(true)
    return { ok: true }
  })

  ipcMain.handle('sidebar:diff', async (_e, path: unknown) => {
    const sidebar = deps.getSidebar?.() ?? null
    const safe = safeSidebarPath(sidebar, path)
    if (!safe) return { ok: false, text: '', truncated: false, error: '路径不在侧栏目录内' }
    try {
      return await sidebar!.diff(safe)
    } catch (err) {
      return { ok: false, text: '', truncated: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('sidebar:open', async (_e, path: unknown, line?: number) => {
    const sidebar = deps.getSidebar?.() ?? null
    const safe = safeSidebarPath(sidebar, path)
    if (!safe) return { ok: false, error: '路径不在侧栏目录内' }
    try {
      return await openInEditor(loadExternalEditor(), safe, line)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('sidebar:reveal', (_e, path: unknown) => {
    const safe = safeSidebarPath(deps.getSidebar?.() ?? null, path)
    if (!safe) return { ok: false, error: '路径不在侧栏目录内' }
    shell.showItemInFolder(safe)
    return { ok: true }
  })

  ipcMain.handle('sidebar:copy', (_e, path: unknown) => {
    if (typeof path !== 'string' || path.length === 0) return { ok: false, error: '空路径' }
    clipboard.writeText(path)
    return { ok: true }
  })

  // ── Sidebar: git write operations ──
  //
  // Thin forwarders: every §3.8 guard (managed directory, index.lock, message
  // sanity, path validation) lives in git-service.ts, the only module that
  // shells out to git. These handlers exist so the renderer cannot craft
  // arbitrary argv — paths are re-validated against the sidebar's current
  // root here too (safeSidebarPath), the same boundary the read paths use.
  // SidebarService handles the aftermath (invalidate cache, force refresh,
  // announce), so the page's git strip updates without waiting the refresh
  // floor out.

  /**
   * Re-validate a renderer-supplied file list against the sidebar's current
   * root. Returns the cleaned list, or an error string.
   */
  const safeSidebarFileList = (
    sidebar: SidebarService | null,
    files: unknown,
  ): string[] | string => {
    if (!sidebar || !sidebar.root) return '侧栏尚未就绪'
    if (!Array.isArray(files)) return '文件列表无效'
    if (files.length === 0) return '未选择任何文件'
    const out: string[] = []
    for (const f of files) {
      if (typeof f !== 'string' || f.length === 0) return '文件列表包含空路径'
      const safe = safeSidebarPath(sidebar, f)
      if (!safe) return '路径不在侧栏目录内'
      if (!out.includes(safe)) out.push(safe)
    }
    return out
  }

  ipcMain.handle('sidebar:stage', async (_e, files: unknown) => {
    const sidebar = deps.getSidebar?.() ?? null
    if (!sidebar) return { ok: false, error: '侧栏尚未就绪' }
    const list = safeSidebarFileList(sidebar, files)
    if (typeof list === 'string') return { ok: false, error: list }
    return sidebar.stage(list)
  })

  ipcMain.handle('sidebar:unstage', async (_e, files: unknown) => {
    const sidebar = deps.getSidebar?.() ?? null
    if (!sidebar) return { ok: false, error: '侧栏尚未就绪' }
    const list = safeSidebarFileList(sidebar, files)
    if (typeof list === 'string') return { ok: false, error: list }
    return sidebar.unstage(list)
  })

  ipcMain.handle('sidebar:commit', async (_e, message: unknown) => {
    const sidebar = deps.getSidebar?.() ?? null
    if (!sidebar) return { ok: false, error: '侧栏尚未就绪' }
    return sidebar.commit(typeof message === 'string' ? message : '')
  })

  // ── Sidebar: destructive git operations ──
  //
  // The page owns the §3.8 double-confirm; these handlers own the machine
  // guards, which re-verify everything (managed directory, index lock, file
  // status, branch-name shape) before git runs. A stale page or a crafted
  // message cannot skip either layer.

  ipcMain.handle('sidebar:branches', async () => {
    const sidebar = deps.getSidebar?.() ?? null
    if (!sidebar) return { ok: false, error: '侧栏尚未就绪' }
    return sidebar.branches()
  })

  ipcMain.handle('sidebar:checkout', async (_e, name: unknown) => {
    const sidebar = deps.getSidebar?.() ?? null
    if (!sidebar) return { ok: false, error: '侧栏尚未就绪' }
    if (typeof name !== 'string') return { ok: false, error: '分支名无效' }
    return sidebar.checkoutBranch(name)
  })

  const DISCARD_KEYS = ['staged', 'unstaged', 'untracked'] as const

  ipcMain.handle('sidebar:discard', async (_e, path: unknown, status: unknown) => {
    const sidebar = deps.getSidebar?.() ?? null
    if (!sidebar) return { ok: false, error: '侧栏尚未就绪' }
    if (typeof path !== 'string' || path.length === 0) return { ok: false, error: '空路径' }
    const src = (status && typeof status === 'object' ? status : {}) as Record<string, unknown>
    // Booleans only: a renderer that sends `status.unstaged = 'yes'` gets a
    // refusal, not a coercion — discard destroys work and deserves strictness.
    const flags: { staged: boolean; unstaged: boolean; untracked: boolean } = {
      staged: false,
      unstaged: false,
      untracked: false,
    }
    for (const k of DISCARD_KEYS) {
      if (typeof src[k] !== 'boolean') return { ok: false, error: '文件状态无效' }
      flags[k] = src[k]
    }
    return sidebar.discardFile(path, flags)
  })


  ipcMain.handle('sidebar:set-width', (_e, w: number) => {
    if (typeof w !== 'number' || !Number.isFinite(w)) return
    getWindowManager()?.setSidebarWidth(w)
  })

  // Its own channel rather than reusing `panel:get-prefs`: the sidebar would
  // then be reading a blob shaped for a different page, and the prefs object
  // grows a field every time a panel does. Also keeps every channel a
  // renderer touches namespaced to that renderer.
  ipcMain.handle('sidebar:get-prefs', () => {
    const prefs = getWindowManager()?.panelPrefs ?? loadPanelPrefs()
    return { sidebarWidth: prefs.sidebarWidth, sidebarVisible: prefs.sidebarVisible }
  })

  /**
   * Drop `@<path>` into dsh's chat input.
   *
   * Validated against the sidebar's current root in safeSidebarPath, so a
   * stale row from a directory the sidebar is no longer showing cannot turn
   * into an arbitrary-path insert. The renderer-side script (see
   * dsh-input.ts) does the actual DOM work; executeJavaScript's return value
   * is the IIFE's own result, so a missing textarea comes back as
   * `{ok:false, error}` rather than an exception.
   */
  ipcMain.handle('sidebar:add-to-chat', async (_e, path: unknown) => {
    const safe = safeSidebarPath(deps.getSidebar?.() ?? null, path)
    if (!safe) return { ok: false, error: '路径不在侧栏目录内' }
    const text = buildChatInsert(safe)
    if (!text) return { ok: false, error: '无法生成引用' }
    const wm = getWindowManager()
    // The dsh chat box lives in the content view, not in the window's own
    // (empty) webContents.
    const page = wm?.pageContents ?? null
    if (!page) return { ok: false, error: '主窗口尚未就绪' }
    if (page.isDestroyed()) return { ok: false, error: '主窗口已销毁' }
    try {
      const result = await page.executeJavaScript(
        buildInsertScript(text),
        true,
      ) as ChatInsertResult | null
      if (!result) return { ok: false, error: 'dsh 页面未返回结果' }
      return result
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Logbar: bottom log panel ──

  /**
   * Shape the mux activity ring into the logbar's Agent feed.
   *
   * The 主/子 prefix is resolved HERE, at read time, from the session table in
   * the same snapshot — so an entry recorded before the 5s poll first
   * classified its session still renders with the right role. The session ids
   * come along for the same reason, and `rootSessionId` is walked up the
   * parent chain so a session filter catches a subagent's work however deeply
   * it is nested.
   */
  const activityEntries = (list: readonly ActivityEntry[]): LogEntry[] => {
    const sessions: readonly SessionInfo[] = deps.getStream?.()?.snapshot().sessions ?? []
    const byId = new Map(sessions.map((s) => [s.sessionId, s] as const))
    /**
     * Bounded walk: a parent chain that somehow points at itself must not hang
     * the feed. Eight levels is far past anything dsh creates (main → subagent)
     * and keeps the loop obviously finite.
     */
    const rootOf = (sessionId: string): string => {
      let cur = sessionId
      for (let i = 0; i < 8; i++) {
        const parent = byId.get(cur)?.parentSessionId
        if (!parent) break
        cur = parent
      }
      return cur
    }
    return list.map((a) => {
      const role = byId.get(a.sessionId)?.parentSessionId ? '子' : '主'
      return entryFromAgent({
        ts: a.ts,
        text: a.kind === 'tool/call' ? `[${role}] 调用 ${a.name}` : `[${role}] 完成 ${a.name}`,
        sessionId: a.sessionId,
        rootSessionId: rootOf(a.sessionId),
      })
    })
  }

  const agentFeed = (): LogEntry[] => activityEntries(deps.getStream?.()?.snapshot().activity ?? [])

  /**
   * Buffered history from all three feeds, merged/sorted/capped by
   * log-model.ts.
   *
   * `active` is deliberately null here — the page applies its own chip filter
   * on top, and re-invoking snapshot on every filter toggle would ship the
   * whole ring over IPC for nothing. `sources` rides along so the page builds
   * its chips from the same list the main process filters with.
   *
   * The session filter is applied on the main-process side (unlike the chips):
   * the page has to DROP lines that no longer match, which only the filtered
   * snapshot can tell it. The current filter rides along as `filter` so a page
   * that loads while one is active shows the same chip it would have gotten
   * from the push.
   */
  ipcMain.handle('logs:snapshot', () => ({
    entries: buildView(
      getRecentLines(400),
      getBackendLines(400),
      agentFeed(),
      null,
      400,
      logSessionFilter?.sessionId ?? null,
    ),
    sources: LOG_SOURCES.map((id) => ({ id, label: LOG_SOURCE_LABELS[id] })),
    filter: logSessionFilter,
  }))

  /**
   * Clear the session filter (the chip's ✕).
   *
   * A `logs:*` channel rather than a `sidebar:*` one because the log bar owns
   * clearing its own filter — and test/panel-api.contract.cjs rejects a
   * preload reaching into another overlay's namespace.
   */
  ipcMain.handle('logs:clear-session-filter', () => {
    logSessionFilter = null
    pushSessionFilter()
    return { ok: true }
  })

  ipcMain.handle('logs:reveal-dir', async () => {
    const err = await shell.openPath(getLogDir())
    return err ? { ok: false, error: err } : { ok: true }
  })

  // The logbar renders backend lines with clickable file paths (the panel's
  // old 运行监控 capability moved here). Path matching stays in path-links.ts,
  // reached over IPC because the logbar preload is sandboxed (electron only).
  ipcMain.handle('logs:find-paths', (_e, texts: unknown) => {
    if (!Array.isArray(texts)) return []
    return texts.map((t) => (typeof t === 'string' ? findPaths(t) : []))
  })

  ipcMain.handle('logs:open-in-editor', async (_e, file: unknown) => {
    if (typeof file !== 'string' || file.length === 0) {
      return { ok: false, error: '空路径' }
    }
    try {
      return await openInEditor(loadExternalEditor(), file)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('logs:reveal-path', (_e, file: unknown) => {
    if (typeof file !== 'string' || file.length === 0) {
      return { ok: false, error: '空路径' }
    }
    shell.showItemInFolder(file)
    return { ok: true }
  })

  // The logbar page sends the desired TOTAL height while its top-edge handle
  // is dragged; setLogbarHeight clamps to LOGBAR_MIN/MAX, persists and
  // relayouts, so a burst of mousemove events costs at most one relayout each
  // and a stale page cannot push an absurd number into the geometry.
  // One-way (`on`) on purpose: drag updates have nothing to reply with, and a
  // queued reply per mousemove would only pile up during fast drags.
  ipcMain.on('logs:set-height', (_e, h: number) => {
    if (typeof h !== 'number' || !Number.isFinite(h)) return
    getWindowManager()?.setLogbarHeight(h)
  })

  // ── Settings: standalone settings window ──

  /**
   * Where the editor "test open" writes its probe file.
   *
   * A FIXED path in the OS temp directory, and deliberately not a real
   * project file: the settings window has no business opening something the
   * user did not point at, and it must never open the prefs file itself — one
   * stray edit there is a corrupted configuration, reported later as a
   * completely unrelated failure. Reusing one path also keeps the temp
   * directory clean no matter how many times the button is pressed.
   */
  const EDITOR_TEST_FILE = join(tmpdir(), 'deepseek-studio-editor-test.txt')

  /**
   * Flatten the currently persisted settings into a SettingsState.
   *
   * They live in three different places (top-level prefs, the panel blob, and
   * the editor record) which is exactly why a settings window was worth
   * building: there was no single place to look at or edit them.
   */
  const readSettingsState = (): SettingsState => {
    const prefs = loadPreferences()
    const p = loadPanelPrefs()
    const editor = loadExternalEditor()
    return {
      themeId: prefs.themeId,
      uiScale: p.uiScale,
      sidebarVisible: p.sidebarVisible,
      panelVisible: p.visible,
      statusVisible: p.statusVisible,
      logbarVisible: p.logbarVisible,
      editor: { command: editor?.command ?? '', args: editor?.args ?? '' },
      channel: normalizeChannel(prefs.channel),
    }
  }

  ipcMain.handle('settings:read', () => ({
    state: readSettingsState(),
    options: {
      // Built here, not in the page: the sandboxed preload cannot require
      // theme.js / channels.js / external-editor.js, and shipping the lists
      // over IPC is what lets it stay sandboxed.
      themes: listThemes().map((t) => ({ value: t.id, label: t.name })),
      channels: CHANNELS.map((c) => ({ value: c.id, label: c.label, risky: c.risky })),
      scales: UI_SCALES.map((s) => ({ value: s, label: `${Math.round(s * 100)}%` })),
      editorPresets: EDITOR_PRESETS.map((p) => ({
        value: p.id,
        label: p.label,
        command: p.config.command,
        args: p.config.args ?? '',
      })),
    },
    info: {
      prefsPath: prefsPath(),
      version: deps.getAppVersion(),
    },
  }))

  /**
   * Save a whole settings state.
   *
   * Everything the page sends is untrusted — it is the same shape as our
   * state, but it arrives from a renderer, and the values land in
   * `setBounds()`, in CSS and in `spawn()`. Each field is therefore coerced
   * back to something legal rather than written through.
   *
   * Only the changed fields are applied. Re-applying everything would reload
   * the dsh page for a theme that did not change and re-inject CSS on every
   * save, and the reload is visible to the user as a flicker.
   */
  ipcMain.handle('settings:save', (_e, raw: unknown) => {
    const before = readSettingsState()
    const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const ed = (src.editor && typeof src.editor === 'object' ? src.editor : {}) as Record<string, unknown>

    const after: SettingsState = {
      themeId: typeof src.themeId === 'string' && src.themeId ? src.themeId : before.themeId,
      // normalizeUiScale, not Number(): the value is interpolated into CSS,
      // where a 0 or NaN renders every panel blank — indistinguishable from a
      // crash, and it would happen on the very screen used to fix it.
      uiScale: normalizeUiScale(src.uiScale),
      sidebarVisible: typeof src.sidebarVisible === 'boolean' ? src.sidebarVisible : before.sidebarVisible,
      panelVisible: typeof src.panelVisible === 'boolean' ? src.panelVisible : before.panelVisible,
      statusVisible: typeof src.statusVisible === 'boolean' ? src.statusVisible : before.statusVisible,
      logbarVisible: typeof src.logbarVisible === 'boolean' ? src.logbarVisible : before.logbarVisible,
      editor: {
        command: normalizeTextField(ed.command),
        args: normalizeTextField(ed.args, 256),
      },
      channel: isChannelId(src.channel) ? src.channel : before.channel,
    }

    const changes = changedFields(before, after)
    const restartRequired = needsRestart(changes)
    const wm = getWindowManager()

    if (changes.includes('themeId')) applyTheme(after.themeId)

    if (changes.includes('uiScale')) {
      // Normalised again at the boundary rather than trusting `after.uiScale`:
      // it is typed `number` because the page sends arbitrary JSON, and this
      // is the last point before the value is interpolated into CSS.
      const scale = normalizeUiScale(after.uiScale)
      wm?.setUiScale(scale)
      savePanelPrefs({ uiScale: scale })
    }

    if (changes.includes('sidebarVisible')) {
      wm?.setSidebarVisible(after.sidebarVisible)
      savePanelPrefs({ sidebarVisible: after.sidebarVisible })
    }
    if (changes.includes('panelVisible')) {
      wm?.setPanelVisible(after.panelVisible)
      savePanelPrefs({ visible: after.panelVisible })
    }
    if (changes.includes('statusVisible')) {
      wm?.setStatusVisible(after.statusVisible)
      savePanelPrefs({ statusVisible: after.statusVisible })
    }
    if (changes.includes('logbarVisible')) {
      wm?.setLogbarVisible(after.logbarVisible)
      savePanelPrefs({ logbarVisible: after.logbarVisible })
    }

    if (changes.includes('editor')) saveExternalEditor(after.editor)

    // Persisted now, applied on next boot: the channel is read once while
    // resolving the upstream runtime, and switching it live would leave a
    // running dsh on the old channel while the prefs claim the new one.
    if (changes.includes('channel')) savePreferences({ channel: after.channel })

    // Lets main.ts rebuild the menu, whose 视图 items mirror several of these.
    if (changes.length > 0) notifySettingsSaved(restartRequired)

    return { ok: true, restartRequired }
  })

  ipcMain.handle('settings:browse-editor', async () => {
    const win = getWindowManager()?.window ?? null
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择编辑器可执行文件',
      properties: ['openFile'],
      // Windows executables are not reliably marked executable, so the
      // extension filter is the only useful hint there.
      filters:
        process.platform === 'win32'
          ? [{ name: '可执行文件', extensions: ['exe', 'cmd', 'bat'] }]
          : [],
    })
    if (res.canceled || !res.filePaths.length) return ''
    return res.filePaths[0]
  })

  /**
   * Open a probe file with the configuration currently in the form.
   *
   * Takes the config as an argument rather than reading it from disk so that
   * "test" tests what the user is looking at — testing the saved value would
   * make the button meaningless until they save first, which is the one thing
   * a test button must not require.
   */
  ipcMain.handle('settings:test-editor', async (_e, raw: unknown) => {
    const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const config = {
      command: normalizeTextField(src.command),
      args: normalizeTextField(src.args, 256),
    }
    try {
      writeFileSync(
        EDITOR_TEST_FILE,
        'DeepSeek Studio 编辑器测试文件\n\n' +
          '如果你能看到这一行，说明外部编辑器配置正常。\n' +
          '本文件可以安全删除。\n',
        'utf-8',
      )
    } catch (err) {
      return { ok: false, error: `无法创建测试文件：${(err as Error).message}` }
    }
    // Line 3 is the "it works" line, so a working --goto template lands the
    // cursor on visible proof rather than on the title.
    try {
      return await openInEditor(config, EDITOR_TEST_FILE, 3, 1)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('settings:reveal-prefs', async () => {
    // showItemInFolder needs the file to exist; if it does not, the prefs are
    // simply at their defaults and opening the folder is still the right
    // answer (that is where the file will be created).
    const err = existsSync(prefsPath())
      ? await shell.showItemInFolder(prefsPath())
      : await shell.openPath(join(prefsPath(), '..'))
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle('settings:describe-editor', (_e, raw: unknown) => {
    const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    return describeEditorConfig({
      command: normalizeTextField(src.command),
      args: normalizeTextField(src.args, 256),
    })
  })

  /**
   * Restart the app.
   *
   * Reached only from the "needs a restart" bar, so it is always preceded by a
   * save. relaunchApp() quits this process, so the IPC reply may never be
   * delivered — the page disables its button before calling rather than
   * relying on the response.
   */
  ipcMain.handle('settings:relaunch', () => {
    try {
      relaunchApp()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Command palette (Ctrl+K) ──

  /**
   * Filtered + ranked commands for the query. Filtering happens HERE, not in
   * the page: command-model.ts is unit-tested, and the sandboxed palette
   * renderer never needs the raw list at all.
   */
  ipcMain.handle('palette:query', (_e, q: unknown) => {
    const src = deps.getPaletteSource?.() ?? null
    if (!src) return []
    return filterCommands(buildCommandList(src), typeof q === 'string' ? q : '')
  })

  /**
   * Run one command by id, then hide the palette. Hiding is the main
   * process's job so it happens even if the renderer's own hide message lost
   * the race with the reply.
   */
  ipcMain.handle('palette:run', (_e, id: unknown) => {
    const src = deps.getPaletteSource?.() ?? null
    if (!src) return { ok: false, error: '命令尚未就绪' }
    const ran = dispatchCommand(src, id)
    if (ran) hideCommandPalette()
    return ran ? { ok: true } : { ok: false, error: '未知命令' }
  })

  ipcMain.on('palette:hide', () => hideCommandPalette())

  // ── Live feeds ──

  // ONE subscription feeds all consumers. The health monitor deliberately
  // takes its input here rather than subscribing from main.ts: two independent
  // subscriptions would make the order in which health and the logbar see a
  // line depend on registration order. (The panel stopped rendering raw
  // backend lines — they live in the logbar now.)
  const unsubBackend = subscribeBackend((line: BackendLine) => {
    getHealthMonitor()?.feedLine(line)
    pushLogbar(entryFromBackend(line))
  })

  // Second feed for the logbar: shell lines (launcher / wizard / fatal) from
  // log(). parseShellLine re-parses the exact string shape getRecentLines()
  // produces, so a replayed snapshot and a live line take the same path —
  // there is no second formatting for a bug to hide behind.
  const unsubShellLog = subscribeLog((name, _ts, line) => {
    const entry = parseShellLine(`[${name}] ${line}`)
    if (entry) pushLogbar(entry)
  })

  // Change review is push-notified but pull-loaded. A payload-less revision
  // bump keeps the broadcast cheap (diffs carry whole file contents, and a
  // chatty agent would otherwise ship megabytes per second over IPC), while the
  // panel's own 100ms batching stays the single throttle point.
  let revision = 0
  /**
   * Approval IDs already surfaced to the user, so we notify once per approval
   * rather than once per change event (the stream fires on every frame).
   * Pruned against the live pending list on every tick — that both bounds the
   * set and lets an approval that comes back after its TTL notify again.
   */
  const notifiedApprovals = new Set<string>()

  /**
   * Give the sidebar its first directory, taken from the session dsh is
   * actually working in.
   *
   * The sidebar is useless pointing at nothing, and the whole point of it is to
   * show what the agent is touching — so the agent's own cwd is a better
   * default than the auto-update workspace. Picked ONCE: after that the user's
   * choice wins, because yanking the tree to a different directory mid-task
   * is worse than a stale one.
   */
  const autoPickSidebarRoot = (): void => {
    const sidebar = deps.getSidebar?.() ?? null
    if (!sidebar || sidebar.root) return
    // sessions() is already ordered most-recently-updated first, so the first
    // one that still exists on disk is the agent's current focus.
    const dirs = (deps.getStream?.()?.sessions() ?? [])
      .map((s) => s.cwd)
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
    const best = dirs.find((d) => existsSync(d))
    if (best) void sidebar.setRoot(best)
  }

  /**
   * Live tail of the agent activity ring for the logbar.
   *
   * onChange carries no payload (it is a revision bump), so the tail is
   * tracked by count: the ring is append-only between caps, so "longer than
   * last time" means "push the difference". A cap wrap (length shrank) just
   * re-pushes everything — rare, and correct.
   */
  let lastActivityCount = 0
  const pushNewActivity = (): void => {
    const snap = deps.getStream?.()?.snapshot()
    const activity = snap?.activity ?? []
    if (activity.length === lastActivityCount) return
    const fresh =
      activity.length > lastActivityCount
        ? activity.slice(activity.length - (activity.length - lastActivityCount))
        : activity
    lastActivityCount = activity.length

    // Same shaping as the snapshot's agent feed (and now the same session
    // ids): a live line and a replayed one must carry identical metadata, or
    // a filter would keep one and drop the other.
    for (const entry of activityEntries(fresh)) pushLogbar(entry)
  }

  /**
   * Aggregated agent stats (main + subagents) for the status bar.
   *
   * Recomputed per change and sent only when the rendered line differs: token
   * projections can tick many times a second during a streamed reply, and the
   * status bar does not need intermediate values — only stable ones.
   */
  let lastStatsLine = ''
  const statsRows = (): StatsSessionRow[] => {
    const store = deps.getStream?.()?.store
    if (!store) return []
    const snap = store.snapshot()
    const bySession = new Map<string, { stats?: unknown; usage?: unknown }>()
    for (const p of store.projectionEntries()) {
      const row = bySession.get(p.sessionId) ?? {}
      if (p.key === 'sessionStats') row.stats = p.value
      else if (p.key === 'tokenUsage') row.usage = p.value
      bySession.set(p.sessionId, row)
    }
    const sessions = snap.sessions.length > 0
      ? snap.sessions
      : [...bySession.keys()].map((sessionId) => ({
        sessionId,
        running: false,
        updatedAt: 0,
      }))
    return sessions.map((s): StatsSessionRow => {
      const extra = bySession.get(s.sessionId)
      return {
        sessionId: s.sessionId,
        parentSessionId: (s as { parentSessionId?: string }).parentSessionId,
        running: s.running,
        updatedAt: s.updatedAt,
        agentPreset: (s as { agentPreset?: string }).agentPreset,
        stats: extra?.stats as StatsSessionRow['stats'],
        usage: extra?.usage as StatsSessionRow['usage'],
      }
    })
  }
  // Overview rows carry the real session fields (the earlier draft zeroed
  // running/updatedAt here — the store's snapshot already knows them).
  const overviewRows = (): OverviewSessionRow[] => {
    const store = deps.getStream?.()?.store
    if (!store) return []
    const snap = store.snapshot()
    const bySession = new Map<string, Record<string, unknown>>()
    for (const p of store.projectionEntries()) {
      const row = bySession.get(p.sessionId) ?? {}
      if (p.key === 'sessionStats') row.stats = p.value
      else if (p.key === 'tokenUsage') row.usage = p.value
      else if (p.key === 'contextPressure') row.contextPressure = p.value
      else if (p.key === 'contextBreakdown') row.contextBreakdown = p.value
      bySession.set(p.sessionId, row)
    }
    return snap.sessions.map((s) => {
      const extra = bySession.get(s.sessionId)
      return {
        sessionId: s.sessionId,
        parentSessionId: s.parentSessionId,
        running: s.running,
        agentPreset: s.agentPreset,
        usage: extra?.usage as OverviewSessionRow['usage'],
        contextPressure: extra?.contextPressure as OverviewSessionRow['contextPressure'],
        contextBreakdown: extra?.contextBreakdown as OverviewSessionRow['contextBreakdown'],
      }
    })
  }

  const pushStatsIfChanged = (): void => {
    const line = formatStatusLine(buildStatusBarView())
    if (line === lastStatsLine) return
    lastStatsLine = line
    const view = getWindowManager()?.statusBar ?? null
    if (!view || view.webContents.isDestroyed()) return
    try {
      view.webContents.send('panel:stats', line)
    } catch { /* view destroyed mid-send */ }
  }

  /** Initial fill for the status bar (same shape as the push: one line or ''). */
  ipcMain.handle('panel:stats-now', () => formatStatusLine(buildStatusBarView()))

  /** Price table: user overrides on top of the built-in DeepSeek entries. */
  const priceEntries = () => [
    ...parsePriceOverrides(loadPriceOverridesText()),
    ...BUILTIN_PRICES,
  ]

  /** 元 estimate for ONE session's token buckets, or null when no price matched. */
  const sessionCost = (
    preset: string | undefined,
    u: { uncachedInputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown } | undefined,
  ): number | null => {
    const price = pickPrice(priceEntries(), preset)
    if (!price) return null
    const read = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined
    return estimateCost(
      {
        uncachedInput: read(u?.uncachedInputTokens),
        output: read(u?.outputTokens),
        cacheRead: read(u?.cacheReadTokens),
        cacheWrite: read(u?.cacheWriteTokens),
      },
      price,
    )
  }

  /**
   * The full bottom-bar line (model | 本次/平均命中 | tokens | 费用 | 轮次 |
   * 上下文 | 压缩阈值), assembled from the same projection rows the overview
   * uses. "本次" is the most recently updated MAIN session; "会话/平均" folds
   * every main session. Composed in stats-model.ts (unit-tested).
   */
  const buildStatusBarView = (): StatusBarView => {
    const rows = statsRows()
    const main = rows.filter((r) => !r.parentSessionId)

    let aggTokens = 0
    let hitNum = 0
    let hitDen = 0
    for (const r of main) {
      const u = r.usage
      if (u && typeof u === 'object') {
        aggTokens +=
          (typeof u.uncachedInputTokens === 'number' ? u.uncachedInputTokens : 0) +
          (typeof u.outputTokens === 'number' ? u.outputTokens : 0) +
          (typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0) +
          (typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0)
        hitNum += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
        hitDen +=
          (typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0) +
          (typeof u.uncachedInputTokens === 'number' ? u.uncachedInputTokens : 0)
      }
    }
    const aggHit = hitDen > 0 ? Math.round((hitNum / hitDen) * 1000) / 10 : null

    // "本次": the newest main session by recency stamp. Ties keep the first —
    // session.list is newest-first already, so the earlier row wins on a tie.
    let active: StatsSessionRow | null = null
    let stamp = -1
    for (const r of main) {
      const t = typeof r.updatedAt === 'number' ? r.updatedAt : 0
      if (t > stamp) {
        stamp = t
        active = r
      }
    }

    const activeView = active
      ? {
        preset: active.agentPreset,
        turns: active.stats && typeof active.stats === 'object'
          ? (typeof active.stats.turns === 'number' ? active.stats.turns : 0)
          : 0,
        tokens: active.usage && typeof active.usage === 'object'
          ? (typeof active.usage.uncachedInputTokens === 'number' ? active.usage.uncachedInputTokens : 0) +
            (typeof active.usage.outputTokens === 'number' ? active.usage.outputTokens : 0) +
            (typeof active.usage.cacheReadTokens === 'number' ? active.usage.cacheReadTokens : 0) +
            (typeof active.usage.cacheWriteTokens === 'number' ? active.usage.cacheWriteTokens : 0)
          : 0,
        hitRate: active.usage && typeof active.usage === 'object'
          ? (() => {
            const read = typeof active.usage.cacheReadTokens === 'number' ? active.usage.cacheReadTokens : 0
            const unc = typeof active.usage.uncachedInputTokens === 'number' ? active.usage.uncachedInputTokens : 0
            return read + unc > 0 ? Math.round((read / (read + unc)) * 1000) / 10 : null
          })()
          : null,
        cost: sessionCost(active.agentPreset, active.usage),
      }
      : null

    const costSummary = buildCostSummary()

    return {
      active: activeView,
      agg: {
        tokens: aggTokens,
        hitRate: aggHit,
        cost: costSummary.cost,
      },
      contextPercent: aggregateOverview(overviewRows()).contextPercent,
      compactThreshold: 0.8, // compaction-basic DEFAULT_THRESHOLD_RATIO; not on the wire
    }
  }

  /**
   * The cost fold used by the overview tab (会话费用 / 平均命中). Main
   * sessions only — a subagent's tokens are already inside its parent's
   * bill. (The status BAR no longer uses this; it shows per-session and
   * aggregate segments from buildStatusBarView instead.)
   */
  const buildCostSummary = (): CostSummary => {
    const entries = priceEntries()
    let cost = 0
    let matched = false
    let matchedName: string | null = null
    let unmatched = 0
    let hitNum = 0
    let hitDen = 0
    for (const row of overviewRows()) {
      if (row.parentSessionId) continue // 子 agent 的 token 已含在主会话账单的输入里
      const u = row.usage
      if (u && typeof u === 'object') {
        const read = typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
        const unc = typeof u.uncachedInputTokens === 'number' ? u.uncachedInputTokens : 0
        hitNum += read
        hitDen += read + unc
      }
      const price = pickPrice(entries, row.agentPreset)
      if (!price) {
        if (u && typeof u === 'object' &&
          ((u.cacheReadTokens ?? 0) !== 0 || (u.uncachedInputTokens ?? 0) !== 0 ||
            (u.outputTokens ?? 0) !== 0 || (u.cacheWriteTokens ?? 0) !== 0)) {
          unmatched += 1
        }
        continue
      }
      matched = true
      if (matchedName === null && price.model !== '*') matchedName = price.model
      cost += estimateCost(
        {
          uncachedInput: u && typeof u === 'object' ? u.uncachedInputTokens : undefined,
          output: u && typeof u === 'object' ? u.outputTokens : undefined,
          cacheRead: u && typeof u === 'object' ? u.cacheReadTokens : undefined,
          cacheWrite: u && typeof u === 'object' ? u.cacheWriteTokens : undefined,
        },
        price,
      )
    }
    return {
      hitRate: hitDen > 0 ? Math.round((hitNum / hitDen) * 1000) / 10 : null,
      cost: matched ? Math.round(cost * 100) / 100 : null,
      matched: matched ? (matchedName ?? '*') : null,
      unmatched,
    }
  }

  /**
   * Session-overview aggregation for the panel's 概览 tab.
   *
   * Same projection rows as the stats segment, plus the context keys the
   * event-store keeps; the arithmetic lives in stats-model.ts (pure,
   * unit-tested), this only decides which sessions contribute. The cost fold
   * rides along so the overview can show 会话费用 without a second pull.
   */
  ipcMain.handle('panel:overview-now', () => ({
    ...aggregateOverview(overviewRows()),
    cost: buildCostSummary(),
  }))

  const stream = deps.getStream?.() ?? null
  stream?.setOnChange(() => {
    revision += 1
    broadcast(getWindowManager(), 'panel:changes-rev', revision)

    // Logbar agent tail + status bar fold. Both read the same snapshot
    // the panel revision bump just announced; each keeps its own
    // dedup/throttle so a burst of frames costs one recompute, not N sends.
    pushNewActivity()
    pushStatsIfChanged()

    // System notification for each NEW pending approval. dsh already shows its
    // own modal inside the webview; the OS toast makes sure the user notices
    // even if the window is behind another app, and the taskbar flash makes the
    // window itself jump back to the front.
    const approvals = stream?.approvals() ?? []
    const live = new Set(approvals.map((a) => a.approvalId))
    for (const id of notifiedApprovals) {
      if (!live.has(id)) notifiedApprovals.delete(id)
    }
    for (const approval of approvals) {
      if (notifiedApprovals.has(approval.approvalId)) continue
      notifiedApprovals.add(approval.approvalId)
      notifyApprovalRequired(approval)
    }

    // Keep the sidebar's git badges in step with what the agent is doing.
    // Throttled inside the service, so a burst of frames costs one `git
    // status`, and the refresh announces itself when it lands.
    autoPickSidebarRoot()
    void deps.getSidebar?.()?.refreshGit()
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

/**
 * Surface one new pending approval to the user.
 *
 * dsh already shows its own modal inside the webview — this layer exists so
 * the user notices even when the window is behind another app, AND so the
 * panel itself can take focus visually without the user having to scan the
 * title bar.
 *
 * The toast text is short on purpose: system notifications are glanceable,
 * and the panel already carries the full tool/argument detail.
 */
function notifyApprovalRequired(approval: {
  approvalId: string
  toolName: string
  sessionId: string
}): void {
  const summary = friendlyApprovalLabel(approval.toolName)
  const body = `${summary}\n点击右侧面板或此通知查看详情并决定。`
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'dsh 需要你的确认',
        body,
        urgency: 'normal',
        silent: false,
      })
      n.on('click', () => {
        const wm = getWindowManagerCached?.()
        if (wm) {
          wm.togglePanel()
          try { wm.window.show() } catch { /* window gone */ }
        }
      })
      n.show()
    }
  } catch (err) {
    // Notification is a best-effort enhancement; never break the change-review
    // flow because the OS rejected the toast.
    log('launcher', `approval notification failed: ${(err as Error).message}`)
  }

  // Flash the taskbar icon so the window itself pulls attention even if the
  // notification center is full / suppressed. No-op on platforms that ignore it.
  try {
    const wm = getWindowManagerCached?.()
    wm?.window.flashFrame?.(true)
  } catch { /* not supported everywhere */ }
}

/**
 * Human-readable label for one approval tool. Falls back to the raw id when we
 * do not recognise it — better than shipping an empty string to the OS.
 */
function friendlyApprovalLabel(tool: string): string {
  if (!tool) return 'agent 需要继续操作'
  // Common cases. Extend as new tool types are seen in the wild.
  const known: Record<string, string> = {
    'shell': '执行 shell 命令',
    'edit': '修改文件',
    'write': '创建文件',
    'read': '读取文件',
    'web': '访问网页',
    'browser': '访问网页',
    'glob': '搜索文件',
    'grep': '搜索文本',
    'ask_user': '向你提问',
  }
  return known[tool] ?? `调用 ${tool}`
}
