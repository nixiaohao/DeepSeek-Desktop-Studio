/**
 * Launcher — the core startup module (workspace mode).
 *
 * Single flow after the wizard has initialized the workspace:
 *   git-check → fetch → reset/rebuild if updated → spawn dsh web → wait ready
 *
 * No dev mode, no hard-coded paths, no console windows. All child processes
 * run hidden; `--debug` flips windowsHide so real terminals appear.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { app } from 'electron'
import { RuntimeSource, type ProgressFn } from './runtime-source.js'
import { killPort, resolveNodeBin, buildPath, killProcessTree } from './env-detector.js'
import { log, appendChildOutput, getLogDir, isDebug } from './logging.js'
import { gitAvailable } from './env-check.js'

// ── Constants ──

/** Server ready poll timeout — increased for slow cold starts */
const SERVER_TIMEOUT_MS = 120_000

/** Port to kill stale processes on before starting */
const DEFAULT_PORT = 3080

// ── Result types ──

export interface LaunchResult {
  port: number
  version: string
  hadUpdate: boolean
}

// ── Launcher ──

export class Launcher {
  readonly sourceDir: string
  readonly runtimeSrc: RuntimeSource

  private backendProcess: ChildProcess | null = null
  private currentVersion = '0.0.0'
  /** URL with auth token printed by `dsh web` (newer harness versions). */
  private serverUrl = ''

  constructor(workspaceDir: string) {
    this.sourceDir = workspaceDir
    this.runtimeSrc = new RuntimeSource(workspaceDir)
    this.currentVersion = this.readShellVersion()
    log('launcher', `Launcher init, workspace=${workspaceDir}`)
  }

