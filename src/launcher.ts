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
 * How long the HTTP probe keeps trying to confirm readiness AFTER the
 * `dsh web:` URL line has been printed. The line is the authoritative signal,
 * so this is a bounded sanity check — not the thing the launch blocks on.
 */
const PROBE_CONFIRM_MS = 20_000

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

  /**
   * Fired when the backend process exits. `code` is null when it was killed by
   * a signal. Wired up by main.ts to drive the health monitor.
   */
  onExit: ((code: number | null) => void) | null = null

  /**
   * Fired when spawn() itself fails (ENOENT, EACCES, ...). The process never
   * ran, which is a different — and more definitive — failure than exiting
   * with a non-zero code.
   */
  onSpawnError: ((message: string) => void) | null = null

  private backendProcess: ChildProcess | null = null
  private currentVersion = '0.0.0'
  /** URL with auth token printed by `dsh web` (newer harness versions). */
  private serverUrl = ''
  /** Port the current backend is listening on (see restart()). */
  private currentPort = DEFAULT_PORT

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

  /** Port the running backend listens on; 3080 before the first launch. */
  get port(): number {
    return this.currentPort
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
   * Restart ONLY the backend process, without touching the source tree.
   *
   * Used by the status bar's 重启服务 action when the agent has died or is
   * spewing errors. Deliberately does not run an update check: a health
   * recovery path must not go to the network and must not `git reset --hard`
   * the workspace while the user may have work in progress.
   *
   * IMPORTANT FOR THE CALLER: the new process mints a NEW per-process token,
   * so the returned URL replaces the one currently loaded. The main window
   * MUST loadURL() it again or every request 401s into a white screen.
   *
   * A hard failure here is returned, not thrown: the user is looking at a
   * status bar telling them the agent died, and they need the reason there.
   */
  async restart(reportProgress: ProgressFn = () => {}): Promise<{ ok: boolean; url: string; error?: string }> {
    try {
      this.shutdown()
      killPort(DEFAULT_PORT)
      const port = await findAvailablePort(DEFAULT_PORT)

      reportProgress('重启后端服务...')
      this.backendProcess = this.spawnDshWeb(port)

      reportProgress('等待服务就绪...')
      const url = await this.waitForServer(`http://127.0.0.1:${port}`, SERVER_TIMEOUT_MS)
      return { ok: true, url }
    } catch (err) {
      const message = (err as Error).message
      log('launcher', `restart failed: ${message}`)
      return { ok: false, url: '', error: message }
    }
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
    this.currentPort = port

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
      // appendChildOutput() redacts internally (and covers stderr too), so the
      // raw chunk is safe to hand over here.
      appendChildOutput('backend', `[OUT] ${chunk}`)
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
    proc.on('exit', (code) => {
      log('launcher', `Backend process exited with code ${code}`)
      this.onExit?.(code)
    })
    proc.on('error', (err) => {
      log('launcher', `Backend process error: ${err.message}`)
      this.onSpawnError?.(err.message)
    })
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
   * Wait until the backend can serve the UI. Two phases, in order of
   * authority:
   *
   *  1. The `dsh web:` URL line. Upstream documents it as THE readiness
   *     signal ("The URL line and browser handoff are readiness signals ...
   *     both run only after the Loader tree settles and Connection
   *     authentication is available"), so it gets the full timeout budget.
   *     A short fixed window used to expire on slower machines, after which
   *     the probe fell back to a tokenless URL that dsh answers 401 forever.
   *  2. A short HTTP confirmation. It must not gate the launch for minutes
   *     when the documented signal has already arrived.
   *
   * Fails immediately when the backend process died — no blind 120s waits.
   *
   * Returns the URL to hand to the browser window (the tokenized one when
   * available, so the server can mint its session cookie).
   */
  private async waitForServer(url: string, timeoutMs: number): Promise<string> {
    const start = Date.now()
    let lastError = ''

    const deadTail = (): string =>
      `后端进程已退出 (exit ${this.backendProcess?.exitCode})。\n` +
      `最近日志（完整日志：${getLogDir()}\\backend.log）：\n` +
      this.recentBackendTail()

    // Phase 1 — the printed URL line is the authoritative signal.
    while (!this.serverUrl && Date.now() - start < timeoutMs) {
      if (this.backendProcess && this.backendProcess.exitCode !== null) {
        throw new Error(deadTail())
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    const probeUrl = this.serverUrl || url
    if (!this.serverUrl) {
      log('launcher', `No tokenized URL line seen within ${timeoutMs}ms; probing ${redactToken(url)} directly`)
    }

    // Phase 2 — confirm over HTTP, but only for a bounded window.
    const confirmDeadline = Date.now() + PROBE_CONFIRM_MS
    while (Date.now() < confirmDeadline) {
      if (this.backendProcess && this.backendProcess.exitCode !== null) {
        throw new Error(deadTail())
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
      await new Promise((r) => setTimeout(r, 500))
    }

    // The line was printed but HTTP never confirmed it. Upstream treats the
    // line as the readiness signal, so continuing is the documented behavior —
    // blocking here for minutes on a probe that cannot succeed is what made
    // the app look broken. Record it loudly for diagnosis.
    log(
      'launcher',
      `URL line seen but HTTP probe never confirmed within ${PROBE_CONFIRM_MS}ms ` +
      `(last error: ${lastError}); continuing on the printed URL ${redactToken(probeUrl)}`,
    )
    return probeUrl
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
    // Free the port the backend actually used, which is not necessarily
    // DEFAULT_PORT when 3080 was already taken at launch time.
    killPort(this.currentPort)
    if (this.currentPort !== DEFAULT_PORT) killPort(DEFAULT_PORT)
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

// `redactTokenInText()` now lives in logging.ts and is applied inside
// appendChildOutput(), so BOTH stdout and stderr are covered. Previously only
// the stdout call site redacted it, leaving stderr raw.

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
