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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { app } from 'electron'
import { RuntimeSource, type ProgressFn } from './runtime-source.js'
import { killPort, resolveNodeBin, buildPath, killProcessTree } from './env-detector.js'
import { log, appendChildOutput, getLogDir, isDebug } from './logging.js'
import { gitAvailable } from './env-check.js'

// ── Constants ──

/** Server ready poll timeout — increased for slow cold starts */
const SERVER_TIMEOUT_MS = 120_000

/**
 * How long to wait for the tokenized URL before falling back to a tokenless
 * probe. Must exceed the slowest boot path (tsx source ≈ 6.2s), otherwise the
 * probe runs against `/` without a token and only ever gets 401.
 */
const TOKEN_WAIT_MS = 20_000

/** Port to kill stale processes on before starting */
const DEFAULT_PORT = 3080

// ── Result types ──

export interface LaunchResult {
  port: number
  /**
   * URL the main window must load. Newer harness versions hand out a
   * per-process token (`/?token=...`) and answer a tokenless `/` with 401,
   * so the window needs the same authenticated URL the readiness probe used.
   */
  url: string
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
    const readyUrl = await this.waitForServer(`http://127.0.0.1:${port}`, SERVER_TIMEOUT_MS)

    return { port, url: readyUrl, version: this.version, hadUpdate }
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
  /**
   * Choose how the harness CLI is booted.
   *
   * Upstream ships two entries (see `apps/cli/package.json`):
   *   - `bin.dsh` -> `lib/bin.js`                    ← built output, the supported entry
   *   - root script `dsh` -> `node --import tsx/esm apps/cli/src/bin.ts` ← dev entry
   *
   * We used to always take the dev entry, which makes tsx transpile the whole
   * TypeScript graph on every single launch: measured 6.2s to the first
   * request versus 3.3s for the built bin, plus a runtime dependency on tsx.
   * Prefer the built bin; fall back to source when it is missing or stale.
   */
  private resolveCliArgs(): string[] {
    const built = resolve(this.sourceDir, 'apps', 'cli', 'lib', 'bin.js')
    const source = resolve(this.sourceDir, 'apps', 'cli', 'src', 'bin.ts')
    const profile = ['--profile', 'web']
    // Electron window already loads the URL; suppress the harness's own
    // browser-open behavior.
    const noOpen = ['--no-open']
    if (this.builtCliIsUsable(built, source)) return [built, ...profile, ...noOpen]
    return ['--import', 'tsx/esm', source, ...profile, ...noOpen]
  }

  /**
   * Whether the built CLI entry can be trusted.
   *
   * `apps/cli/lib` is gitignored, so `git reset --hard` to a newer commit
   * leaves the PREVIOUS build in place — booting it would silently run stale
   * code. Git sets the mtime of every checked-out file, so a source file newer
   * than the built entry means "rebuilt not yet done": fall back to source
   * (which tsx compiles from the current tree) for that one launch. The next
   * launch picks the rebuilt bin up.
   */
  private builtCliIsUsable(built: string, source: string): boolean {
    if (!existsSync(built)) return false
    try {
      if (!existsSync(source)) return true
      return statSync(built).mtimeMs >= statSync(source).mtimeMs
    } catch {
      return false
    }
  }

  private spawnDshWeb(port: number): ChildProcess {
    const { path: nodeBin, useElectron } = resolveNodeBin()
    const args = this.resolveCliArgs()

    log('launcher', `Spawning dsh web: ${nodeBin} ${args.join(' ')} (electronNode=${useElectron})`)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: this.buildRuntimePath(),
      DSH_WEB_PORT: String(port),
    }
    if (useElectron) env.ELECTRON_RUN_AS_NODE = '1'