  /** Read the shell version from the app bundle (or workspace in dev). */
  private readShellVersion(): string {
    for (const p of [resolve(app.getAppPath(), 'package.json'), resolve(this.sourceDir, 'shell', 'package.json')]) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf-8'))
        if (pkg.version) return String(pkg.version)
      } catch { /* try next */ }
    }
    return '0.0.0'
  }

  /** Get the current HEAD commit hash (short) */
  private getHeadCommit(): string {
    return this.runtimeSrc.currentCommit()
  }

  /** Full version string: shellVer+commitHash */
  get version(): string {
    return `${this.currentVersion}+${this.getHeadCommit()}`
  }

  /** PATH for child processes: workspace node_modules/.bin + system PATH */
  private buildRuntimePath(): string {
    return buildPath(resolve(this.sourceDir, 'node_modules', '.bin'))
  }

  /**
   * Full launch sequence: update check (git-gated) → spawn server → wait.
   */
  async launch(reportProgress: ProgressFn): Promise<LaunchResult> {
    // Update path — git availability is checked inside ensureUpdated.
    let hadUpdate = false
    const update = await this.runtimeSrc.ensureUpdated(reportProgress)
    hadUpdate = update.updated
    if (update.skipped && update.reason) {
      log('launcher', `update skipped: ${update.reason}`)
    }

    // Dependencies gate — ZIP-copied workspaces (gitify failed / no git)
    // skip the update path entirely, so make sure node_modules exists
    // before booting raw source. See RuntimeSource.ensureReady.
    await this.runtimeSrc.ensureReady(reportProgress)

    // ── Common: kill stale port, spawn server, wait ready ──
    killPort(DEFAULT_PORT)
    const port = await findAvailablePort(DEFAULT_PORT)

    reportProgress('启动服务...')
    this.backendProcess = this.spawnDshWeb(port)

    reportProgress('等待服务就绪...')
    await this.waitForServer(`http://127.0.0.1:${port}`, SERVER_TIMEOUT_MS)

    return { port, version: this.version, hadUpdate }
  }

  /**
   * Manual "Check for updates" from the menu.
   * Applies the update in place; caller relaunches the app when updated=true.
   */
  async updateNow(reportProgress: ProgressFn = () => {}): Promise<{ updated: boolean; message: string }> {
    try {
      if (!gitAvailable()) {
        return { updated: false, message: '未检测到 git，无法检查更新。请安装 Git for Windows。' }
      }
      const hasUpdate = await this.runtimeSrc.checkUpdate(reportProgress)
      if (!hasUpdate) return { updated: false, message: '已是最新版本' }
      reportProgress('发现新版本，正在更新...')
      await this.runtimeSrc.applyUpdate(reportProgress)
      return { updated: true, message: '更新完成，正在重启应用...' }
    } catch (err) {
      return { updated: false, message: `更新失败：${(err as Error).message}` }
    }
  }

  /**
   * Spawn the dsh web server.
   * Runs the source via tsx with Node's --import hook (same as `pnpm dsh web`),
   * using a system node when available, or Electron's embedded Node otherwise.
   */
  private spawnDshWeb(port: number): ChildProcess {
    const cliEntry = resolve(this.sourceDir, 'apps', 'cli', 'src', 'bin.ts')
    const { path: nodeBin, useElectron } = resolveNodeBin()

    log('launcher', `Spawning dsh web: ${nodeBin} --import tsx/esm ${cliEntry} --profile web (electronNode=${useElectron})`)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: this.buildRuntimePath(),
      DSH_WEB_PORT: String(port),
    }
    if (useElectron) env.ELECTRON_RUN_AS_NODE = '1'

    const proc = spawn(nodeBin, [
      '--import', 'tsx/esm',
      cliEntry,
      '--profile', 'web',
      '--no-open',  // Electron window already loads the URL; suppress the
                    // harness's own browser-open behavior.
    ], {
      cwd: this.sourceDir,
      shell: false,
      env,
      windowsHide: !isDebug(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.serverUrl = ''
    let outBuf = ''
    proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString()
      appendChildOutput('backend', `[OUT] ${chunk}`)
      // Newer harness versions emit `dsh web: http://host:port/?token=...`.
      // Wait checks the plain port first, but if a token URL appears we must
      // use it: requests to the bare root will return 401 Unauthorized.
      outBuf += chunk
      if (!this.serverUrl) {
        const m = /dsh web:\s+(http:\/\/[^\s\r\n]+)/.exec(outBuf)
        if (m) {
          this.serverUrl = m[1].trim()
          log('launcher', `Captured dsh web URL: ${this.serverUrl}`)
        }
      }
      if (outBuf.length > 4096) outBuf = outBuf.slice(-4096)
    })
    proc.stderr?.on('data', (data: Buffer) => appendChildOutput('backend', `[ERR] ${data.toString()}`))
    proc.on('exit', (code) => log('launcher', `Backend process exited with code ${code}`))
    proc.on('error', (err) => log('launcher', `Backend process error: ${err.message}`))
    // Do NOT let the child handle keep the Electron main process alive:
    // without this, app.quit() can hang on the backend's stdio pipes and the
    // portable stub stays locked to the exe file.
    proc.unref()

    return proc
  }

  /** Skip update and start with existing source (network-failure fallback). */
  async skipUpdateAndStart(reportProgress: ProgressFn): Promise<LaunchResult> {
    reportProgress('跳过更新，使用已有版本启动...')
    await this.runtimeSrc.ensureReady(reportProgress)
    killPort(DEFAULT_PORT)
    const port = await findAvailablePort(DEFAULT_PORT)

    this.backendProcess = this.spawnDshWeb(port)

    reportProgress('等待服务就绪...')
    await this.waitForServer(`http://127.0.0.1:${port}`, SERVER_TIMEOUT_MS)

    return { port, version: this.version, hadUpdate: false }
  }

  /** Poll a URL until it responds 200 or timeout. Fails FAST when the
   *  backend process died — no more blind 120-second waits. */
  private async waitForServer(url: string, timeoutMs: number): Promise<void> {
    const start = Date.now()
    let lastError = ''
    // Newer dsh versions print a tokenized URL a few seconds after boot.
    // Wait briefly for that token before falling back to the bare URL.
    while (!this.serverUrl && Date.now() - start < 5000) {
      if (this.backendProcess && this.backendProcess.exitCode !== null) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const probeUrl = this.serverUrl || url
    while (Date.now() - start < timeoutMs) {
      if (this.backendProcess && this.backendProcess.exitCode !== null) {
        throw new Error(
          `后端进程已退出 (exit ${this.backendProcess.exitCode})。\n` +
          `最近日志（完整日志：${getLogDir()}\\backend.log）：\n` +
          this.recentBackendTail()
        )
      }
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3000)
        const resp = await fetch(probeUrl, { signal: controller.signal })
        clearTimeout(timer)
        if (resp.ok) {
          log('launcher', `Server ready at ${probeUrl}`)
          return
        }
        lastError = `HTTP ${resp.status}`
      } catch (e) {
        lastError = (e as Error).message
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    log('launcher', `Server NOT ready after ${timeoutMs}ms, last error: ${lastError}`)
    throw new Error(
      `服务在 ${timeoutMs / 1000} 秒内未就绪: ${probeUrl}\n最后错误: ${lastError}\n` +
      `完整日志：${getLogDir()}\\backend.log`
    )
  }

  /** Last lines of backend.log for error panels (reads the file tail). */
  private recentBackendTail(): string {
    try {
      const raw = readFileSync(resolve(getLogDir(), 'backend.log'), 'utf-8')
      return raw.split(/\r?\n/).slice(-20).join('\n')
    } catch {
      return '（暂无后端日志）'
    }
  }

  /**
   * Hard shutdown — synchronously kills the backend process TREE (not just the
   * direct child) and frees the port. No async timers: the caller can exit the
   * app immediately after, and no orphaned grandchildren keep file handles or
   * the port busy (which is what blocks overwriting the portable exe).
   */
  shutdown(): void {
    const proc = this.backendProcess
    this.backendProcess = null
    if (proc?.pid) {
      log('launcher', `Killing backend process tree (pid ${proc.pid})...`)
      try { killProcessTree(proc.pid) } catch { /* already dead */ }
    }
    killPort(DEFAULT_PORT)
  }
}

// ── Helpers ──

/** Find an available port starting from the given one */
async function findAvailablePort(startPort: number): Promise<number> {
  const { createServer } = await import('node:net')
  for (let port = startPort; port < startPort + 20; port++) {
    const available = await new Promise<boolean>((resolvePromise) => {
      const srv = createServer()
      srv.once('error', () => resolvePromise(false))
      srv.once('listening', () => { srv.close(() => resolvePromise(true)) })
      srv.listen(port, '127.0.0.1')
    })
    if (available) return port
  }
  return startPort
}
