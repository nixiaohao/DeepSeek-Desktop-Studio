/**
 * main.ts — Electron main process entry point.
 * Flow: Wizard (first run only) → Splash → Launcher (update + start backend)
 *       → BrowserWindow with theme.
 *
 * Error visibility: every failure lands in %APPDATA%\deepseek-studio\logs\
 * and surfaces through dialogs with 「打开日志文件夹」/「重试」actions.
 * `--debug` (or DSH_DEBUG=1) shows real child-process terminals.
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { Launcher } from './launcher.js'
import { loadCurrentThemeCSS } from './theme.js'
import {
  loadPreferences,
  savePreferences,
  recoveryGuidePath,
  hasRecoveryGuide,
  loadPanelPrefs,
  loadExternalEditor,
  saveExternalEditor,
} from './preferences.js'
import { channelDef, normalizeChannel, type ChannelId } from './channels.js'
import { createTray, destroyTray } from './tray.js'
import { setupMenu, type MenuActions } from './menu.js'
import { resolveWorkspace } from './workspace.js'
import { loadPackagedIcon } from './icons.js'
import { runWizard } from './wizard.js'
import { log, getLogDir, isDebug, redactTokenInText } from './logging.js'
import { relaunchApp } from './relaunch.js'
import { WindowManager } from './window-manager.js'
import { HealthMonitor, PHASE_LABEL, type HealthPhase } from './health-monitor.js'
import { registerIpc, setWindowManagerAccessor, pushSidebarUpdate } from './ipc-registry.js'
import { DshStream } from './dsh-stream.js'
import { describeEditorConfig, pickEditorInteractively } from './external-editor.js'
import { FileTree } from './file-tree.js'
import { GitService } from './git-service.js'
import { SidebarService } from './sidebar-service.js'
import { openDiagnosticsWindow, closeDiagnosticsWindow } from './diagnostics-window.js'

// ── Startup hardening (must run before app ready) ──
// 1. GPU 加速在虚拟机/远程桌面/部分驱动上会导致白屏或启动崩溃，本应用为 Web UI 外壳，无需 GPU。
// 2. 受管/加固环境（EDR、AppLocker、终端安全策略等）常拦截 Chromium 沙箱子进程
//    （restricted token + job object），导致主进程卡在启动、whenReady 永不触发；
//    本应用本质是执行任意 agent 代码的外壳，关闭沙箱不引入额外风险面，换取此类环境兼容性。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')

// Windows needs a STABLE App User Model ID for the taskbar.
//
// The `portable` target unpacks the app into a NEW randomly named temp
// directory on every run. Without an explicit ID, Windows derives the taskbar
// identity from the executable path, so every launch looks like a different
// application: the button can fall back to a generic icon, windows stop
// grouping, and pinning does not survive. A fixed ID ties all runs to one
// taskbar entry. Must be set before any window is created.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.dsh.studio')
}

// 在禁用非特权 user namespace 的发行版（Ubuntu 24.04+/Resolute）上，Chromium
// 会回退到 SUID sandbox 并因 chrome-sandbox 权限不正确而 FATAL。显式关闭
// setuid sandbox 检查（no-sandbox 已全局设置），双开关确保 AppImage 直接运行。
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-setuid-sandbox')
}

if (isDebug()) {
  log('launcher', 'DEBUG mode enabled (--debug / DSH_DEBUG=1)')
}

// ── Fatal handlers: never die silently ──

process.on('uncaughtException', (err) => {
  log('fatal', `uncaughtException: ${err.stack ?? err.message}`)
  try {
    dialog.showErrorBox(
      'DeepSeek Studio 发生错误',
      `${err.stack ?? err.message}\n\n日志目录：${getLogDir()}`
    )
  } catch { /* dialog unavailable this early — log only */ }
})

process.on('unhandledRejection', (reason) => {
  log('fatal', `unhandledRejection: ${String(reason)}`)
})

// ── Globals ──

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let marketWindow: BrowserWindow | null = null
let launcher: Launcher | null = null
/** Overlay panel + status bar owner. Created together with the main window. */
let windowManager: WindowManager | null = null
/** Backend health state machine, fed by the backend output subscription. */
let healthMonitor: HealthMonitor | null = null
/**
 * The dsh mux event stream (change review).
 *
 * Created before registerIpc() so the IPC layer can install its broadcast
 * callback; started only once a backend URL exists.
 */