    const proc = spawn(nodeBin, args, {
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
      // The readiness URL carries a live credential; keep it out of backend.log.
      appendChildOutput('backend', `[OUT] ${redactTokenInText(chunk)}`)
      // Newer harness versions emit `dsh web: http://host:port/?token=...`.
      // stdout arrives in arbitrary chunks: a naive regex on the buffer can
      // match a truncated token (e.g. the first chunk ends mid-token), which
      // then fails authentication and returns 401. Only search complete lines
      // and keep the still-incomplete tail in the buffer for the next chunk.
      outBuf += chunk
      if (!this.serverUrl) {
        const lines = outBuf.split(/\r?\n/)
        for (let i = 0; i < lines.length - 1; i++) {
          const m = /dsh web:\s+(http:\/\/[^\s\r\n]+)/.exec(lines[i])
          if (m) {
            this.serverUrl = m[1].trim()
            // Log the origin only: the token grants access to the local web UI
            // and must never reach disk.
            log('launcher', `Captured dsh web URL: ${redactToken(this.serverUrl)}`)
            break
          }
        }
      }
      if (outBuf.length > 8192) outBuf = outBuf.slice(-8192)
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
    const readyUrl = await this.waitForServer(`http://127.0.0.1:${port}`, SERVER_TIMEOUT_MS)

    return { port, url: readyUrl, version: this.version, hadUpdate: false }
  }

  /**
   * Poll a URL until it responds 200 or timeout. Fails FAST when the
   * backend process died — no more blind 120-second waits.
   *
   * Returns the URL that answered, so the caller can hand the same
   * authenticated URL to the browser window.
   */
  private async waitForServer(url: string, timeoutMs: number): Promise<string> {
    const start = Date.now()
    let lastError = ''
    // Newer dsh versions print a tokenized URL a few seconds after boot.
    // The wait must cover the SLOWEST supported boot path: the built bin
    // prints the URL at ~3.3s, but the tsx source fallback needs ~6.2s. A
    // 5s window silently missed it and left the probe hitting a tokenless
    // URL, which dsh answers 401 forever.
    while (!this.serverUrl && Date.now() - start < TOKEN_WAIT_MS) {
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
        // `redirect: 'manual'` is REQUIRED, not cosmetic.
        //
        // dsh answers a token-bearing GET with 303 + Set-Cookie and expects
        // the client to replay that cookie on "/". Node's fetch (undici) keeps
        // no cookie jar, so a default fetch follows the 303 to "/" with no
        // cookie and gets 401 — the probe could never see a 200 no matter how
        // valid the token was. (Measured: default -> 401, manual -> 303.)
        //
        // With manual redirect the 303 IS the success signal: it proves the
        // token was accepted and the session cookie minted. Harness versions
        // without token auth answer 200 instead, so accept anything < 400.
        const resp = await fetch(probeUrl, {
          signal: controller.signal,
          redirect: 'manual',
        })
        clearTimeout(timer)
        const status = resp.status
        // Drain the body so the socket is not left half-open between polls.
        await resp.arrayBuffer().catch(() => {})
        if (status < 400) {
          // Never persist the token: it grants access to the local web UI.
          log('launcher', `Server ready at ${redactToken(probeUrl)} (HTTP ${status})`)
          return probeUrl
        }
        lastError = `HTTP ${status}`
      } catch (e) {
        lastError = (e as Error).message
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    log('launcher', `Server NOT ready after ${timeoutMs}ms, last error: ${lastError}`)
    throw new Error(
      `服务在 ${timeoutMs / 1000} 秒内未就绪: ${redactToken(probeUrl)}\n最后错误: ${lastError}\n` +
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

/**
 * Mask the per-process web token before a URL reaches a log file or an error
 * dialog.
 *
 * `dsh web` mints a fresh token with crypto.randomBytes on every launch and
 * keeps it only in memory, so it is not a durable secret — but it is a live
 * credential for the local web UI, and logs live in the user's AppData where
 * other processes (and the user when sharing logs for support) can read them.
 * Never write it out.
 */
function redactToken(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '***')
    return parsed.href
  } catch {
    return url
  }
}

/**
 * Mask `token=<value>` parameters in free-form child-process output before it
 * is appended to backend.log. The harness prints its authenticated URL there,
 * and that log is the one users send along with a bug report.
 */
function redactTokenInText(text: string): string {
  return text.replace(/(token=)[A-Za-z0-9_-]+/gu, '$1***')
}

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
