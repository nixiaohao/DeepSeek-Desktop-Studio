/**
 * runtime-source.ts — Manages the official harness source in a user-owned
 * workspace directory (resolved by workspace.ts; never hard-coded).
 *
 * Responsibilities:
 *   - cloneTo():     clone the official repo (system git first,
 *                    isomorphic-git fallback) — first-run GitHub path
 *   - verifyZipDir():validate a user-copied ZIP extraction (layer check)
 *   - gitify():      attach a ZIP-copied dir to git so updates unify
 *   - ready():       full first-run readiness: install → build → plugin market
 *   - ensureUpdated():fetch → detect → reset → reinstall/rebuild when changed
 *
 * Timeouts (deliberately generous for slow networks / cold starts):
 *   fetch    120s | clone 15min | install 30min | build 30min
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join, dirname, isAbsolute, resolve as pathResolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  detectGit,
  detectPnpm,
  resolveNodeBin,
  buildPath,
  type ToolInfo,
} from './env-detector.js'
import { appendChildOutput, getLogDir, isDebug, log, type LogName } from './logging.js'

const REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'
const BRANCH = 'master'
/**
 * Official community plugin market (installed on user request).
 *
 * MUST be the npm-registry package `dshmarket`, NOT the git spec
 * `github:dsh-market/dsh-market`:
 *   - `dshmarket` is published to registry.npmjs.org (latest 1.16.x).
 *   - Its only lifecycle script is `prepare`, which npm/pnpm run for GIT
 *     dependencies but NOT for registry tarballs — so installing from the
 *     registry needs no `allowBuilds`/`onlyBuiltDependencies` policy, which
 *     is exactly what made the old git spec fail on pnpm ≥10/11 (build
 *     scripts of git deps are blocked until allowlisted).
 *   - The README's own install command is `dsh plugin --profile web add dshmarket`.
 */
const MARKET_PKG = 'dshmarket'

/** Build script reads this env var before falling back to `git rev-parse HEAD`. */
const CLIENT_COMMIT_HASH_VAR = 'DSH_CLIENT_COMMIT_HASH'

const LOCK_HASH_FILE = 'lock-hash.txt'
const FETCH_TIMEOUT_MS = 120_000
const CLONE_TIMEOUT_MS = 15 * 60_000
const INSTALL_TIMEOUT_MS = 30 * 60_000
const BUILD_TIMEOUT_MS = 30 * 60_000
const MARKET_TIMEOUT_MS = 10 * 60_000

export type ProgressFn = (msg: string) => void

export interface UpdateResult {
  updated: boolean
  /** True when the update was skipped (no git / network failure) */
  skipped: boolean
  reason?: string
}

export class RuntimeSource {
  readonly dir: string
  private git: ToolInfo | null = null
  private gitChecked = false

  constructor(dir: string) {
    this.dir = dir
  }

  /** Whether a git working copy already exists (.git present) */
  get exists(): boolean {
    return existsSync(join(this.dir, '.git'))
  }