let dshStream: DshStream | null = null
/** Unsubscribes the IPC feeds. Must run on window close / quit. */
let teardownIpc: (() => void) | null = null
/**
 * The file/git sidebar's state. Created eagerly so registerIpc() can reach it,
 * but its directory is only chosen once the stream reports where a session is
 * working (see ipc-registry.ts).
 */
let sidebarService: SidebarService | null = null
/**
 * The auto-update workspace, i.e. the directory the sidebar must treat as
 * read-only. Set from resolveWorkspace() below; until then the sidebar cannot
 * be write-locked, which errs on the safe side only because it is also empty.
 */
let workspaceDir = ''

// ── Splash Window ──

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 420,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // See window-manager.ts: sandbox:true (Electron 22+ default) blocks
      // nodeIntegration and the legacy require() used by the splash page.
      sandbox: false,
    },
  })
  splash.loadFile(join(app.getAppPath(), 'assets', 'splash.html'))
  splash.center()
  return splash
}

// ── Main Window ──

/**
 * Open the main window on the authenticated web URL.
 *
 * The harness hands out a per-process token; a tokenless `/` is answered with
 * 401. Loading the same URL the readiness probe used lets the server mint its
 * HttpOnly session cookie, after which plain navigation keeps working.
 */
function createMainWindow(url: string): BrowserWindow {
  const prefs = loadPreferences()
  const win = new BrowserWindow({
    width: prefs.windowBounds.width,
    height: prefs.windowBounds.height,
    x: prefs.windowBounds.x,
    y: prefs.windowBounds.y,
    minWidth: 1024,
    minHeight: 680,
    title: 'DeepSeek Studio',
    // Loaded through a buffer, not a path: a path inside app.asar silently
    // decodes to an empty image in native code (see src/icons.ts).
    icon: loadPackagedIcon(),
    show: false,
    backgroundColor: '#0f1117',
    // NOTE: no webPreferences on purpose. The dsh page is NOT rendered by this
    // window's built-in webContents any more — WindowManager creates a
    // WebContentsView for it (see window-manager.ts) so the overlays can sit
    // BESIDE the page instead of on top of it. What is left here is an empty
    // dark backdrop, and `ready-to-show` (which tracks it) no longer means
    // anything, so the show logic below follows the content view instead.
  })

  windowManager = new WindowManager(win)
  const page = windowManager.createContentView({
    url,
    preload: join(__dirname, 'preload.js'),
  })

  // Theme CSS must be re-injected after every navigation: Electron drops
  // inserted CSS when the page reloads. Bound to the CONTENT view now — the
  // window's own webContents holds no page.
  const themeCSS = loadCurrentThemeCSS()
  if (themeCSS) {
    page.webContents.on('did-finish-load', () => {
      page.webContents.insertCSS(themeCSS)
    })
  }

  // Overlay panel + status bar. Attached AFTER the content view: contentView
  // children paint in insertion order, and the page must stay underneath.
  windowManager.attach()
  // Wire the accessor so the IPC layer (notably the approval-notification path
  // defined next to registerIpc) can reach the WindowManager even though main
  // process imports it after a circular boundary.
  setWindowManagerAccessor(() => windowManager)

  page.webContents.once('did-finish-load', () => {
    splashWindow?.close()
    splashWindow = null
    win.show()
  })

  // SAFETY NET: `did-finish-load` does NOT fire if the page errors during load
  // (CSP rejection, network blip, dsh backend not yet up). With show:false the
  // user sees only a taskbar icon forever. After 12s, if the page is still
  // loading, force-show anyway — better to surface a blank page than stay
  // invisible. (Reported 2026-09-01: only-taskbar-icon symptom.)
  const showFallback = (): void => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
    splashWindow = null
    if (!win.isDestroyed()) win.show()
  }
  const fallbackTimer = setTimeout(() => {
    if (splashWindow && !win.isDestroyed() && page.webContents.isLoading()) {
      log('launcher', '页面 12s 内未完成加载，强制显示主窗口')
      showFallback()
    }
  }, 12_000)
  page.webContents.once('did-finish-load', () => clearTimeout(fallbackTimer))

  win.on('close', () => {
    const bounds = win.getBounds()
    savePreferences({
      windowBounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
    })
  })

  win.on('closed', () => {
    mainWindow = null
    // Release the overlay views and the live feeds: without this the backend
    // subscription and the 5s health ticker keep closures alive for the
    // lifetime of the process.
    teardownIpc?.()
    teardownIpc = null
    dshStream?.stop()
    windowManager?.destroy()
    windowManager = null
    launcher?.shutdown()
    destroyTray()
  })

  return win
}

