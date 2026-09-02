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
 *
 * Every channel STRING in the app lives in this file, because that is what
 * test/panel-api.contract.cjs correlates against: a name defined anywhere else
 * is invisible to it, and an unregistered name fails only at runtime, for the
 * user, in a packaged app with no devtools.
 */
import { ipcMain, shell, clipboard, dialog, BrowserWindow, Notification } from 'electron'
import { existsSync } from 'node:fs'
import { subscribeBackend, getBackendLines, getLogDir, log } from './logging.js'
import type { BackendLine } from './logging.js'
import { loadCurrentThemeCSS, listThemes } from './theme.js'
import { savePreferences, loadPanelPrefs, savePanelPrefs, loadExternalEditor } from './preferences.js'
import { openInEditor } from './external-editor.js'
import { isWithinRoot } from './fs-tree.js'
import { commonTool, normalizeIds } from './approval-groups.js'
import type { HealthMonitor } from './health-monitor.js'
import type { WindowManager } from './window-manager.js'
import type { SidebarService } from './sidebar-service.js'
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
  /**
   * The file/git sidebar, or null when it was never created. Optional because
   * registerIpc() must stay callable before the app has a workspace — the
   * smoke test calls it with neither a stream nor a sidebar.
   */
  getSidebar?: () => SidebarService | null
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

  // ── Sidebar: file tree + git ──

  ipcMain.handle('sidebar:snapshot', () => deps.getSidebar?.()?.snapshot() ?? EMPTY_SIDEBAR)

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

  const stream = deps.getStream?.() ?? null
  stream?.setOnChange(() => {
    revision += 1
    broadcast(getWindowManager(), 'panel:changes-rev', revision)

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