  /** True when the local branch has at least one commit (HEAD resolves). */
  private hasLocalCommit(): boolean {
    if (!this.exists) return false
    const git = this.getGit()
    if (!git) return false
    try {
      execFileSync(git.path, ['rev-parse', '--verify', 'HEAD'], {
        cwd: this.dir,
        encoding: 'utf-8',
        timeout: 15_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Detect the actual remote name configured in this repo. ZIP-initialized
   * repos use `origin`, but older versions of this shell created remotes
   * named `upstream`; cloning always names the remote `origin`.
   */
  private remoteName(): string {
    const git = this.getGit()
    if (!git) return 'origin'
    try {
      const out = execFileSync(git.path, ['remote'], {
        cwd: this.dir,
        encoding: 'utf-8',
        timeout: 15_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      const first = out.split(/\s+/).find((r) => r.length > 0)
      if (first) return first
    } catch { /* fallthrough to default */ }
    return 'origin'
  }

  /**
   * Ensure the local branch points to the fetched remote branch.
   * This is required for ZIP-initialized repos where `git init` created
   * an empty local branch but the remote has commits.
   *
   * Uses `reset --hard` (not `checkout -B`) because ZIP-extracted untracked
   * files would otherwise conflict with checkout ("would be overwritten by
   * checkout"). reset --hard skips that check — it only touches tracked
   * files and leaves untracked ones alone.
   *
   * Safe to call BEFORE fetch: silently no-ops when the remote branch does
   * not exist yet. Always call again AFTER a successful fetch so the freshly
   * pulled remote ref can be attached.
   */
  private attachToRemoteBranch(): void {
    if (!this.exists || this.hasLocalCommit()) return
    const git = this.getGit()
    if (!git) return
    const remote = this.remoteName()
    const ref = `${remote}/${BRANCH}`
    try {
      // Skip when the remote ref isn't present yet (caller should re-run
      // this after a successful fetch).
      execFileSync(git.path, ['rev-parse', '--verify', '--quiet', ref], {
        cwd: this.dir,
        encoding: 'utf-8',
        timeout: 15_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return
    }
    try {
      execFileSync(git.path, ['reset', '--hard', ref], {
        cwd: this.dir,
        encoding: 'utf-8',
        timeout: 60_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer; message: string }
      const detail = (e.stderr?.toString() || e.stdout?.toString() || e.message).slice(-300)
      throw new Error(`无法将本地分支指向 ${ref}：${detail}`)
    }
  }

  /**
   * Build scripts call `git rev-parse HEAD` to embed a commit hash into client
   * artifacts. ZIP-copied workspaces may have an empty local branch with no
   * HEAD, which would crash the build. We inject a stable hash into the
   * environment so the build can proceed without a real Git commit.
   */
  /**
   * Ensure DSH_CLIENT_COMMIT_HASH is populated in process.env before the build
   * runs. The harness build script reads this env var and treats an empty value
   * as "no commit" — it does NOT fall back to `git rev-parse HEAD` reliably in
   * the spawned child, so we must inject a real hash here.
   *
   * Order: real git HEAD → lock-hash.txt → deterministic package.version hash.
   * The git branch previously just `return`ed when rev-parse succeeded, leaving
   * the env var empty and crashing the build with `got ""` — now it writes the
   * resolved hash explicitly.
   */
  private ensureBuildCommitHash(): void {
    if (process.env[CLIENT_COMMIT_HASH_VAR]) return
    const git = this.getGit()
    if (git) {
      try {
        const out = execFileSync(git.path, ['rev-parse', 'HEAD'], {
          cwd: this.dir,
          encoding: 'utf-8',
          timeout: 15_000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        if (/^[0-9a-f]{7,40}$/i.test(out)) {
          process.env[CLIENT_COMMIT_HASH_VAR] = out
          return
        }
      } catch { /* no HEAD — inject fallback */ }
    }
    // Fallback 1: lock-hash.txt (SHA-1 of pnpm-lock.yaml written after install)
    try {
      const hash = readFileSync(this.hashFile(), 'utf-8').trim()
      if (/^[0-9a-f]{40}$/i.test(hash)) {
        process.env[CLIENT_COMMIT_HASH_VAR] = hash
        return
      }
    } catch { /* fallthrough */ }
    // Fallback 2: deterministic hash from package.json name+version
    try {
      const pkg = JSON.parse(readFileSync(join(this.dir, 'package.json'), 'utf-8')) as {
        name?: string
        version?: string
      }
      const seed = `${pkg.name ?? 'deepseek-harness'}@${pkg.version ?? '0.0.0'}`
      process.env[
        CLIENT_COMMIT_HASH_VAR
      ] = createHash('sha1').update(seed).digest('hex')
    } catch { /* best-effort */ }
  }

  // ── git resolution ──

  /**
   * Remove stale git lock files that block all fetch operations.
   * A crashed/interrupted `git fetch --depth 1` leaves `.git/shallow.lock`
   * behind; every subsequent fetch then fails with
   * "fatal: 无法创建 '.git/shallow.lock'：文件已存在" — the app silently
   * falls back to the old (possibly inconsistent) clone and never recovers.
   *
   * Called before every fetch attempt (checkUpdate, gitify, rollback).
   */
  private removeStaleLocks(): void {
    const lockFile = join(this.dir, '.git', 'shallow.lock')
    try {
      if (existsSync(lockFile)) {
        rmSync(lockFile, { force: true })
        log('launcher', `removeStaleLocks: removed stale ${lockFile}`)
      }
    } catch { /* best-effort */ }
  }

  private getGit(): ToolInfo | null {
    if (!this.gitChecked) {
      this.git = detectGit()
      this.gitChecked = true
    }
    return this.git
  }

  /** Sync git helper. Always captures output (never inherits a console). */
  private gitSync(args: string[], opts: { timeoutMs?: number } = {}): string {
    const git = this.getGit()
    if (!git) throw new Error('未检测到 git，无法执行此操作')
    try {
      return execFileSync(git.path, args, {
        cwd: this.dir,
        encoding: 'utf-8',
        timeout: opts.timeoutMs ?? 60_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const e = err as { stderr?: Buffer; message: string }
      const detail = e.stderr ? e.stderr.toString().slice(-300) : e.message
      throw new Error(`git ${args[0] ?? ''} 失败：${detail}`)
    }
  }

  /**
   * Async command runner. Windows .cmd/.bat bins need a shell; everything
   * else runs directly. All child processes are hidden (no terminal flash);
   * raw output goes to the given log file, progress via callback.
   */
  private runAsync(
    bin: string,
    args: string[],
    opts: {
      cwd?: string
      timeoutMs?: number
      env?: NodeJS.ProcessEnv
      logName?: LogName
    } = {}
  ): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const cwd = opts.cwd ?? this.dir
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
      const proc: ChildProcess = spawn(bin, args, {
        cwd,
        env: {
          ...process.env,
          PATH: buildPath(join(this.dir, 'node_modules', '.bin')),
          ...opts.env,
        },
        shell: useShell,
        windowsHide: !isDebug(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      const logName: LogName = opts.logName ?? 'wizard'
      proc.stdout?.on('data', (d: Buffer) => appendChildOutput(logName, d.toString()))
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString()
        appendChildOutput(logName, d.toString())
      })
      const timer = opts.timeoutMs ? setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs) : null
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer)
        reject(err)
      })
      proc.on('exit', (code) => {
        if (timer) clearTimeout(timer)
        if (code === 0) resolvePromise()
        else reject(new Error(`命令执行失败 (exit ${code}): ${stderr.slice(-400)}`))
      })
    })
  }

  /**
   * Resolve the bundled @pnpm/exe standalone script.
   * @pnpm/exe does NOT ship a pnpm.exe; the real executable is dist/pnpm.mjs
   * and must be invoked as `node <pnpm.mjs> <args>`.
   */
  private resolveBundledPnpm(): string | null {
    try {
      const req = createRequire(__filename)
      let root: string
      try {
        root = dirname(req.resolve('@pnpm/exe/package.json'))
      } catch {
        root = dirname(req.resolve('@pnpm/exe'))
      }
      // electron-builder unpacks native/executable deps to app.asar.unpacked;
      // require.resolve returns the asar path, but spawned scripts need the
      // real filesystem path.
      if (root.includes('app.asar') && !root.includes('app.asar.unpacked')) {
        root = root.replace('app.asar', 'app.asar.unpacked')
      }
      const mjs = join(root, 'dist', 'pnpm.mjs')
      if (existsSync(mjs)) return mjs
    } catch { /* @pnpm/exe not bundled */ }
    return null
  }

  /** Resolved pnpm binary: bundled @pnpm/exe first, then system pnpm. */
  private resolvePnpmBin(): string | null {
    const bundled = this.resolveBundledPnpm()
    if (bundled) return bundled
    const sys = detectPnpm()
    return sys.found ? sys.path : null
  }

  /**
   * Copy the bundled pnpm.mjs into the workspace so wrapper scripts can point
   * at a persistent filesystem path. Electron portable executables unpack to a
   * temp directory that is invalidated when the app restarts; hard-coding that
   * temp path in a wrapper leaves it broken on the next launch.
   *
   * Returns the persistent path, or null when the bundled pnpm is unavailable.
   */
  private ensureBundledPnpmInWorkspace(): string | null {
    const bundled = this.resolveBundledPnpm()
    if (!bundled) return null
    const targetDir = join(this.dir, '.dsh')
    const target = join(targetDir, 'pnpm.mjs')
    try {
      mkdirSync(targetDir, { recursive: true })
      let needCopy = !existsSync(target)
      if (!needCopy) {
        const srcHash = createHash('sha256').update(readFileSync(bundled)).digest('hex')
        const tgtHash = createHash('sha256').update(readFileSync(target)).digest('hex')
        needCopy = srcHash !== tgtHash
      }
      if (needCopy) {
        writeFileSync(target, readFileSync(bundled))
      }
      return target
    } catch {
      return null
    }
  }

  private async runPnpm(args: string[], progress: ProgressFn, failLabel: string): Promise<void> {
    const bundled = this.resolveBundledPnpm()
    if (bundled) {
      const node = resolveNodeBin()
      progress('使用内置 pnpm 安装/构建...')
      await this.runAsync(
        node.path,
        [bundled, ...args],
        { cwd: this.dir, timeoutMs: INSTALL_TIMEOUT_MS, logName: 'wizard' }
      )
      return
    }
    const sys = detectPnpm()
    if (!sys.found) throw new Error(`未找到 pnpm，无法${failLabel}。请安装 pnpm 后重试。`)
    await this.runAsync(sys.path, args, { cwd: this.dir, timeoutMs: INSTALL_TIMEOUT_MS, logName: 'wizard' })
  }

  // ── isomorphic-git fallback ──

  private async gitIso() {
    const gitMod = await import('isomorphic-git')
    const httpMod = await import('isomorphic-git/http/node')
    const git = (gitMod as unknown as { default?: typeof gitMod }).default ?? gitMod
    const http = (httpMod as unknown as { default?: typeof httpMod }).default ?? httpMod
    const fs = await import('node:fs')
    return { git, http, fs: fs.promises }
  }

  // ── Clone (GitHub first-run path) ──

  /** Clone the official repo into this.dir. Throws on failure. */
  async cloneTo(progress: ProgressFn): Promise<void> {
    if (this.exists) return
    mkdirSync(this.dir, { recursive: true })
    const parent = dirname(this.dir)

    const git = this.getGit()
    if (git) {
      progress('从 GitHub 拉取官方源码（浅克隆，可能需要几分钟）...')
      try {
        await this.runAsync(
          git.path,
          ['clone', '--depth', '1', '--branch', BRANCH, '--single-branch', REPO_URL, this.dir],
          { cwd: parent, timeoutMs: CLONE_TIMEOUT_MS, logName: 'wizard' }
        )
        this.setLockHash('') // force dependency install on first run
        return
      } catch (err) {
        progress(`git clone 失败（${(err as Error).message.slice(0, 100)}），改用内置克隆器...`)
      }
    } else {
      progress('未检测到系统 git，使用内置克隆器拉取源码（较慢）...')
    }

    try {
      const { git: iso, http, fs } = await this.gitIso()
      await iso.clone({
        fs,
        http,
        dir: this.dir,
        url: REPO_URL,
        ref: BRANCH,
        singleBranch: true,
        depth: 1,
        noCheckout: false,
      })
      this.setLockHash('')
    } catch (err) {
      throw new Error(
        `无法从 GitHub 拉取官方源码。\n\n${(err as Error).message}\n\n请检查网络后重试，或改用 ZIP 方式。`
      )
    }
  }

  // ── ZIP validation & git-ification ──

  /**
   * Validate a user-copied ZIP extraction. Guards the most common mistake:
   * copying the OUTER wrapper folder (deepseek-harness-master/) into the
   * workspace instead of its contents.
   */
  verifyZipDir(): { ok: boolean; errors: string[] } {
    const errors: string[] = []
    if (!existsSync(this.dir)) {
      errors.push('工作目录不存在')
    } else {
      if (!existsSync(join(this.dir, 'package.json'))) {
        errors.push('缺少根目录 package.json —— 请确认复制的是解压后的仓库内容（不是外层文件夹 deepseek-harness-master）')
      }
      if (!existsSync(join(this.dir, 'pnpm-workspace.yaml'))) {
        errors.push('缺少 pnpm-workspace.yaml —— 目录内容不完整')
      }
      if (!existsSync(join(this.dir, 'packages'))) {
        errors.push('缺少 packages 目录 —— 目录内容不完整')
      }
    }
    return { ok: errors.length === 0, errors }
  }

  /**
   * Attach a ZIP-copied directory to git (plan A): init + remote + fetch +
   * reset so future updates use the same unified git path. Network failure
   * does NOT block startup — the app runs with the copied code as-is.
   */
  async gitify(progress: ProgressFn): Promise<boolean> {
    const git = this.getGit()
    if (!git) {
      progress('未检测到 git，跳过 Git 接入（可稍后在安装 Git 后手动更新）')
      return false
    }
    if (this.exists) return true
    try {
      progress('将 ZIP 目录接入 Git，以便后续自动更新...')
      if (!existsSync(join(this.dir, '.git'))) {
        execFileSync(git.path, ['init', '-b', BRANCH], { cwd: this.dir, windowsHide: true, stdio: 'ignore' })
        execFileSync(git.path, ['remote', 'add', 'origin', REPO_URL], { cwd: this.dir, windowsHide: true, stdio: 'ignore' })
      }
      const remote = this.remoteName()
      this.removeStaleLocks()
      await this.runAsync(
        git.path,
        ['fetch', remote, BRANCH, '--depth', '1'],
        { cwd: this.dir, timeoutMs: FETCH_TIMEOUT_MS, logName: 'wizard' }
      )
      this.attachToRemoteBranch()
      this.gitSync(['reset', '--hard', `${remote}/${BRANCH}`], { timeoutMs: 60_000 })
      progress('Git 接入完成')
      return true
    } catch (err) {
      progress(`Git 接入失败（不影响本次使用）：${(err as Error).message.slice(0, 120)}`)
      return false
    }
  }

  // ── First-run readiness ──

  /** Full first-run readiness: install → build. Plugin market is deferred. */
  async ready(progress: ProgressFn): Promise<void> {
    progress('安装依赖（首次需要几分钟，请耐心等待）...')
    await this.installDeps(progress)
    await this.buildAll(progress)
  }

  /**
   * True when node_modules is missing or incomplete.
   *
   * The naive check (".pnpm exists") is not enough: safe-delete guards or
   * interrupted installs may leave the content-addressable store populated
   * while the top-level symlinks / workspace links are missing. We verify
   * that a few critical runtime dependencies can actually be resolved.
   */
  needsInstall(): boolean {
    if (
      !existsSync(join(this.dir, 'node_modules', '.pnpm')) &&
      !existsSync(join(this.dir, 'node_modules', '.bin'))
    ) {
      return true
    }
    const req = createRequire(join(this.dir, 'package.json'))
    const critical = [
      'koffi',
      'open',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-cli',
      // tsdown declares `unrun` as an OPTIONAL peer dependency, which pnpm
      // never auto-installs. The harness build (scripts/build.ts → tsdown)
      // crashes with "Failed to import module 'unrun'" without it, so we must
      // treat its absence as "needs install" too.
      'unrun',
    ]
    for (const name of critical) {
      try {
        req.resolve(name)
      } catch {
        return true
      }
    }
    return false
  }

  /**
   * True when the frontend client bundle has not been built yet.
   *
   * Checks for the actual build artifact (index.html), not just the output
   * directory — a partially built or interrupted build leaves the directory
   * behind but no usable bundle, and we must not skip the rebuild in that
   * case. A successfully built bundle is a stable cache: subsequent launches
   * skip the (multi-minute) frontend build entirely.
   */
  needsBuild(): boolean {
    return !existsSync(join(this.dir, 'packages', 'web', 'build', 'client', 'index.html'))
  }

  /**
   * Startup readiness gate: when dependencies are missing or the web client
   * bundle has not been built, run the required install/build steps BEFORE
   * the server is spawned.
   *
   * Both checks are cached: a workspace that already installed dependencies
   * and built the client bundle once skips both steps on every later launch
   * (build output is only invalidated by an actual source update, see
   * applyUpdate → buildAll). The user still gets explicit feedback about
   * what was skipped.
   *
   * Plugin market installation is intentionally NOT part of this gate — it
   * is non-critical and can take minutes; it runs asynchronously after the
   * main window loads (see installPluginMarketAsync).
   */
  async ensureReady(progress: ProgressFn): Promise<void> {
    const needInstall = this.needsInstall()
    const needBuild = needInstall || this.needsBuild()
    if (!needInstall && !needBuild) {
      progress('依赖与构建已就绪，无需重复安装/构建')
      return
    }
    if (needInstall) await this.installDeps(progress)
    if (needBuild) await this.buildAll(progress)
  }

  private async buildAll(progress: ProgressFn): Promise<void> {
    this.ensureBuildCommitHash()

    // Refresh the pnpm wrapper so node_modules/.bin/pnpm.cmd points at a
    // persistent workspace copy, not a stale Electron temp extraction path.
    this.createPnpmWrapper()
    // Overwrite node_modules/.bin/tsdown so every invocation gets
    // --config-loader tsx (see createTsdownWrapper for why).
    this.createTsdownWrapper()

    const node = resolveNodeBin()
    const pnpmBin = this.ensureBundledPnpmInWorkspace() ?? this.resolvePnpmBin()
    if (!pnpmBin) {
      throw new Error('未找到 pnpm，无法构建。请安装 pnpm 后重试，或检查安装包完整性。')
    }

    // The workspace build script (scripts/build.ts) needs two environment
    // values that cannot be left to chance:
    // 1. DSH_CLIENT_COMMIT_HASH — ZIP-copied workspaces may have no Git HEAD,
    //    and the build crashes with "git rev-parse HEAD" if this is missing.
    // 2. npm_execpath — build.ts uses it as the package manager. We pass the
    //    same persistent pnpm copy that the wrapper uses, so every nested
    //    "pnpm" invocation resolves to a real file.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [CLIENT_COMMIT_HASH_VAR]: process.env[CLIENT_COMMIT_HASH_VAR] ?? '',
      npm_execpath: pnpmBin,
      PATH: buildPath(join(this.dir, 'node_modules', '.bin')),
    }
    if (node.useElectron) env.ELECTRON_RUN_AS_NODE = '1'

    progress('构建后端与前端（首次需要几分钟）...')
    await this.runAsyncWithProgress(
      node.path,
      ['--import', 'tsx/esm', join(this.dir, 'scripts', 'build.ts')],
      { cwd: this.dir, timeoutMs: BUILD_TIMEOUT_MS, env, logName: 'wizard' },
      progress,
      '构建'
    )
  }

  /**
   * Resolve the real pnpm entry the wrapper should invoke.
   *
   * pnpm.cmd shims differ wildly by install method (npm global, corepack,
   * official standalone, scoop/choco...), and the actual script moved around
   * across pnpm versions (bin/pnpm.cjs vs bin/pnpm.mjs vs dist/pnpm.mjs vs a
   * standalone pnpm.exe). Instead of guessing structural layouts, parse the
   * shim itself — it is the single source of truth for the real entry.
   *
   * Returns an absolute path to a pnpm entry (.cjs/.mjs/.js script or .exe),
   * or null when the shim cannot be resolved.
   */
  private resolvePnpmEntry(pnpmBin: string): string | null {
    const dir = dirname(pnpmBin)
    // 1. Parse the shim: it references the real entry with %dp0% / %~dp0%
    //    (npm cmd-shim) or an absolute path (standalone installer).
    try {
      const raw = readFileSync(pnpmBin, 'utf-8')
      const patterns = [
        // npm cmd-shim: "%_prog%" "%dp0%\node_modules\pnpm\bin\pnpm.cjs" %*
        /"([^"]*node_modules[\\/]pnpm[\\/]bin[\\/]pnpm\.(?:cjs|mjs|js))"/i,
        // some layouts reference dist directly
        /"([^"]*node_modules[\\/]pnpm[\\/]dist[\\/]pnpm\.(?:cjs|mjs|js))"/i,
        // standalone installer: "%PNPM_HOME%\pnpm.exe" or "%~dp0pnpm.exe"
        /"([^"]*pnpm\.exe)"/i,
      ]
      for (const re of patterns) {
        const m = re.exec(raw)
        if (!m) continue
        let ref = m[1]
          .replace(/%[~]?dp0%/gi, '') // %dp0% / %~dp0% = the shim's own dir
          .replace(/%PNPM_HOME%/gi, process.env.PNPM_HOME ?? '')
          .replace(/\\/g, '/')
          .replace(/^[.\/]+/, '')
        const abs = isAbsolute(ref) ? ref : join(dir, ref)
        if (existsSync(abs)) return abs
      }
    } catch { /* unreadable shim */ }

    // 2. Structural candidates under the shim's directory (pnpm 6 → 11 and
    //    standalone installs). Both .cjs and .mjs are covered because pnpm
    //    migrated from CJS to ESM across major versions.
    const candidates = [
      join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
      join(dir, 'node_modules', 'pnpm', 'dist', 'pnpm.cjs'),
      join(dir, 'node_modules', 'pnpm', 'dist', 'pnpm.mjs'),
      join(dir, 'node_modules', 'pnpm', 'artifacts', 'exe', 'dist', 'pnpm.mjs'),
      join(dir, 'pnpm.exe'),
      join(dir, 'pnpm.cjs'),
      join(dir, 'pnpm.mjs'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  /**
   * Create a pnpm wrapper script in node_modules/.bin so that the harness
   * CLI's internal `spawnSync('pnpm', ...)` can find a working pnpm.
   *
   * The harness plugin manager (apps/cli/src/plugin.ts) calls
   * `spawnSync('pnpm', args)` which searches PATH for `pnpm` / `pnpm.cmd`.
   *
   * Wrapper strategy:
   * 1. Prefer the system pnpm (e.g. pnpm 11.21.0). Bundled pnpm 11.22.0 has
   *    a bug where `pnpm add` updates the lockfile and exits 0 WITHOUT
   *    writing the dependency into package.json, so the plugin market looks
   *    installed but is not materialized.
   * 2. If no system pnpm exists, fall back to a persistent copy of the bundled
   *    @pnpm/exe pnpm.mjs inside the workspace (so the wrapper path stays
   *    valid across Electron portable restarts, which unpack to temp dirs).
   *
   * The wrapper invokes `node <pnpm entry>` directly rather than the pnpm.cmd
   * shim, because the shim needs `node` on PATH and our env only carries a
   * minimal PATH. A standalone pnpm.exe is invoked directly (no node needed).
   *
   * Returns the directory containing the wrapper, or null when neither a
   * system nor a bundled pnpm can be resolved.
   */
  private createPnpmWrapper(): string | null {
    const sysPnpm = detectPnpm()
    const bundledPnpm = this.ensureBundledPnpmInWorkspace()
    log('launcher', `createPnpmWrapper: sysPnpm=${sysPnpm.found ? sysPnpm.path : 'none'} (${sysPnpm.version}) bundled=${bundledPnpm ?? 'none'}`)
    if (!sysPnpm.found && !bundledPnpm) return null

    const wrapperDir = join(this.dir, 'node_modules', '.bin')
    try { mkdirSync(wrapperDir, { recursive: true }) } catch { /* exists */ }

    const node = resolveNodeBin()
    const nodePath = node.path.replace(/\\/g, '/')
    let targetPnpm: string | null = null
    // A script entry needs `node <script>`; a standalone .exe is invoked directly.
    let viaNode = true

    if (sysPnpm.found) {
      targetPnpm = this.resolvePnpmEntry(sysPnpm.path)
      if (targetPnpm) {
        viaNode = /\.(cjs|mjs|js)$/i.test(targetPnpm)
        log('launcher', `createPnpmWrapper: resolved system pnpm entry=${targetPnpm} viaNode=${viaNode}`)
      } else {
        log('launcher', `createPnpmWrapper: system pnpm found but entry unresolvable at ${sysPnpm.path}`)
      }
    }
    if (!targetPnpm && bundledPnpm) {
      targetPnpm = bundledPnpm
      viaNode = /\.(cjs|mjs|js)$/i.test(targetPnpm)
      log('launcher', `createPnpmWrapper: falling back to bundled pnpm at ${bundledPnpm}`)
    }
    if (!targetPnpm) return null

    const entryPath = targetPnpm.replace(/\\/g, '/')
    log('launcher', `createPnpmWrapper: writing wrapper to ${join(wrapperDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')} -> ${entryPath}`)

    if (process.platform === 'win32') {
      const wrapperPath = join(wrapperDir, 'pnpm.cmd')
      const inner = viaNode ? `"${nodePath}" "${entryPath}" %*` : `"${entryPath}" %*`
      writeFileSync(wrapperPath, `@echo off\r\n${inner}\r\n`, 'utf-8')
    } else {
      const wrapperPath = join(wrapperDir, 'pnpm')
      const inner = viaNode ? `exec "${node.path}" "${targetPnpm}" "$@"` : `exec "${targetPnpm}" "$@"`
      writeFileSync(wrapperPath, `#!/bin/sh\n${inner}\n`, 'utf-8')
      try { chmodSync(wrapperPath, 0o755) } catch { /* best-effort */ }
    }
    return wrapperDir
  }

  /**
   * Overwrite node_modules/.bin/tsdown with a wrapper that forces
   * --config-loader tsx on every invocation.
   *
   * tsdown's default config loader is "auto", which resolves to "unrun"
   * when Node's native TypeScript support is unavailable (Electron's
   * bundled Node). unrun bundles config files into temp modules under
   * node_modules/.unrun/, which replaces import.meta.url in imported
   * modules — tsdown.client.ts computes REPOSITORY_ROOT from
   * import.meta.url, so it ends up pointing at the temp directory
   * instead of the workspace root, and workspaceManifest() can't find
   * any workspace manifests.
   *
   * The "tsx" loader uses tsx's ESM loader API (tsImport), which
   * preserves import.meta.url. The build already loads tsx via
   * --import tsx/esm, so this loader is always available.
   *
   * The wrapper also sets NODE_PATH to the same three directories the
   * pnpm-generated shim uses, so tsdown's dependencies (rolldown, cac,
   * ansis, …) resolve from the pnpm virtual store.
   */
  private createTsdownWrapper(): string | null {
    try {
      const req = createRequire(join(this.dir, 'package.json'))
      let tsdownPkgPath: string
      try {
        tsdownPkgPath = req.resolve('tsdown/package.json')
      } catch {
        log('launcher', 'createTsdownWrapper: tsdown not installed, skipping')
        return null
      }
      const tsdownDir = dirname(tsdownPkgPath)
      const runMjs = join(tsdownDir, 'dist', 'run.mjs')
      if (!existsSync(runMjs)) {
        log('launcher', `createTsdownWrapper: ${runMjs} not found, skipping`)
        return null
      }

      const wrapperDir = join(this.dir, 'node_modules', '.bin')
      try { mkdirSync(wrapperDir, { recursive: true }) } catch { /* exists */ }

      const node = resolveNodeBin()
      // NODE_PATH must include tsdown's own node_modules so its
      // dependencies resolve from the pnpm virtual store. The three
      // segments mirror the pnpm cmd-shim that `pnpm install` generates.
      const sep = process.platform === 'win32' ? ';' : ':'
      const nodePathSegments = [
        join(tsdownDir, 'node_modules'),
        dirname(tsdownDir),
        join(this.dir, 'node_modules', '.pnpm', 'node_modules'),
      ]
      const nodePath = nodePathSegments.join(sep)

      if (process.platform === 'win32') {
        const wrapperPath = join(wrapperDir, 'tsdown.CMD')
        writeFileSync(
          wrapperPath,
          `@SETLOCAL\r\n@SET "NODE_PATH=${nodePath}"\r\n` +
          `"${node.path}" "${runMjs}" --config-loader tsx %*\r\n`,
          'utf-8',
        )
      } else {
        const wrapperPath = join(wrapperDir, 'tsdown')
        writeFileSync(
          wrapperPath,
          `#!/bin/sh\nexport NODE_PATH="${nodePath}"\n` +
          `exec "${node.path}" "${runMjs}" --config-loader tsx "$@"\n`,
          'utf-8',
        )
        try { chmodSync(wrapperPath, 0o755) } catch { /* best-effort */ }
      }
      log('launcher', `createTsdownWrapper: wrapper -> ${runMjs} --config-loader tsx`)
      return wrapperDir
    } catch (err) {
      log('launcher', `createTsdownWrapper: failed: ${(err as Error).message.slice(0, 200)}`)
      return null
    }
  }

  // ── Plugin market state ──

  /** Resolve the dsh home directory (respects $DSH_HOME, defaults to ~/.dsh). */
  private dshHome(): string {
    const fromEnv = process.env.DSH_HOME?.trim()
    if (fromEnv) return fromEnv
    return join(homedir(), '.dsh')
  }

  /** The profile directory where `dsh plugin` installs packages. */
  private profileDir(profile = 'web'): string {
    return join(this.dshHome(), 'profiles', profile)
  }

  /**
   * True when the plugin market is actually installed: the web profile's
   * package.json lists `dshmarket` as a dependency AND the package exists
   * under the profile's node_modules. A manifest entry without the installed
   * package (half-finished / failed install) counts as NOT installed so the
   * flow retries.
   */
  isPluginMarketInstalled(): boolean {
    try {
      const manifest = JSON.parse(
        readFileSync(join(this.profileDir(), 'package.json'), 'utf-8')
      ) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
      // The normal success path: pnpm add wrote the dependency and
      // reconcilePlugins added it to the bundle list.
      if (manifest.dependencies?.[MARKET_PKG]) {
        return existsSync(join(this.profileDir(), 'node_modules', MARKET_PKG))
      }
      // Defensive fallback: some pnpm versions (observed with bundled 11.22.0)
      // update the lockfile and exit 0 without writing package.json. If the
      // bundle list already knows about the market and the package is on disk,
      // treat it as installed so we don't repeatedly fail the same command.
      if (manifest.dsh?.profile?.bundles?.includes(MARKET_PKG)) {
        return existsSync(join(this.profileDir(), 'node_modules', MARKET_PKG))
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * Best-effort: write pnpm's build-script allowlist into the web profile's
   * pnpm-workspace.yaml so a git-hosted / build-scripted dependency is not
   * blocked on pnpm ≥10/11. Writes both the modern `allowBuilds:` map and the
   * compatible `onlyBuiltDependencies:` list when the keys are absent.
   * Returns false when the file cannot be updated.
   */
  private allowBuildForMarket(): boolean {
    try {
      const wsFile = join(this.profileDir(), 'pnpm-workspace.yaml')
      let content = ''
      try { content = readFileSync(wsFile, 'utf-8') } catch { /* missing */ }
      if (content.includes(MARKET_PKG)) return true // already allowed

      const additions: string[] = []
      if (!/^allowBuilds:/m.test(content)) {
        additions.push(`allowBuilds:\n  ${MARKET_PKG}: true`)
      }
      if (!/^onlyBuiltDependencies:/m.test(content)) {
        additions.push(`onlyBuiltDependencies:\n  - ${MARKET_PKG}`)
      }
      if (additions.length === 0) return true
      content += `\n${additions.join('\n')}\n`
      writeFileSync(wsFile, content, 'utf-8')
      return true
    } catch {
      return false
    }
  }

  /**
   * Install the official plugin market on user request (see main.ts flow:
   * ask → progress window → result dialog).
   *
   * Idempotent: when the market is already installed (manifest entry AND
   * resolvable package), it returns immediately with skipped=true — a repeat
   * launch must not re-run the install.
   *
   * Returns a structured result so the caller can distinguish success,
   * already-installed, and failure (with the message for the result dialog).
   */
  async installPluginMarket(
    progress: ProgressFn
  ): Promise<{ installed: boolean; skipped: boolean; error?: string }> {
    if (this.isPluginMarketInstalled()) {
      progress('dshmarket 插件市场已安装，跳过')
      return { installed: true, skipped: true }
    }
    try {
      const node = resolveNodeBin()
      const cli = join(this.dir, 'apps', 'cli', 'src', 'bin.ts')

      // Create pnpm wrapper so the harness CLI's internal spawnSync('pnpm')
      // can find our bundled pnpm. Without this, the plugin install silently
      // fails with ENOENT on machines without a system pnpm.
      const wrapperDir = this.createPnpmWrapper()
      const pathSegments = [join(this.dir, 'node_modules', '.bin')]
      if (wrapperDir) pathSegments.push(wrapperDir)

      const finalPath = buildPath(...pathSegments)
      log('launcher', `installPluginMarket: node=${node.path} cli=${cli} PATH=${finalPath}`)
      progress('正在安装 dshmarket 插件市场...')
      const env: NodeJS.ProcessEnv = {
        PATH: buildPath(...pathSegments),
      }
      if (node.useElectron) env.ELECTRON_RUN_AS_NODE = '1'

      const runInstall = (): Promise<void> =>
        this.runAsyncWithProgress(
          node.path,
          ['--import', 'tsx/esm', cli, 'plugin', '--profile', 'web', 'add', MARKET_PKG],
          { cwd: this.dir, timeoutMs: MARKET_TIMEOUT_MS, env, logName: 'wizard' },
          progress,
          '插件市场'
        )

      try {
        await runInstall()
      } catch (err) {
        // pnpm ≥10 blocks build scripts of git deps until allowlisted. The
        // registry package normally never triggers this, but a transitive
        // dep or a future git spec could. When the error names the build
        // policy, allow the package and retry once instead of failing.
        const msg = (err as Error).message
        if (/allowBuilds|onlyBuiltDependencies|Ignored build scripts/i.test(msg) && this.allowBuildForMarket()) {
          progress('检测到 pnpm 构建策略限制，已自动允许构建脚本，正在重试...')
          await runInstall()
        } else {
          throw err
        }
      }

      // Verify the install actually landed: the web profile's package.json
      // must list dshmarket AND the package must resolve from node_modules.
      // A command that "succeeded" without materializing the dependency
      // (e.g. pnpm wrote nothing) is reported as a failure.
      if (!this.isPluginMarketInstalled()) {
        throw new Error('安装命令已执行，但 dshmarket 未出现在 web profile 的依赖中')
      }
      progress('dshmarket 插件市场安装完成')
      return { installed: true, skipped: false }
    } catch (err) {
      const error = (err as Error).message.slice(0, 300)
      progress(`插件市场安装失败：${error}`)
      return { installed: false, skipped: false, error }
    }
  }

  /**
   * Like runAsync, but parses child stdout/stderr line-by-line and forwards
   * meaningful lines as progress messages. This prevents the "frozen splash"
   * effect during long-running operations like pnpm install.
   */
  private async runAsyncWithProgress(
    bin: string,
    args: string[],
    opts: {
      cwd?: string
      timeoutMs?: number
      env?: NodeJS.ProcessEnv
      logName?: LogName
    },
    progress: ProgressFn,
    label: string
  ): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const cwd = opts.cwd ?? this.dir
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
      const proc: ChildProcess = spawn(bin, args, {
        cwd,
        env: {
          ...process.env,
          PATH: buildPath(join(this.dir, 'node_modules', '.bin')),
          ...opts.env,
        },
        shell: useShell,
        windowsHide: !isDebug(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      let stdout = ''
      const logName: LogName = opts.logName ?? 'wizard'
      let lineBuf = ''

      const processLine = (line: string): void => {
        const trimmed = line.trim()
        if (!trimmed) return
        // Forward pnpm progress lines (Progress: ..., Packages: ..., etc.)
        if (/^(Progress|Packages|Resolving|Fetching|Building|Linking|Done|Installing|rebuild)/i.test(trimmed)) {
          progress(`${label}：${trimmed.slice(0, 80)}`)
        } else if (/^dsh:/.test(trimmed)) {
          progress(`${label}：${trimmed.slice(0, 80)}`)
        }
      }

      proc.stdout?.on('data', (d: Buffer) => {
        const text = d.toString()
        stdout += text
        appendChildOutput(logName, text)
        lineBuf += text
        const lines = lineBuf.split(/\r?\n/)
        lineBuf = lines.pop() ?? ''
        for (const line of lines) processLine(line)
      })
      proc.stderr?.on('data', (d: Buffer) => {
        const text = d.toString()
        stderr += text
        appendChildOutput(logName, text)
        lineBuf += text
        const lines = lineBuf.split(/\r?\n/)
        lineBuf = lines.pop() ?? ''
        for (const line of lines) processLine(line)
      })
      const timer = opts.timeoutMs ? setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs) : null
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer)
        reject(err)
      })
      proc.on('exit', (code) => {
        if (timer) clearTimeout(timer)
        if (lineBuf) processLine(lineBuf)
        if (code === 0) resolvePromise()
        else {
          const tail = (stdout.slice(-500) + '\n' + stderr.slice(-500)).trim()
          reject(new Error(
            `命令执行失败 (exit ${code})。\n` +
            `最近输出：\n${tail || '(无输出)'}\n\n` +
            `完整日志：${getLogDir()}`
          ))
        }
      })
    })
  }

  // ── Update check & apply (unified git path) ──

  /**
   * Fetch remote master and report whether new commits exist.
   * Called only when git is available; network failure = no update.
   */
  async checkUpdate(progress: ProgressFn): Promise<boolean> {
    if (!this.exists) return false
    const git = this.getGit()
    if (git) {
      const remote = this.remoteName()
      try {
        this.removeStaleLocks()
        await this.runAsync(
          git.path,
          ['-C', this.dir, 'fetch', remote, BRANCH, '--depth', '1'],
          { timeoutMs: FETCH_TIMEOUT_MS, logName: 'launcher' }
        )
        // Fetch may have just created refs/remotes/<remote>/<branch>. Reattach
        // the (possibly empty) local branch to it so HEAD is resolvable.
        this.attachToRemoteBranch()
      } catch {
        progress('无法连接 GitHub（已使用本地版本启动）')
        return false
      }
      try {
        const count = this.gitSync(['rev-list', '--count', `HEAD..${remote}/${BRANCH}`], { timeoutMs: 30_000 }).trim()
        return parseInt(count, 10) > 0
      } catch {
        return false
      }
    }
    try {
      this.removeStaleLocks()
      const { git: iso, http, fs } = await this.gitIso()
      await iso.fetch({ fs, http, dir: this.dir, ref: BRANCH, singleBranch: true, depth: 1, tags: false })
      const head = await iso.resolveRef({ fs, dir: this.dir, ref: 'HEAD' })
      const remote = await iso.resolveRef({ fs, dir: this.dir, ref: `refs/remotes/origin/${BRANCH}` })
      return head !== remote
    } catch {
      progress('无法连接 GitHub（已使用本地版本启动）')
      return false
    }
  }

  /**
   * Startup update path. git availability is checked FIRST — if missing,
   * the update is skipped and the app starts with existing code.
   */
  async ensureUpdated(progress: ProgressFn): Promise<UpdateResult> {
    if (!this.exists) {
      // No git working copy (e.g. ZIP dir that failed git-ification) —
      // run gitify once, and if that fails, just start.
      const ok = await this.gitify(progress)
      if (!ok) {
        return { updated: false, skipped: true, reason: 'no-git-copy' }
      }
    }
    // ZIP-initialized repos may have an empty local branch even after gitify.
    // Attach to the fetched remote branch so build scripts can resolve HEAD.
    this.attachToRemoteBranch()
    const git = this.getGit()
    if (!git) {
      progress('未检测到 git，已跳过自动更新（使用现有代码启动）')
      return { updated: false, skipped: true, reason: 'no-git' }
    }
    if (!(await this.checkUpdate(progress))) {
      return { updated: false, skipped: false }
    }
    progress('发现新版本，正在更新...')
    await this.applyUpdate(progress)
    return { updated: true, skipped: false }
  }

  /**
   * Reset working copy to origin/master, reinstall deps when the lockfile
   * changed, then rebuild. Rolls the code back to the previous commit when
   * dependency install fails.
   */
  async applyUpdate(progress: ProgressFn): Promise<void> {
    const oldHead = this.currentCommit()
    const git = this.getGit()

    const remote = this.remoteName()
    if (git) {
      try { this.gitSync(['stash'], { timeoutMs: 30_000 }) } catch { /* nothing to stash */ }
      progress('更新源码...')
      this.gitSync(['reset', '--hard', `${remote}/${BRANCH}`], { timeoutMs: 60_000 })
      try { this.gitSync(['stash', 'pop'], { timeoutMs: 30_000 }) } catch { /* no stash */ }
    } else {
      try {
        const { git: iso, fs } = await this.gitIso()
        const target = await iso.resolveRef({ fs, dir: this.dir, ref: `refs/remotes/${remote}/${BRANCH}` })
        await iso.checkout({ fs, dir: this.dir, ref: target, force: true })
      } catch (err) {
        progress('更新源码失败，继续使用当前版本')
        return
      }
    }

    if (this.lockHashChanged()) {
      await this.installDeps(progress, oldHead)
    }
    // Code changed → rebuild backend + frontend so the web UI matches.
    await this.buildAll(progress)
    // Plugin market re-install is deferred (non-critical, see ensureReady).
  }

  // ── Dependencies ──

  /**
   * Install dependencies with pnpm. On failure, attempt to roll the code
   * back to `rollbackHead` (the commit that was running before the update).
   *
   * When the store looks populated but top-level symlinks are missing
   * (needsInstall() still returned true despite .pnpm existing), use
   * `--force` so pnpm re-creates the links instead of assuming the install
   * is already complete.
   */
  async installDeps(progress: ProgressFn, rollbackHead?: string): Promise<void> {
    progress('安装依赖（首次需要几分钟，请耐心等待）...')
    // tsdown@0.22.x lists `unrun` as an OPTIONAL peer dependency. pnpm skips
    // optional peers by default, and the harness package.json does not declare
    // it, so the first-run build ("tsdown") fails with
    // "Failed to import module 'unrun'". Inject it into the workspace
    // package.json so the install below materializes it.
    const injectedUnrun = this.ensureUnrunPeer()
    const storePopulated = existsSync(join(this.dir, 'node_modules', '.pnpm'))
    const force = storePopulated && this.needsInstall()
    let args = force
      ? ['install', '--force']
      : ['install', '--frozen-lockfile', '--prefer-offline']
    // Injecting unrun desyncs the frozen lockfile, so relax to a normal install
    // that records and resolves the new dependency.
    if (injectedUnrun && !force) args = ['install', '--prefer-offline']
    try {
      await this.runPnpm(args, progress, '安装依赖')
      this.setLockHash(this.lockHash())
    } catch (err) {
      if (rollbackHead && rollbackHead !== 'unknown') {
        try {
          const git = this.getGit()
          if (git) {
            progress('依赖安装失败，回滚到上一个版本...')
          const remote = this.remoteName()
          this.removeStaleLocks()
          this.gitSync(['fetch', remote, rollbackHead, '--depth', '1'], { timeoutMs: 60_000 })
          this.gitSync(['reset', '--hard', 'FETCH_HEAD'], { timeoutMs: 60_000 })
          }
        } catch { /* rollback failed — leave code as-is */ }
      }
      throw new Error(`依赖安装失败：\n${(err as Error).message}`)
    }
  }

  /**
   * tsdown@0.22.x lists `unrun` as an OPTIONAL peer dependency. pnpm never
   * auto-installs optional peers, and the harness package.json does not declare
   * it, so the first-run build (scripts/build.ts → `tsdown`) fails with
   * "Failed to import module 'unrun'". Inject `unrun` into the workspace
   * package.json devDependencies so `pnpm install` materializes it.
   *
   * Returns true when we had to add it (the caller then relaxes the frozen
   * lockfile). Idempotent: returns false when `unrun` is already declared.
   */
  private ensureUnrunPeer(): boolean {
    const pkgPath = join(this.dir, 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      if (pkg.dependencies?.unrun || pkg.devDependencies?.unrun || pkg.peerDependencies?.unrun) {
        return false
      }
      pkg.devDependencies = pkg.devDependencies ?? {}
      pkg.devDependencies.unrun = '*'
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
      return true
    } catch {
      return false
    }
  }

  // ── Lockfile hash ──

  private lockFile(): string {
    return join(this.dir, 'pnpm-lock.yaml')
  }

  private hashFile(): string {
    return join(this.dir, LOCK_HASH_FILE)
  }

  private lockHash(): string {
    try {
      return createHash('sha1').update(readFileSync(this.lockFile())).digest('hex')
    } catch {
      return ''
    }
  }

  private storedLockHash(): string {
    try {
      return readFileSync(this.hashFile(), 'utf-8').trim()
    } catch {
      return ''
    }
  }

  private setLockHash(hash: string): void {
    try { writeFileSync(this.hashFile(), hash, 'utf-8') } catch { /* best-effort */ }
  }

  /** True when the lockfile changed since the last successful install */
  lockHashChanged(): boolean {
    return this.lockHash() !== this.storedLockHash()
  }

  // ── Status ──

  /** Short HEAD commit hash of the working copy */
  currentCommit(): string {
    const git = this.getGit()
    if (git) {
      try {
        return this.gitSync(['rev-parse', '--short=7', 'HEAD'], { timeoutMs: 15_000 }).trim()
      } catch { /* no HEAD — fall through to fallback */ }
    }
    // Fallback 1: DSH_CLIENT_COMMIT_HASH env var (set by ensureBuildCommitHash)
    const envHash = process.env[CLIENT_COMMIT_HASH_VAR]
    if (envHash && /^[0-9a-f]{7,40}$/i.test(envHash)) {
      return envHash.substring(0, 7)
    }
    // Fallback 2: lock-hash.txt
    try {
      const hash = readFileSync(this.hashFile(), 'utf-8').trim()
      if (/^[0-9a-f]{40}$/i.test(hash)) return hash.substring(0, 7)
    } catch { /* fallthrough */ }
    // Fallback 3: deterministic hash from package.json
    try {
      const pkg = JSON.parse(readFileSync(join(this.dir, 'package.json'), 'utf-8')) as {
        name?: string
        version?: string
      }
      const seed = `${pkg.name ?? 'deepseek-harness'}@${pkg.version ?? '0.0.0'}`
      return createHash('sha1').update(seed).digest('hex').substring(0, 7)
    } catch {
      return 'unknown'
    }
  }

  /** Version of the dsh (deepseek-harness) workspace: package.json version + HEAD commit. */
  dshVersion(): string {
    try {
      const pkg = JSON.parse(readFileSync(join(this.dir, 'package.json'), 'utf-8')) as {
        version?: string
      }
      const ver = pkg.version ?? 'unknown'
      const commit = this.currentCommit()
      return commit && commit !== 'unknown' ? `${ver}+${commit}` : ver
    } catch {
      return 'unknown'
    }
  }
}