// ── Backend health ──

/**
 * True while a restart is in flight.
 *
 * A restart takes seconds (the harness has to boot again), and both the status
 * bar and the 视图 menu expose it. Without a guard, two clicks spawn two
 * backends: the second loses the port race, and the window ends up pointed at
 * whichever URL won — with no way to tell which process the UI is talking to.
 */
let restarting = false

/**
 * Restart only the backend, then RELOAD the main window on the new URL.
 *
 * The reload is not optional. `dsh web` mints a fresh per-process token on
 * every launch, so after a restart the page's session cookie is dead and every
 * request answers 401 — the user would see a white screen and conclude the
 * restart broke things.
 *
 * Never restarts on its own. A backend that is mid-session may hold work the
 * user cares about, so this only ever runs from an explicit click.
 */
async function restartBackend(): Promise<{ ok: boolean; error?: string }> {
  if (!launcher) return { ok: false, error: '启动器尚未就绪' }
  if (restarting) return { ok: false, error: '重启正在进行中' }

  restarting = true
  log('launcher', 'restartBackend: restarting dsh web on user request')
  healthMonitor?.noteRestart()
  // The old connection is pointed at a process that is about to die; letting it
  // retry in the background would race the new backend for the port.
  dshStream?.stop()

  try {
    const result = await launcher.restart((msg) => log('launcher', `[restart] ${msg}`))
    if (!result.ok) {
      const error = result.error ?? '未知错误'
      healthMonitor?.noteSpawnError(`重启失败：${error}`)
      return { ok: false, error }
    }

    // NOT optional — see the note above this function.
    //
    // Reloaded on the content view, not on the window: the BrowserWindow's own
    // webContents is an empty backdrop now and reloading it would leave the
    // visible page pointing at the dead token.
    const page = windowManager?.pageContents ?? null
    if (page) {
      try {
        await page.loadURL(result.url)
      } catch (err) {
        const error = `服务已重启，但页面重新加载失败：${(err as Error).message}`
        healthMonitor?.noteSpawnError(error)
        return { ok: false, error }
      }
    }

    healthMonitor?.noteReady()
    // New process, new token, new sessions: start() sees the changed URL and
    // resets the store, so no stale approval survives the restart.
    dshStream?.start(result.url)
    log('launcher', 'restartBackend: done')
    return { ok: true }
  } finally {
    restarting = false
  }
}

/** Version / port / channel for the status bar. */
function statusInfo(): { version: string; port: number | null; channel: string } {
  return {
    version: launcher?.runtimeSrc.dshVersion() ?? 'unknown',
    port: launcher?.port ?? null,
    channel: normalizeChannel(loadPreferences().channel),
  }
}

// ── Unified quit: release everything, then hard-exit ──

/**
 * Full teardown on quit. Order matters:
 *   1. persist window bounds,
 *   2. synchronously kill the backend process TREE and free the port
 *      (see Launcher.shutdown — no async timers),
 *   3. destroy the tray,
 *   4. app.exit(0) — hard exit that cannot be held up by lingering
 *      event-loop handles (child pipes, timers), so the portable NSIS stub
 *      sees the app exit, cleans its temp dir, and UNLOCKS the exe file.
 * Without this, closing the window leaves processes behind and the exe
 * cannot be overwritten/deleted.
 */
function quitApp(): void {
  log('launcher', 'quitApp: tearing down...')
  teardownIpc?.()
  teardownIpc = null
  // Close the SSE connection before the backend dies: otherwise the reader loop
  // sees an ECONNRESET and schedules a reconnect that outlives the shutdown.
  dshStream?.stop()
  try {
    windowManager?.destroy()
  } catch { /* window already gone */ }
  windowManager = null
  // Separate from the main window: it has its own process-lifetime handle, and
  // leaving it open would keep the app alive after everything else shut down.
  closeDiagnosticsWindow()
  try {
    if (mainWindow) {
      const b = mainWindow.getBounds()
      savePreferences({
        windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      })
    }
  } catch { /* bounds may be unavailable mid-teardown */ }
  launcher?.shutdown()
  destroyTray()
  app.exit(0)
}

