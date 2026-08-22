/**
 * wizard.ts — First-run initialization wizard (main-process controller).
 *
 * Shows when the workspace has no harness source yet. Guides the user
 * through: workspace location → environment check → source choice
 * (GitHub clone / ZIP copy) → readiness (install/build/plugin market).
 *
 * All long operations run in the main process; progress streams to the
 * page via `wizard:progress`. Resolves true when the user finishes.
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { getExeDir, type WorkspaceInfo } from './workspace.js'
import { checkEnvironment } from './env-check.js'
import { RuntimeSource } from './runtime-source.js'
import { log, getLogDir } from './logging.js'

let win: BrowserWindow | null = null

/** Resolves with true when the wizard finished successfully. */
export async function runWizard(workspace: WorkspaceInfo): Promise<boolean> {
  const src = new RuntimeSource(workspace.dir)

  win = new BrowserWindow({
    width: 700,
    height: 780,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })
  win.loadFile(join(app.getAppPath(), 'assets', 'wizard.html'))
  win.once('ready-to-show', () => win?.show())
  win.center()
  win.on('closed', () => { win = null })

  const emitProgress = (phase: string, message: string): void => {
    log('wizard', `[${phase}] ${message}`)
    win?.webContents.send('wizard:progress', { phase, message })
  }

  const checkGithubReachable = async (): Promise<boolean> => {
    try {
      const c = new AbortController()
      const t = setTimeout(() => c.abort(), 8000)
      const r = await fetch('https://api.github.com/zen', { signal: c.signal })
      clearTimeout(t)
      return r.ok
    } catch {
      return false
    }
  }

  // ── IPC handlers (named for clean removal) ──
  const hGetState = () => ({ workspace, env: checkEnvironment() })
  const hCheckNetwork = async () => ({ ok: await checkGithubReachable() })
  const hClone = async () => {
    try {
      await src.cloneTo((m) => emitProgress('clone', m))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
  const hVerifyZip = () => src.verifyZipDir()
  const hGitify = async () => ({ ok: await src.gitify((m) => emitProgress('gitify', m)) })
  const hReady = async () => {
    try {
      await src.ready((m) => emitProgress('ready', m))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
  const hOpenLogs = () => shell.openPath(getLogDir())
  const hOpenWorkspace = () => shell.openPath(workspace.dir)
  const hOpenExeDir = () => shell.openPath(getExeDir())
  // Closing the wizard window is mandatory: runWizard() resolves only after
  // this handler fires, and the caller (main.ts) immediately creates the splash
  // + main window. If the wizard BrowserWindow survives, it stays on top of the
  // app forever ("向导关不掉"). settle() is idempotent (guarded by `settled`),
  // so the `closed` -> settle(false) listener that fires after win.close() is a
  // harmless no-op.
  const hDone = () => { cleanup(); settle(true); win?.close() }
  const hCancel = () => { cleanup(); settle(false); win?.close() }

  let resolveResult!: (v: boolean) => void
  let settled = false
  const result = new Promise<boolean>((r) => { resolveResult = r })

  const settle = (v: boolean): void => {
    if (settled) return
    settled = true
    resolveResult(v)
  }

  win.on('closed', () => {
    settle(false) // window closed by OS/Alt+F4 → treat as cancel
  })

  ipcMain.handle('wizard:get-state', hGetState)
  ipcMain.handle('wizard:check-network', hCheckNetwork)
  ipcMain.handle('wizard:clone', hClone)
  ipcMain.handle('wizard:verify-zip', hVerifyZip)
  ipcMain.handle('wizard:gitify', hGitify)
  ipcMain.handle('wizard:ready', hReady)
  ipcMain.handle('wizard:open-logs', hOpenLogs)
  ipcMain.handle('wizard:open-workspace', hOpenWorkspace)
  ipcMain.handle('wizard:open-exe-dir', hOpenExeDir)
  ipcMain.on('wizard:done', hDone)
  ipcMain.on('wizard:cancel', hCancel)

  function cleanup(): void {
    for (const ch of [
      'wizard:get-state', 'wizard:check-network', 'wizard:clone', 'wizard:verify-zip',
      'wizard:gitify', 'wizard:ready', 'wizard:open-logs', 'wizard:open-workspace',
      'wizard:open-exe-dir',
    ]) {
      try { ipcMain.removeHandler(ch) } catch { /* ignore */ }
    }
    ipcMain.removeListener('wizard:done', hDone)
    ipcMain.removeListener('wizard:cancel', hCancel)
  }

  return result
}
