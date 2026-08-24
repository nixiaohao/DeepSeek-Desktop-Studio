/**
 * main.ts — Electron main process entry point.
 * Flow: Wizard (first run only) → Splash → Launcher (update + start backend)
 *       → BrowserWindow with theme.
 *
 * Error visibility: every failure lands in %APPDATA%\deepseek-studio\logs\
 * and surfaces through dialogs with 「打开日志文件夹」/「重试」actions.
 * `--debug` (or DSH_DEBUG=1) shows real child-process terminals.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { Launcher } from './launcher.js'
import { loadCurrentThemeCSS, listThemes } from './theme.js'
import { loadPreferences, savePreferences } from './preferences.js'
import { createTray, destroyTray } from './tray.js'
import { setupMenu } from './menu.js'
import { resolveWorkspace } from './workspace.js'
import { runWizard } from './wizard.js'
import { log, getLogDir, isDebug } from './logging.js'
import { relaunchApp } from './relaunch.js'

// ── Startup hardening (must run before app ready) ──
// 1. GPU 加速在虚拟机/远程桌面/部分驱动上会导致白屏或启动崩溃，本应用为 Web UI 外壳，无需 GPU。
// 2. 受管/加固环境（EDR、AppLocker、终端安全策略等）常拦截 Chromium 沙箱子进程
//    （restricted token + job object），导致主进程卡在启动、whenReady 永不触发；
//    本应用本质是执行任意 agent 代码的外壳，关闭沙箱不引入额外风险面，换取此类环境兼容性。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')

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
    },
  })
  splash.loadFile(join(app.getAppPath(), 'assets', 'splash.html'))
  splash.center()
  return splash
}

// ── Main Window ──

function createMainWindow(port: number): BrowserWindow {
  const prefs = loadPreferences()
  const win = new BrowserWindow({
    width: prefs.windowBounds.width,
    height: prefs.windowBounds.height,
    x: prefs.windowBounds.x,
    y: prefs.windowBounds.y,
    minWidth: 1024,
    minHeight: 680,
    title: 'DeepSeek Studio',
    // Windows uses the multi-resolution .ico; Linux/macOS need .png.
    icon: join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Inject theme CSS after page loads
  const themeCSS = loadCurrentThemeCSS()
  if (themeCSS) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.insertCSS(themeCSS)
    })
  }

  win.loadURL(`http://127.0.0.1:${port}`)

  win.once('ready-to-show', () => {
    splashWindow?.close()
    splashWindow = null
    win.show()
  })

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
    launcher?.shutdown()
    destroyTray()
  })

  return win
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

// ── IPC Handlers ──

function setupIPC() {
  ipcMain.on('switch-theme', (event, themeId: string) => {
    savePreferences({ themeId })
    if (mainWindow) {
      const css = loadCurrentThemeCSS()
      mainWindow.webContents.reload()
      mainWindow.webContents.once('did-finish-load', () => {
        if (css) mainWindow!.webContents.insertCSS(css)
      })
    }
  })

  ipcMain.handle('get-themes', () => listThemes())
  ipcMain.handle('get-version', () => launcher?.version ?? 'unknown')

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
    quitApp()
  })
}

// ── App Lifecycle ──

app.whenReady().then(async () => {
  setupMenu(
    () => {
      void handleCheckUpdate()
    },
    () => {
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
    () => {
      showAboutDialog()
    }
  )
  setupIPC()

  // 1. Resolve the workspace (exe dir → source-dir.txt → userData fallback)
  const workspace = resolveWorkspace()
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
  splashWindow.webContents.once('did-finish-load', () => {
    splashWindow?.webContents.send('version', launcher!.version)
  })

  async function doLaunch(): Promise<void> {
    try {
      const result = await launcher!.launch((msg) => {
        splashWindow?.webContents.send('progress', msg)
      })
      mainWindow = createMainWindow(result.port)
      createTray(mainWindow, launcher!, quitApp)

      // Plugin market: ask once, install on request, stream progress into a
      // dedicated window, and report the outcome (success → restart to load;
      // failure → retry / logs). Runs after the main window is visible — it
      // is non-critical and can take minutes.
      void promptPluginMarket()
    } catch (err) {
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