// ── Manual update (menu → "检查更新") ──

async function handleCheckUpdate(): Promise<void> {
  if (!launcher) return

  splashWindow = createSplash()
  splashWindow.webContents.once('did-finish-load', () => {
    splashWindow?.webContents.send('version', launcher!.version)
    splashWindow?.webContents.send('progress', '正在检查更新...')
  })

  const result = await launcher.updateNow((msg) => {
    splashWindow?.webContents.send('progress', msg)
  })

  splashWindow?.close()
  splashWindow = null

  const choice = dialog.showMessageBoxSync({
    type: result.updated ? 'info' : 'info',
    title: '检查更新',
    message: result.message,
    buttons: result.updated ? ['立即重启', '稍后'] : ['确定'],
    defaultId: 0,
    cancelId: result.updated ? 1 : 0,
  })
  if (result.updated && choice === 0) {
    launcher.shutdown()
    relaunchApp()
  }
}

// ── Plugin market (ask → progress → result) ──

/**
 * Dedicated progress window for the plugin-market install. Shows a live,
 * scrolling log of the pnpm install so a multi-minute install never looks
 * frozen. Closed by installMarketWithWindow when the install finishes.
 */
function createMarketWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 420,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // See window-manager.ts: must opt out of the Electron 22+ default
      // sandbox or nodeIntegration:true is rejected by Chromium.
      sandbox: false,
    },
  })
  win.loadFile(join(app.getAppPath(), 'assets', 'install-market.html'))
  win.center()
  win.on('closed', () => { marketWindow = null })
  return win
}

/**
 * Plugin-market orchestration, run once after the main window loads.
 *
 * Decision matrix (persisted in preferences.pluginMarket):
 *   - already installed        → record `done`, stay silent
 *   - user previously declined → never ask again
 *   - user wants it            → install (with the progress window); a failed
 *                                attempt is confirmed for retry on next launch
 *   - never asked              → ask once: 立即安装 / 暂不安装
 *
 * Outcome reporting: success → offer an immediate restart (the running web
 * server must reload to pick up the new profile layer); failure → show the
 * error with 重试 / 打开日志 / 关闭.
 */
async function promptPluginMarket(): Promise<void> {
  if (!launcher || !mainWindow) return
  const src = launcher.runtimeSrc

  if (src.isPluginMarketInstalled()) {
    if (loadPreferences().pluginMarket?.choice !== 'done') {
      savePreferences({ pluginMarket: { choice: 'done', installedAt: new Date().toISOString() } })
    }
    return
  }

  const market = loadPreferences().pluginMarket

  if (market?.choice === 'skip') return

  if (market?.choice === 'yes' && market.lastError) {
    // Wanted it before, but the last attempt failed → confirm the retry so a
    // persistently failing install does not nag on every launch.
    const retry = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '插件市场安装未完成',
      message: '上次安装 dshmarket 插件市场未成功',
      detail: `${market.lastError}\n\n是否现在重试？`,
      buttons: ['重试', '暂不安装'],
      defaultId: 0,
      cancelId: 1,
    })
    if (retry.response === 1) {
      savePreferences({ pluginMarket: { choice: 'skip' } })
      return
    }
  } else if (market?.choice !== 'yes') {
    // First decision point.
    const ask = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '安装插件市场',
      message: '是否安装 dshmarket 插件市场？',
      detail: '插件市场提供可视化插件浏览与一键安装功能。\n安装需要联网，通常需要几分钟，完成后重启应用即可生效。',
      buttons: ['立即安装', '暂不安装'],
      defaultId: 0,
      cancelId: 1,
    })
    if (ask.response === 1) {
      savePreferences({ pluginMarket: { choice: 'skip' } })
      return
    }
    savePreferences({ pluginMarket: { choice: 'yes' } })
  }

  await installMarketWithWindow()
}

async function installMarketWithWindow(): Promise<void> {
  if (!launcher) return
  const win = createMarketWindow()
  marketWindow = win

  // Do not start sending progress before the page can render it — otherwise
  // the early lines are lost to an unloaded window.
  await new Promise<void>((resolve) => {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => resolve())
    } else {
      resolve()
    }
  })

  log('launcher', 'plugin-market: install started')
  const result = await launcher.runtimeSrc.installPluginMarket((msg) => {
    log('launcher', `[plugin-market] ${msg}`)
    win.webContents.send('plugin-market-progress', msg)
  })
  log('launcher', `plugin-market: installed=${result.installed} skipped=${result.skipped} error=${result.error ?? ''}`)

  win.webContents.send('plugin-market-done', { ok: result.installed, error: result.error })
  // Let the progress window display the final state before the dialog.
  await new Promise((r) => setTimeout(r, 900))
  win.close()
  marketWindow = null

  if (!mainWindow) return // app quit mid-install

  if (result.installed) {
    savePreferences({ pluginMarket: { choice: 'done', installedAt: new Date().toISOString() } })
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '插件市场安装成功',
      message: 'dshmarket 插件市场已安装',
      detail: '重启应用后插件市场即可生效。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (res.response === 0) {
      launcher.shutdown()
      relaunchApp()
    }
  } else {
    savePreferences({ pluginMarket: { choice: 'yes', lastError: result.error } })
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '插件市场安装失败',
      message: 'dshmarket 插件市场安装失败',
      detail: `${result.error ?? '未知错误'}\n\n日志目录：${getLogDir()}`,
      buttons: ['重试', '打开日志', '关闭'],
      defaultId: 0,
      cancelId: 2,
    })
    if (res.response === 0) {
      await installMarketWithWindow() // retry the whole flow
    } else if (res.response === 1) {
      shell.openPath(getLogDir())
    }
  }
}

// ── Release channel ──

/**
 * Show a message box, parented to the main window when it exists.
 * Menu items are reachable while the splash is still up, so the unparented
 * overload has to stay a supported path.
 */
function showMessage(opts: Electron.MessageBoxSyncOptions): number {
  return mainWindow ? dialog.showMessageBoxSync(mainWindow, opts) : dialog.showMessageBoxSync(opts)
}

/**
 * The warning shown before switching to a prerelease channel.
 *
 * Deliberately explicit about the failure mode that actually bit users, and
 * about every way back: a warning that does not say how to undo the thing it
 * warns about just creates a support request.
 */
function channelRiskDetail(id: ChannelId): string {
  const def = channelDef(id)
  return [
    `【这个通道可能带来什么问题】`,
    `· 上游可能删除或重命名第三方插件依赖的接口。`,
    `  已发生过：0.1.2-alpha.2 移除了 settingsNamespace 与 installSettingsSection，`,
    `  导致 dshmarket、dsh-config-manager 等插件在加载阶段直接失败。`,
    `· 多数插件的 peerDependencies 只声明支持 rc 通道，不覆盖 ${def.id}。`,
    `· 构建可能返回成功，但启动加载插件时崩溃。`,
    ``,
    `【自动保护】`,
    `检测到该通道的版本无法构建、或构建产物缺少插件所需的导出时，`,
    `本程序会自动切回 next 通道并重新构建，通常无需你手动干预。`,
    ``,
    `【万一仍然启动不了，以下三种方式任选其一即可修复】`,
    `1. 菜单 → 更新 → 更新通道 → 选择「next（推荐）」，重启应用。`,
    `2. 设置环境变量 DSH_CHANNEL=next 后，从同一个终端窗口启动应用（此方式优先级最高）。`,
    `3. 编辑 ${recoveryGuidePath().replace(/RECOVERY\.md$/, 'studio-prefs.json')}，`,
    `   把 "channel" 改为 "next"，保存后重启。`,
    ``,
    `完整说明会写入 ${recoveryGuidePath()}，即使应用打不开也能查看。`,
  ].join('\n')
}

/** Menu → 更新 → 更新通道. Persists the choice and offers an immediate restart. */
function handleSelectChannel(id: ChannelId): void {
  const def = channelDef(id)
  const prefs = loadPreferences()

  if (def.risky && prefs.channelRiskAck?.[id] !== 'ack') {
    const choice = showMessage({
      type: 'warning',
      title: `切换到 ${def.label} 通道`,
      message: `确定要切换到 ${def.label} 通道吗？`,
      detail: channelRiskDetail(id),
      buttons: ['继续切换', '取消'],
      defaultId: 1,
      cancelId: 1,
    })
    if (choice !== 0) return
    savePreferences({ channelRiskAck: { ...(prefs.channelRiskAck ?? {}), [id]: 'ack' } })
  }

  // Route through RuntimeSource so the on-disk recovery guide is refreshed
  // too; fall back to raw persistence before the launcher exists.
  const src = launcher?.runtimeSrc
  if (src) {
    src.setChannel(id)
  } else {
    savePreferences({ channel: id })
  }
  log('launcher', `channel switched to ${id} via menu`)

  const choice = showMessage({
    type: 'info',
    title: '更新通道已切换',
    message: `已切换到 ${def.label} 通道。`,
    detail: def.risky
      ? `重启应用后会下载并构建该通道的最新版本。\n\n若启动异常，恢复指引见：\n${recoveryGuidePath()}`
      : `重启应用后会切换到该通道的最新版本。`,
    buttons: ['立即重启', '稍后重启'],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice === 0) relaunchApp()
}

/** Menu → 更新 → 打开恢复指引. */
function handleShowRecovery(): void {
  const guide = recoveryGuidePath()
  if (hasRecoveryGuide()) {
    void shell.openPath(guide)
    return
  }
  showMessage({
    type: 'info',
    title: '更新通道',
    message: '当前使用的是安全通道（stable / next），没有需要恢复的问题。',
    detail:
      `更新通道决定跟随上游的哪个发布通道，默认 next（rc 预发布）。\n` +
      `\n` +
      `如果需要切换，有三种方式：\n` +
      `1. 菜单 → 更新 → 更新通道（应用能启动时）\n` +
      `2. 设置环境变量 DSH_CHANNEL（优先级最高）\n` +
      `3. 编辑 ${guide.replace(/RECOVERY\.md$/, 'studio-prefs.json')} 里的 "channel" 字段\n` +
      `\n` +
      `切换到尝鲜通道（canary / alpha）后，本文件会被自动创建。`,
    buttons: ['确定'],
  })
}

// ── About dialog (custom: source attribution + clickable official site) ──

const OFFICIAL_SITE = 'https://www.guoxiantech.com'

function showAboutDialog(): void {
  const dshVer = launcher?.runtimeSrc.dshVersion() ?? 'unknown'
  const appVer = launcher?.version ?? app.getVersion()
  const opts: Electron.MessageBoxSyncOptions = {
    type: 'info',
    title: '关于 DeepSeek Studio',
    message: 'DeepSeek Studio',
    detail:
      `国献科技提供的源代码\n` +
      `\n` +
      `官网：${OFFICIAL_SITE}\n` +
      `\n` +
      `当前 dsh 版本：${dshVer}\n` +
      `程序版本：${appVer}`,
    buttons: ['访问官网', '确定'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const res = mainWindow ? dialog.showMessageBoxSync(mainWindow, opts) : dialog.showMessageBoxSync(opts)
  if (res === 0) {
    void shell.openExternal(OFFICIAL_SITE)
  }
}

// ── Launch error panel (actionable, never a blind wait) ──

function showLaunchError(err: Error, retry: () => void): void {
  const msg = err.message || String(err)
  log('launcher', `Launch failed: ${msg}`)
  const parent = splashWindow ?? undefined
  const choice = dialog.showMessageBoxSync(parent!, {
    type: 'error',
    title: '启动失败',
    message: msg,
    buttons: ['重试', '打开日志文件夹', '退出'],
    defaultId: 0,
    cancelId: 2,
  })
  if (choice === 0) {
    retry()
  } else if (choice === 1) {
    shell.openPath(getLogDir())
    quitApp()
  } else {
    quitApp()
  }
}

// ── Menu actions ──

/**
 * Build the action bundle the menu needs.
 *
 * A single object rather than 10 positional callbacks: the menu gained panel
 * and editor entries, and positional booleans/callbacks that deep are a
 * transposition bug waiting to happen.
 */
/**
 * Rebuild the menu so its checkbox/radio marks match reality.
 *
 * Electron does not refresh menu items on its own: `checked` is baked in when
 * the template is built, so toggling the panel from a keyboard shortcut would
 * otherwise leave 视图 → 监控面板 showing the previous state.
 */
function rebuildMenu(): void {
  setupMenu(buildMenuActions())
}

function buildMenuActions(): MenuActions {
  return {
    onCheckUpdate: () => {
      void handleCheckUpdate()
    },
    onInstallPluginMarket: () => {
      // Manual entry (menu → 插件市场 → 安装): report when it's already
      // there; otherwise install directly. Deliberately skips the ask step —
      // clicking the menu item IS the user's explicit intent, and going
      // through promptPluginMarket() would silently return when the user
      // previously chose 稍后安装 (choice='skip').
      if (launcher?.runtimeSrc.isPluginMarketInstalled()) {
        dialog.showMessageBoxSync(mainWindow!, {
          type: 'info',
          title: '插件市场',
          message: 'dshmarket 插件市场已安装',
          buttons: ['确定'],
        })
        return
      }
      void installMarketWithWindow()
    },
    onShowAbout: () => {
      showAboutDialog()
    },
    onSelectChannel: (id: ChannelId) => {
      handleSelectChannel(id)
    },
    onShowRecovery: () => {
      handleShowRecovery()
    },

    getPanelState: () => {
      const p = windowManager?.panelPrefs ?? loadPanelPrefs()
      return {
        panel: p.visible,
        statusBar: p.statusVisible,
        sidebar: p.sidebarVisible,
      }
    },
    toggleSidebar: () => {
      windowManager?.toggleSidebar()
      rebuildMenu()
    },
    togglePanel: () => {
      windowManager?.togglePanel()
      rebuildMenu()
    },
    toggleStatusBar: () => {
      const next = !(windowManager?.panelPrefs.statusVisible ?? loadPanelPrefs().statusVisible)
      windowManager?.setStatusVisible(next)
      rebuildMenu()
    },

    restartBackend: () => {
      // The status bar reports failures inline; the menu has no place to put
      // them, so surface them as a dialog instead of failing silently.
      void restartBackend().then((r) => {
        if (!r || r.ok) return
        dialog.showMessageBox(mainWindow ?? undefined!, {
          type: 'error',
          title: '重启后端服务失败',
          message: r.error ?? '未知错误',
          detail: `完整日志目录：${getLogDir()}`,
          buttons: ['确定'],
        })
      })
    },
    openLogs: () => {
      void shell.openPath(getLogDir())
    },

    openDiagnostics: () => {
      openDiagnosticsWindow()
    },

    describeEditor: () => describeEditorConfig(loadExternalEditor()),
    chooseEditor: () => {
      pickEditorInteractively(mainWindow)
      // The 设置 menu shows the current editor in its disabled hint line.
      rebuildMenu()
    },
  }
}

// ── App Lifecycle ──

app.whenReady().then(async () => {
  healthMonitor = new HealthMonitor()

  // The stream holds the tokenized backend URL, so its log lines pass through
  // redaction even though the stream itself only ever logs the origin: a future
  // message that interpolates the full URL must not become a token leak.
  dshStream = new DshStream({
    log: (message) => log('launcher', `[mux] ${redactTokenInText(message)}`),
  })

  // The sidebar. Both collaborators are late-bound on purpose: the managed
  // directory is only known after resolveWorkspace(), and the session list only
  // after the stream connects. Neither is available at construction time.
  sidebarService = new SidebarService({
    tree: new FileTree(),
    git: new GitService({ getManagedDir: () => workspaceDir || null }),
    getSuggestions: () =>
      (dshStream?.sessions() ?? [])
        .map((s) => s.cwd)
        .filter((d): d is string => typeof d === 'string' && d.length > 0),
    onChange: pushSidebarUpdate,
  })

  // All IPC lives in ipc-registry.ts now. main.ts had grown past 700 lines and
  // every new panel action meant touching it.
  teardownIpc = registerIpc({
    getWindowManager: () => windowManager,
    getHealthMonitor: () => healthMonitor,
    getStream: () => dshStream,
    getSidebar: () => sidebarService,
    getAppVersion: () => launcher?.version ?? app.getVersion(),
    restartBackend,
    getStatusInfo: statusInfo,
    quitApp,

    // Diagnostics. Every getter is late-bound and defensive: the self-check
    // window can be opened at any point in the boot sequence, including before
    // the workspace, the window or the health monitor exist — which is exactly
    // when someone needs to open it.
    getDiagnosticsHost: () => ({
      version: () => launcher?.version ?? app.getVersion(),
      dsh: statusInfo,
      workspace: () => workspaceDir,
      health: () => healthMonitor?.snapshot() ?? null,
      healthPhaseLabel: (phase: string) => PHASE_LABEL[phase as HealthPhase] ?? phase,
      // Content size, not window size: the self-check asks "can the user see
      // anything", and the chrome is not what goes missing.
      window: () => {
        const win = windowManager?.window
        if (!win) return null
        try {
          const [width, height] = win.getContentSize()
          return { width, height, visible: win.isVisible() }
        } catch {
          return null
        }
      },
      views: () => windowManager?.viewStates() ?? {},
    }),
  })

  setupMenu(buildMenuActions())

  // 1. Resolve the workspace (exe dir → source-dir.txt → userData fallback)
  const workspace = resolveWorkspace()
  // Gates the sidebar's write lock: everything under this directory is owned by
  // the auto-updater, which will `git reset --hard` it without asking.
  workspaceDir = workspace.dir
  log(
    'launcher',
    `workspace=${workspace.dir} existed=${workspace.existed} ` +
    `hasSource=${workspace.hasSource} deps=${workspace.depsInstalled} ` +
    `writable=${workspace.writable} needsWizard=${workspace.needsWizard}`
  )

  if (!workspace.writable) {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: '工作目录不可用',
      message: `无法在 ${workspace.dir} 创建/写入文件。\n\n请把本程序放到一个有写入权限的文件夹后重新运行。`,
      buttons: ['退出'],
    })
    quitApp()
    return
  }

  // 2. First run (no source yet) → initialization wizard
  if (workspace.needsWizard) {
    log('launcher', 'No source found — opening initialization wizard')
    const finished = await runWizard(workspace)
    if (!finished) {
      log('launcher', 'Wizard cancelled — quitting')
      quitApp()
      return
    }
    log('launcher', 'Wizard finished — starting app')
  }

  // 3. Splash + launch
  splashWindow = createSplash()
  launcher = new Launcher(workspace.dir)

  // Hook the backend process lifecycle into the health monitor BEFORE the
  // first spawn: a crash during startup must surface in the status bar, not
  // only in the (invisible) log file.
  launcher.onExit = (code) => {
    log('launcher', `health: backend exit ${code}`)
    healthMonitor?.noteExit(code)
  }
  launcher.onSpawnError = (message) => {
    log('launcher', `health: backend spawn error ${message}`)
    healthMonitor?.noteSpawnError(message)
  }

  splashWindow.webContents.once('did-finish-load', () => {
    splashWindow?.webContents.send('version', launcher!.version)
  })

  // Counted so the first attempt does not show up as "restarted once" in the
  // status bar: noteRestart() is only for genuine re-launches.
  let launchAttempt = 0

  async function doLaunch(): Promise<void> {
    try {
      launchAttempt += 1
      if (launchAttempt > 1) healthMonitor?.noteRestart()
      const result = await launcher!.launch((msg) => {
        splashWindow?.webContents.send('progress', msg)
      })
      healthMonitor?.noteReady()
      log('launcher', `backend ready on port ${result.port}`)
      mainWindow = createMainWindow(result.url)
      createTray(mainWindow, launcher!, quitApp)

      // Change review. Started after the window exists so its first snapshot
      // reaches a panel that is already listening; it fails soft, so a backend
      // without /api/events.mux costs the change list and nothing else.
      dshStream?.start(result.url)

      // Plugin market: ask once, install on request, stream progress into a
      // dedicated window, and report the outcome (success → restart to load;
      // failure → retry / logs). Runs after the main window is visible — it
      // is non-critical and can take minutes.
      void promptPluginMarket()
    } catch (err) {
      // Keep the health state honest even though the launch-error dialog is
      // what the user sees: a retry calls doLaunch() again, which resets it via
      // noteRestart().
      healthMonitor?.noteSpawnError((err as Error).message || String(err))
      showLaunchError(err as Error, doLaunch)
    }
  }

  await doLaunch()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    quitApp()
  }
})

// Safety net: whichever path quits, tear down the backend first.
app.on('before-quit', () => {
  launcher?.shutdown()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && launcher) {
    quitApp()
  }
})

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}
