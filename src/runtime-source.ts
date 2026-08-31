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
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { join, dirname, isAbsolute, resolve as pathResolve } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import {
  detectGit,
  detectPnpm,
  resolveNodeBin,
  buildPath,
  type ToolInfo,
} from './env-detector.js'
import { appendChildOutput, getLogDir, isDebug, log, type LogName } from './logging.js'
import {
  CHANNEL_ENV_VAR,
  DEFAULT_CHANNEL,
  channelDef,
  normalizeChannel,
  selectChannelTag,
  type ChannelId,
  type ChannelSelection,
} from './channels.js'
import {
  loadPreferences,
  savePreferences,
  writeRecoveryGuide,
  recoveryGuidePath,
} from './preferences.js'

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

/**
 * Minimum gap between two automatic remote update checks.
 *
 * A `git fetch` costs ~4.5s of blocking time on every launch, and upstream
 * publishes a handful of commits per day, so checking every launch is pure
 * startup latency. Menu → 检查更新 always bypasses this.
 */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export type ProgressFn = (msg: string) => void

export interface UpdateResult {
  updated: boolean
  /** True when the update was skipped (no git / network failure) */
  skipped: boolean
  reason?: string
}

/**
 * A concrete revision to check out, resolved from a release channel.
 *
 * `sha` comes straight from `git ls-remote`, so "is there an update?" is
 * answered without downloading the objects first.
 */
export interface ChannelTarget {
  selection: ChannelSelection
  /** Commit the channel's tag points at. */
  sha: string
}

/**
 * How long `git ls-remote --tags` results are reused.
 *
 * Listing remote refs is the only network call needed to decide whether an
 * update exists; a launch that also applies one re-lists with force=true so
 * it never acts on a stale answer.
 */
const TAG_LIST_CACHE_MS = 60 * 1000

/**
 * Collect the names a built ESM file exports, by parsing its export
 * statements. Handles the shapes bundlers actually emit:
 *   export { a, b as c }            → a, c
 *   export { x } from './y'         → x
 *   export function|const|let|var|class name
 *   export default …                → default
 *
 * Deliberately does NOT follow `export * from './x'` (unresolvable without
 * full module resolution) — callers must treat a miss as "unverified", not
 * "missing". See probeModuleExports().
 */
function collectEsmExports(src: string): Set<string> {
  const names = new Set<string>()

  // `export { … }` clause, optionally followed by `from '…'`.
  const clauseRe = /export\s*\{([^}]*)\}(?:\s*from\s*(['"])[^'"]*\2)?/g
  // `export function foo` / `export const foo` / `export class foo` / `export async function foo`
  const declRe =
    /export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g

  let m: RegExpExecArray | null
  while ((m = clauseRe.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const spec = part.trim()
      if (!spec) continue
      // `local as exported` → the exported name is what follows `as`.
      const asMatch = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec)
      if (asMatch) {
        names.add(asMatch[1])
        continue
      }
      // Plain `name` (possibly `default`).
      if (/^[A-Za-z_$][\w$]*$/.test(spec)) names.add(spec)
    }
  }
  while ((m = declRe.exec(src)) !== null) names.add(m[1])
  if (/\bexport\s+default\b/.test(src)) names.add('default')

  return names
}

/**
 * Ground-truth check: really import a module in a throwaway child process and
 * return its export names.
 *
 * Returns null when the probe could not run or the module could not be
 * imported — callers must treat null as "inconclusive, do not block".
 *
 * Runs in a separate process so a module with top-level side effects cannot
 * pollute the host, and so an import that hangs or throws cannot take the
 * app down with it.
 */
async function probeModuleExports(
  node: { path: string; useElectron: boolean },
  filePath: string
): Promise<string[] | null> {
  // With `-e`, the first user argument lands at process.argv[1].
  const script =
    'import(process.argv[1])' +
    '.then((m) => { process.stdout.write(JSON.stringify(Object.keys(m))) })' +
    '.catch(() => { process.stdout.write("__PROBE_FAILED__") })'
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        node.path,
        ['-e', script, pathToFileURL(filePath).href],
        {
          cwd: dirname(filePath),
          timeout: 30_000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            // Electron binaries only behave like Node with this set.
            ...(node.useElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          },
        },
        (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) }))
      )
    })
    const out = stdout.trim()
    if (!out || out === '__PROBE_FAILED__') return null
    const parsed: unknown = JSON.parse(out)
    return Array.isArray(parsed) ? parsed.map(String) : null
  } catch {
    return null
  }
}

export class RuntimeSource {
  readonly dir: string
  private git: ToolInfo | null = null
  private gitChecked = false
  /** Cached `git ls-remote --tags` output: [fullRef, sha] pairs. */
  private remoteTags: { at: number; entries: Array<{ ref: string; sha: string }> } | null = null

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
   * Third-party dependencies that must exist in the pnpm store.
   *
   * `unrun` is an OPTIONAL peer of tsdown, so pnpm never auto-installs it;
   * the harness build (`scripts/build.ts` → tsdown) crashes with "Failed to
   * import module 'unrun'" without it. It stays critical for that reason.
   */
  private static readonly CRITICAL_DEPS = ['koffi', 'open', 'unrun'] as const

  /**
   * Workspace packages the shell boots from, as path segments under the repo
   * root. pnpm links these into their CONSUMERS' node_modules, never into the
   * root node_modules, so they have to be checked as source directories.
   */
  private static readonly CRITICAL_WORKSPACE_PKGS = [
    ['apps', 'cli'],
    ['packages', 'host', 'webserver'],
  ] as const

  /**
   * Whether a third-party dependency is present in the pnpm store.
   *
   * pnpm's default layout is STRICT: `node_modules/<pkg>` only holds what the
   * ROOT package.json declares; everything else lands in
   * `node_modules/.pnpm/<slug>@<version>/node_modules/<pkg>` (scoped names
   * become `@scope+name`). Resolving these names from the repo root therefore
   * fails even on a perfectly installed workspace.
   *
   * That false negative made needsInstall() report "needs install" on every
   * launch, re-running a dependency install AND a full build (≈21s) before
   * every start.
   */
  private hasStoredDep(name: string): boolean {
    const store = join(this.dir, 'node_modules', '.pnpm')
    const slug = `${name.replace('/', '+')}@`
    try {
      return readdirSync(store).some((entry) => entry.startsWith(slug))
    } catch {
      return false
    }
  }

  /**
   * True when node_modules is missing or incomplete.
   *
   * Each kind of package is checked where it actually lives — the
   * content-addressable store for third-party deps, source directories for
   * workspace packages — instead of resolving every name from the repo root.
   */
  needsInstall(): boolean {
    if (
      !existsSync(join(this.dir, 'node_modules', '.pnpm')) &&
      !existsSync(join(this.dir, 'node_modules', '.bin'))
    ) {
      return true
    }
    for (const name of RuntimeSource.CRITICAL_DEPS) {
      if (!this.hasStoredDep(name)) return true
    }
    for (const parts of RuntimeSource.CRITICAL_WORKSPACE_PKGS) {
      if (!existsSync(join(this.dir, ...parts, 'package.json'))) return true
    }
    return false
  }

  /**
   * Known locations of the built web client, newest layout first.
   *
   * Upstream has already moved the frontend output once
   * (`packages/web/build/client` → `apps/web/dist`, where the package
   * `@deepseek-ai/dsh-web-frontend` lives). Pinning a single path makes
   * needsBuild() report "not built" forever after such a move, which forces a
   * full backend + frontend rebuild on EVERY launch — minutes of waiting, and
   * it multiplies the blast radius of any build failure, because the build
   * gates startup. Probing every known location keeps the cache working.
   */
  private static readonly CLIENT_BUNDLE_CANDIDATES = [
    ['apps', 'web', 'dist', 'index.html'],
    ['packages', 'web', 'build', 'client', 'index.html'],
  ] as const

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
    for (const parts of RuntimeSource.CLIENT_BUNDLE_CANDIDATES) {
      if (existsSync(join(this.dir, ...parts))) return false
    }
    return true
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
      // Artifacts are already on disk, and nothing re-verifies them until the
      // next update. An upstream breaking change — or an interrupted build —
      // can leave a workspace that looks built but is missing exports plugins
      // import; it would otherwise surface much later as a cryptic
      // "does not provide an export named X" crash at plugin load time.
      const problem = await this.detectMissingCriticalExports()
      if (problem) {
        // Recovery: rebuild once. This repairs stale or half-written
        // artifacts, which is the recoverable half of this failure mode.
        // Throttled by time rather than by commit, so it also works for
        // ZIP-copied workspaces that have no git history to key on.
        if (this.exportRepairRecentlyAttempted()) {
          // A rebuild already failed to fix this recently on this channel. Fail
          // fast with the real explanation instead of spending minutes on a
          // doomed rebuild at every single launch.
          throw new Error(problem)
        }
        progress('构建产物缺少插件所需的导出，正在清理并重新构建...')
        this.markExportRepairAttempted()
        // Stale artifacts from a previous version can cause export mismatches
        // even when the source code is correct — e.g. alpha.2's dsh-tools/lib
        // imported @deepseek-ai/dsh-util-values which rc.2 does not declare.
        // tsdown's incremental build skips "unchanged" packages, so a plain
        // buildAll() would leave those broken .js in place. Clean first so
        // the rebuild is genuinely full.
        this.cleanAllBuildArtifacts(progress)
        try {
          await this.buildAll(progress) // throws a message naming the export
          return
        } catch (err) {
          // Rebuilding cannot help when the *source* dropped the export — that
          // is an upstream breaking change, not a stale artifact. The fix is a
          // different *revision*, and this is the launch on which a user
          // discovers their workspace has drifted onto one that cannot work.
          //
          // Note this is not limited to the prerelease channels. The common
          // case is the opposite: the channel says `next` but the working tree
          // is still sitting on an alpha commit — because the update that would
          // have moved it was throttled, or had failed and been rolled back.
          // Rebuilding that tree fails no matter how many times it is retried,
          // so moving to the channel's own commit is the only repair. Doing it
          // here is what makes this self-healing rather than "unlaunchable
          // until someone edits a config file by hand".
          log(
            'launcher',
            `ensureReady: export repair rebuild failed (channel=${this.channel()}): ${(err as Error).message.slice(0, 200)}`
          )
          if (await this.downgradeToSafeChannel(progress)) return
          throw new Error(
            `${problem}\n\n已尝试切换到推荐通道（${DEFAULT_CHANNEL}）但未能恢复。` +
              `可用 DSH_CHANNEL=${DEFAULT_CHANNEL} 环境变量启动，或直接查看恢复指引：${recoveryGuidePath()}`
          )
        }
      }
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
    // Overwrite node_modules/.bin/tsdown so every invocation gets a config
    // loader that works for this workspace (see createTsdownWrapper).
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
    //
    // DO NOT set NODE_OPTIONS=--import tsx/esm here. It leaks into the pnpm
    // process itself, and pnpm 11 + tsx ESM hooks conflict: tsx's resolver
    // breaks pnpm's optional .pnpmfile.mjs probe and pnpm dies with
    // PNPMFILE_FAIL. tsdown runs under the native config loader instead
    // (see createTsdownWrapper).
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
    // Verify that exports third-party plugins depend on actually survived the
    // build. Upstream sometimes refactors a package between versions (e.g.
    // @deepseek-ai/dsh-settings 0.1.2-alpha.2 dropped `settingsNamespace` and
    // `installSettingsSection`) and the build script still exits 0 — the app
    // then dies at plugin load time and stays permanently unlaunchable.
    // Catching it here turns that into an automatic rollback instead.
    await this.verifyCriticalExports(node)
  }

  /**
   * Exports known to be required by popular third-party plugins, keyed by the
   * built ESM entry of the workspace package that is supposed to provide them.
   *
   * Sourced by scanning installed plugins for named imports out of
   * `@deepseek-ai/*` — this is the complete set as of dsh 0.1.1-rc.2, covering
   * dshmarket, dsh-config-manager and dsh-win32. To refresh it:
   *
   *   grep -rhoE "import\\s*\\{[^}]*\\}\\s*from\\s*['\"]@deepseek-ai/[a-z0-9-]+['\"]" \
   *     ~/.dsh/profiles/web/node_modules --include="*.js" --include="*.mjs"
   *
   * ONLY add entries verified against a real build. A wrong entry would roll
   * the user back to an older version for no reason — which is the failure
   * this list exists to prevent, not one to introduce. Every export below was
   * confirmed present in the rc.2 build before being added.
   *
   * A missing package is not an error: entries whose file does not exist in
   * the checked-out revision are skipped, so a package upstream splits or
   * renames does not turn into a false alarm.
   */
  private static readonly CRITICAL_EXPORTS: ReadonlyArray<{
    pkg: string
    /** Path relative to the workspace root. */
    rel: string
    exports: readonly string[]
  }> = [
    {
      pkg: '@deepseek-ai/dsh-settings',
      rel: join('packages', 'settings', 'settings', 'lib', 'index.js'),
      exports: ['settingsNamespace', 'installSettingsSection'],
    },
    {
      pkg: '@deepseek-ai/dsh-tools',
      rel: join('packages', 'core', 'tools', 'lib', 'index.js'),
      exports: ['defineTool'],
    },
    {
      pkg: '@deepseek-ai/dsh-credentials',
      rel: join('packages', 'credentials', 'credentials', 'lib', 'index.js'),
      exports: ['credentialRef'],
    },
    {
      pkg: '@deepseek-ai/dsh-home-paths',
      rel: join('packages', 'util', 'home-paths', 'lib', 'index.js'),
      exports: ['dshHomePath', 'resolveDshHome'],
    },
    {
      pkg: '@deepseek-ai/dsh-fs-sandbox',
      rel: join('packages', 'fs', 'fs-sandbox', 'lib', 'index.js'),
      exports: ['SandboxedFileSystem'],
    },
  ]

  /**
   * Report the first built package that is missing an export third-party
   * plugins import. Returns a human-readable message, or null when everything
   * checks out.
   *
   * Two stages, deliberately:
   *   1. Parse the ESM export statements statically — cheap, no side effects.
   *   2. If a name looks missing, re-check by really importing the module in a
   *      throwaway child process. Static parsing cannot follow `export * from`
   *      or CJS interop, and a false positive here would trigger an endless
   *      update/rollback loop — worse than the bug it guards against.
   *
   * `node` is optional: when omitted it is resolved lazily, only if stage 2 is
   * actually reached. Keep it that way — this runs on every launch, and node
   * detection spawns a subprocess.
   */
  private async detectMissingCriticalExports(node?: {
    path: string
    useElectron: boolean
  }): Promise<string | null> {
    for (const entry of RuntimeSource.CRITICAL_EXPORTS) {
      const filePath = join(this.dir, entry.rel)
      // Package does not exist in this upstream version — nothing to check.
      if (!existsSync(filePath)) continue
      let src: string
      try {
        src = readFileSync(filePath, 'utf-8')
      } catch {
        continue // unreadable — don't fail the build on an I/O hiccup
      }

      const declared = collectEsmExports(src)
      const missing = entry.exports.filter((name) => !declared.has(name))
      if (missing.length === 0) continue

      const actual = await probeModuleExports(node ?? resolveNodeBin(), filePath)
      if (actual === null) continue // probe inconclusive — stay silent
      const stillMissing = missing.filter((name) => !actual.includes(name))
      if (stillMissing.length === 0) continue

      return (
        `构建产物缺少关键导出：${entry.pkg} 未提供「${stillMissing.join('、')}」。` +
          `第三方插件（如 dshmarket、dsh-config-manager）依赖这些导出，缺失会导致启动即崩溃。` +
          `这通常是上游版本引入了 breaking change。`
      )
    }
    return null
  }

  /**
   * Fail the build when a critical export is missing from a built package, so
   * the caller (buildAll → applyUpdate) treats it as a build failure and rolls
   * back to the previously working revision.
   */
  private async verifyCriticalExports(node: {
    path: string
    useElectron: boolean
  }): Promise<void> {
    const problem = await this.detectMissingCriticalExports(node)
    if (problem) {
      throw new Error(
        `${problem}Shell 会尝试回退到上一个可用版本；若是首次安装（尚无历史版本可回退），` +
          `请稍后重试或等待上游修复。`
      )
    }
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
   * Overwrite node_modules/.bin/tsdown with a wrapper pinned to a config
   * loader that actually works for this repository.
   *
   * tsdown's "auto" loader resolves to "unrun" whenever Node's native
   * TypeScript support is unavailable (e.g. Electron's bundled Node 20).
   * unrun bundles config files into temp modules under node_modules/.unrun/,
   * replacing import.meta.url — tsdown.client.ts computes REPOSITORY_ROOT
   * from import.meta.url, so it ends up pointing at the temp directory
   * instead of the workspace root, and workspaceManifest() can't find any
   * workspace manifests.
   *
   * The "tsx" loader is NOT a viable replacement either: tsdown 0.22.2
   * loads workspace configs through a path that tsImport does not
   * transform, and the build dies with "SyntaxError: Unexpected
   * identifier 'as'" on both Node 20 and Node 22 (verified in Linux
   * Docker against the exact Node versions involved).
   *
   * The "native" loader keeps import.meta.url intact and works on every
   * Node this repository supports (engines floor ^22.19 || >=24 — all
   * strip TypeScript natively). We probe the build node for
   * process.features.typescript and force "native" when present. When the
   * probe reports no stripping but the node accepts
   * --experimental-strip-types (distro builds that compile the feature in
   * yet disable it by default), the wrapper passes that flag so "native"
   * works anyway. Only when neither works do we write a plain passthrough
   * wrapper (auto loader, upstream behavior for nodes that cannot build
   * this workspace anyway).
   *
   * The wrapper is ALWAYS written, even as a passthrough: older app
   * versions forced the broken "tsx" loader into this file, and every
   * build must overwrite that stale state.
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
      // Probe the actual build node — NOT the Electron host process — for
      // native TypeScript support. Only that node loads the tsdown configs.
      //
      // `-p process.features.typescript` prints the *string* "false" when
      // stripping is disabled and "undefined" on Node 20 — both truthy as
      // strings, so they must be compared explicitly (a plain `if (probe)`
      // once forced "native" onto a no-strip Node and the build died with
      // ERR_UNKNOWN_FILE_EXTENSION ".ts").
      const probeEnv: NodeJS.ProcessEnv = { ...process.env }
      if (node.useElectron) probeEnv.ELECTRON_RUN_AS_NODE = '1'
      const probeNative = (nodeArgs: string[]): string | null => {
        try {
          return execFileSync(
            node.path,
            [...nodeArgs, '-p', 'process.features.typescript'],
            { encoding: 'utf-8', timeout: 15_000, env: probeEnv },
          ).trim()
        } catch {
          // Non-zero exit: the node rejected the arguments (unknown flag).
          return null
        }
      }
      const nativeEnabled = (value: string | null): boolean =>
        value !== null && value !== '' && value !== 'false' && value !== 'undefined'

      let loaderFlag = ''
      let nodeFlags = ''
      const direct = probeNative([])
      if (nativeEnabled(direct)) {
        loaderFlag = ' --config-loader native'
      } else {
        // Some Node builds ship type stripping compiled in but disabled by
        // default (observed on the user's VM: Node 22.22.1 with
        // features.typescript === false). "native" is the ONLY tsdown
        // config loader that can build this workspace: "unrun" bundles
        // configs with rolldown, which folds import.meta.url onto the entry
        // config path and breaks REPOSITORY_ROOT in tsdown.client.ts
        // ("no packages/*/*/package.json declares the name …"), and "tsx"
        // cannot load workspace subpackage configs at all. Try to switch
        // stripping on explicitly; nodes without the flag keep auto.
        const flagged = probeNative(['--experimental-strip-types'])
        if (nativeEnabled(flagged)) {
          nodeFlags = ' --experimental-strip-types'
          loaderFlag = ' --config-loader native'
        }
      }
      log(
        'launcher',
        `createTsdownWrapper: node probe features.typescript=${direct ?? 'error'}` +
          `${nodeFlags ? ' (strip forced via --experimental-strip-types)' : ''}`,
      )
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
          `"${node.path}"${nodeFlags} "${runMjs}"${loaderFlag} %*\r\n`,
          'utf-8',
        )
      } else {
        const wrapperPath = join(wrapperDir, 'tsdown')
        writeFileSync(
          wrapperPath,
          `#!/bin/sh\nexport NODE_PATH="${nodePath}"\n` +
          `exec "${node.path}"${nodeFlags} "${runMjs}"${loaderFlag} "$@"\n`,
          'utf-8',
        )
        try { chmodSync(wrapperPath, 0o755) } catch { /* best-effort */ }
      }
      log(
        'launcher',
        `createTsdownWrapper: wrapper -> ${node.path}${nodeFlags} ${runMjs}${loaderFlag || ' (auto loader)'}`,
      )
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
      // ── Channel-pinned path ──
      // `ls-remote --tags` answers "is there an update?" without downloading
      // objects, and pins the workspace to a *released* version instead of
      // whatever master's tip happens to be — master carries alpha tags that
      // third-party plugins do not support.
      const target = this.resolveChannelTarget({ force: true })
      if (target) {
        this.touchUpdateCheck()
        const failed = this.readFailedCommit()
        if (target.sha && this.sameCommit(target.sha, failed)) {
          log(
            'launcher',
            `checkUpdate: skipping ${target.selection.tag} (${target.sha.slice(0, 7)}) — recorded as unbuildable`
          )
          return false
        }
        const head = this.currentCommit()
        if (this.sameCommit(head, target.sha)) return false
        return true
      }
      // No channel resolution (offline, or upstream publishes no tags):
      // fall through to the previous branch-tracking behaviour rather than
      // treating "cannot resolve a channel" as "cannot start".
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
        // Only a completed fetch counts as "checked": an offline launch must
        // not suppress every check for the next interval.
        this.touchUpdateCheck()
      } catch {
        progress('无法连接 GitHub（已使用本地版本启动）')
        return false
      }
      try {
        // An update that built unsuccessfully was rolled back and recorded.
        // Offering it again would re-run the same failing build on every
        // launch, so skip it until upstream publishes a different commit.
        const head = this.remoteHead()
        const failed = this.readFailedCommit()
        // remoteHead() is a full 40-char hash while the recorded failure is
        // the 7-char short form, so this has to be a length-tolerant compare —
        // otherwise a known-bad commit is offered again on every launch.
        if (this.sameCommit(head, failed)) {
          log('launcher', `checkUpdate: skipping known-unbuildable commit ${head.slice(0, 7)}`)
          return false
        }
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
      this.touchUpdateCheck()
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
   *
   * @param force - bypass the update-check throttle (user-triggered check).
   */
  async ensureUpdated(progress: ProgressFn, opts: { force?: boolean } = {}): Promise<UpdateResult> {
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

    // Announce a prerelease channel before touching the network, so that a
    // user who later hits a failure already knows what they opted into and
    // that the app repairs itself. No extra network call: this reads config.
    if (this.channelIsRisky()) {
      const def = channelDef(this.channel())
      progress(`当前更新通道：${def.label}（可能与第三方插件不兼容）`)
      progress(`若启动失败会自动切回 next 通道；修复说明见 ${recoveryGuidePath()}`)
    }

    const git = this.getGit()
    if (!git) {
      progress('未检测到 git，已跳过自动更新（使用现有代码启动）')
      return { updated: false, skipped: true, reason: 'no-git' }
    }
    if (!this.shouldCheckUpdate(opts.force ?? false)) {
      log('launcher', 'update check throttled — starting with the local version')
      return { updated: false, skipped: true, reason: 'throttled' }
    }
    const hasUpdate = await this.checkUpdate(progress)
    if (!hasUpdate) {
      return { updated: false, skipped: false }
    }
    progress('发现新版本，正在更新...')
    await this.applyUpdate(progress)
    return { updated: true, skipped: false }
  }

  // ── Orphaned build artifacts ──

  /** Build output directories emitted by the harness build (gitignored). */
  private static readonly ARTIFACT_DIRS = ['lib', 'dist'] as const

  /** Directories that can hold a workspace package: packages/<group>/<pkg>. */
  private packageSlots(): string[] {
    const slots: string[] = []
    const listDirs = (dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(dir, e.name))
      } catch {
        return []
      }
    }
    for (const group of listDirs(join(this.dir, 'packages'))) {
      slots.push(...listDirs(group))
    }
    slots.push(...listDirs(join(this.dir, 'apps')))
    return slots
  }

  /**
   * Delete build output left behind by packages that upstream deleted.
   *
   * `git reset --hard` only touches tracked files, so the compiled `lib/` and
   * `dist/` directories of a removed package survive an update — they are
   * gitignored. The next build then picks those stale `.js` files up as
   * modules and fails the whole repository build with MISSING_EXPORT, because
   * they import symbols the new source no longer exports. Since the build
   * gates startup, the app becomes permanently unlaunchable: every attempt
   * retries the same broken build.
   *
   * A slot counts as orphaned when it holds build output but has no
   * package.json — i.e. the package itself is gone in the new revision. Only
   * the artifact directories are removed; nothing else in the slot is touched.
   *
   * Returns the removed paths (workspace-relative) for logging and progress.
   */
  pruneOrphanedArtifacts(progress?: ProgressFn): string[] {
    const pruned: string[] = []
    for (const slot of this.packageSlots()) {
      if (existsSync(join(slot, 'package.json'))) continue // live package
      for (const artifact of RuntimeSource.ARTIFACT_DIRS) {
        const target = join(slot, artifact)
        if (!existsSync(target)) continue
        try {
          rmSync(target, { recursive: true, force: true })
          pruned.push(target.slice(this.dir.length + 1))
        } catch (err) {
          log('launcher', `pruneOrphanedArtifacts: failed on ${target}: ${(err as Error).message.slice(0, 160)}`)
        }
      }
    }
    if (pruned.length > 0) {
      log('launcher', `pruneOrphanedArtifacts: removed ${String(pruned.length)}: ${pruned.join(', ')}`)
      progress?.(`已清理 ${String(pruned.length)} 个被上游删除包的残留产物`)
    }
    return pruned
  }

  /**
   * Remove ALL build artifacts (lib/, dist/) from every package slot.
   *
   * Unlike pruneOrphanedArtifacts — which only cleans packages that were
   * *deleted* upstream — this removes artifacts from EVERY package regardless
   * of whether it still exists.
   *
   * This is necessary after a channel switch (git reset --hard to a different
   * version) because:
   *
   * 1. The old version's lib/ may import packages that the new version does not
   *    declare as dependencies (e.g. alpha.2's dsh-tools/lib imported
   *    @deepseek-ai/dsh-util-values, but rc.2's source does not). tsdown's
   *    incremental build sees "source unchanged" (comparing against its own cache)
   *    and skips those packages, leaving stale .js that reference nonexistent
   *    modules → ERR_MODULE_NOT_FOUND at runtime.
   *
   * 2. pnpm may restructure node_modules between versions, so even if the
   *    source is identical, the resolved module paths can differ.
   *
   * The cost is a full rebuild of all packages (~30s for backend, ~2min for
   *    frontend), but this only runs after an actual channel switch, not on
   *    every launch.
   */
  cleanAllBuildArtifacts(progress?: ProgressFn): number {
    let removed = 0
    for (const slot of this.packageSlots()) {
      for (const artifact of RuntimeSource.ARTIFACT_DIRS) {
        const target = join(slot, artifact)
        if (!existsSync(target)) continue
        try {
          rmSync(target, { recursive: true, force: true })
          removed++
        } catch (err) {
          log('launcher', `cleanAllBuildArtifacts: failed on ${target}: ${(err as Error).message.slice(0, 160)}`)
        }
      }
    }
    if (removed > 0) {
      log('launcher', `cleanAllBuildArtifacts: removed ${String(removed)} artifact dirs`)
      progress?.(`已清理全部构建产物（${String(removed)} 个目录），准备全量重建...`)
    }
    return removed
  }

  // ── Known-bad update marker ──

  /** Records a remote commit that could not be built, so we stop retrying it. */
  private failedCommitFile(): string {
    return join(this.dir, '.dsh', 'last-failed-commit.txt')
  }

  private readFailedCommit(): string {
    try {
      return readFileSync(this.failedCommitFile(), 'utf-8').trim()
    } catch {
      return ''
    }
  }

  private writeFailedCommit(commit: string): void {
    if (!commit) return
    try {
      mkdirSync(dirname(this.failedCommitFile()), { recursive: true })
      writeFileSync(this.failedCommitFile(), commit, 'utf-8')
      log('launcher', `writeFailedCommit: marking ${commit.slice(0, 7)} as unbuildable`)
    } catch { /* best-effort */ }
  }

  private clearFailedCommit(): void {
    try { rmSync(this.failedCommitFile(), { force: true }) } catch { /* best-effort */ }
  }

  // ── Artifact-repair throttle ──

  /**
   * Timestamp (epoch ms) of the last automatic rebuild triggered by a missing
   * critical export at startup.
   *
   * Keyed on time, not on a commit: the workspace may have no git history at
   * all (ZIP-copied), and there is no stable revision id to key on in that
   * case. Bounding by time caps the worst case at one repair rebuild per day.
   */
  private exportRepairFile(): string {
    return join(this.dir, '.dsh', 'last-export-repair.txt')
  }

  /** Minimum delay between two automatic repair rebuilds. */
  private static readonly EXPORT_REPAIR_COOLDOWN_MS = 24 * 60 * 60 * 1000

  private exportRepairRecentlyAttempted(): boolean {
    try {
      const [rawTs, rawChannel] = readFileSync(this.exportRepairFile(), 'utf-8').trim().split(/\s+/)
      const last = Number(rawTs)
      if (!Number.isFinite(last) || last <= 0) return false
      if (Date.now() - last >= RuntimeSource.EXPORT_REPAIR_COOLDOWN_MS) return false
      // Switching channels *is* a repair, so it earns a fresh attempt. Without
      // this a user escaping a broken prerelease via DSH_CHANNEL or the menu
      // would be blocked by the old channel's cooldown for a full day, with no
      // way to make the app retry.
      return (rawChannel ?? '') === this.channel()
    } catch {
      return false
    }
  }

  private markExportRepairAttempted(): void {
    try {
      mkdirSync(dirname(this.exportRepairFile()), { recursive: true })
      writeFileSync(this.exportRepairFile(), `${Date.now()} ${this.channel()}`, 'utf-8')
    } catch {
      /* best-effort */
    }
  }

  // ── Update-check throttle ──

  /** Timestamp of the last successful remote fetch (epoch ms). */
  private updateCheckFile(): string {
    return join(this.dir, '.dsh', 'last-update-check')
  }

  /**
   * Whether a remote fetch is due.
   *
   * `git fetch` blocked every single startup for ~4.5s before the backend was
   * even spawned. Upstream publishes a few times a day at most, so checking
   * more than once every few hours buys nothing and costs every user every
   * launch. The menu's "检查更新" passes force=true and always fetches.
   */
  private shouldCheckUpdate(force: boolean): boolean {
    if (force) return true
    try {
      const at = Number.parseInt(readFileSync(this.updateCheckFile(), 'utf-8').trim(), 10)
      if (Number.isFinite(at) && Date.now() - at < UPDATE_CHECK_INTERVAL_MS) return false
    } catch { /* no marker → check now */ }
    return true
  }

  /** Record that a remote fetch completed, so the next launches skip it. */
  private touchUpdateCheck(): void {
    try {
      mkdirSync(dirname(this.updateCheckFile()), { recursive: true })
      writeFileSync(this.updateCheckFile(), String(Date.now()), 'utf-8')
    } catch { /* best-effort */ }
  }

  // ── Release channel ──

  /**
   * The channel this workspace follows.
   *
   * Precedence: `DSH_CHANNEL` env var > persisted preference > `next`.
   * The env var exists specifically so a user whose app will not start can
   * escape a broken prerelease without needing the UI to work — documented in
   * ~/.dsh/RECOVERY.md. An empty or unrecognised value falls back to the
   * preference rather than silently pinning to something unexpected.
   */
  channel(): ChannelId {
    const raw = process.env[CHANNEL_ENV_VAR]
    if (raw && raw.trim()) return normalizeChannel(raw.trim())
    return normalizeChannel(loadPreferences().channel ?? DEFAULT_CHANNEL)
  }

  /** True when the channel may break third-party plugins. */
  channelIsRisky(): boolean {
    return channelDef(this.channel()).risky
  }

  /**
   * Persist a channel choice and refresh the on-disk recovery guide.
   * Best-effort: failing to write a help file must never block a switch.
   */
  setChannel(id: ChannelId): void {
    try {
      savePreferences({ channel: id })
    } catch (err) {
      log('launcher', `setChannel: could not persist ${id}: ${(err as Error).message.slice(0, 160)}`)
    }
    const risky = channelDef(id).risky
    const guide = writeRecoveryGuide(id, { logDir: getLogDir(), risky })
    log('launcher', `channel set to ${id}${guide ? ` (recovery guide: ${guide})` : ''}`)
  }

  /**
   * List remote tags via `git ls-remote --tags`.
   *
   * Returns null when git or the network is unavailable, or when upstream
   * publishes no tags at all. Callers treat null as "cannot resolve a
   * channel" and fall back to the previous branch-tracking behaviour — this
   * must never become a new way to fail startup.
   */
  private listRemoteTags(force = false): Array<{ ref: string; sha: string }> | null {
    const git = this.getGit()
    if (!git) return null
    if (!force && this.remoteTags && Date.now() - this.remoteTags.at < TAG_LIST_CACHE_MS) {
      return this.remoteTags.entries
    }
    try {
      this.removeStaleLocks()
      const out = execFileSync(
        git.path,
        ['-C', this.dir, 'ls-remote', '--tags', this.remoteName()],
        {
          encoding: 'utf-8',
          timeout: FETCH_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }
      )
      // `ls-remote --tags` prints an annotated tag twice:
      //   88fa263…  refs/tags/dsh-v0.1.1-rc.2      ← the tag OBJECT
      //   235ed1a…  refs/tags/dsh-v0.1.1-rc.2^{}   ← the commit it points at
      // Only the commit is comparable to HEAD. Taking the first line blind
      // would make every launch think a new version exists (tag sha never
      // equals HEAD sha) and trigger a needless rebuild every single time.
      const byRef = new Map<string, string>()
      for (const line of out.split('\n')) {
        const m = /^([0-9a-f]{7,40})\s+(\S+)$/.exec(line.trim())
        if (!m) continue
        const sha = m[1]
        const deref = m[2].endsWith('^{}')
        const ref = deref ? m[2].slice(0, -3) : m[2]
        if (!ref.startsWith('refs/tags/')) continue
        // A dereferenced line always wins over the tag-object line.
        if (deref || !byRef.has(ref)) byRef.set(ref, sha)
      }
      const entries = [...byRef].map(([ref, sha]) => ({ ref, sha }))
      if (entries.length === 0) return null
      this.remoteTags = { at: Date.now(), entries }
      return entries
    } catch (err) {
      log('launcher', `listRemoteTags failed: ${(err as Error).message.slice(0, 160)}`)
      return null
    }
  }

  /**
   * Resolve a channel to the concrete revision to check out.
   *
   * `sha` comes from the ls-remote listing, so an update can be detected
   * without fetching objects first. Returns null when unresolvable.
   */
  private resolveChannelTarget(
    opts: { force?: boolean; channel?: ChannelId } = {}
  ): ChannelTarget | null {
    const entries = this.listRemoteTags(opts.force ?? false)
    if (!entries) return null
    const requested = opts.channel ?? this.channel()
    const selection = selectChannelTag(requested, entries.map((e) => e.ref))
    if (!selection) return null
    const hit = entries.find((e) => e.ref === `refs/tags/${selection.tag}`)
    if (!hit) return null
    return { selection, sha: hit.sha }
  }

  /**
   * Make a channel's tag available locally so it can be checked out.
   *
   * The workspace is a `--depth 1` clone, so tags have to be fetched
   * explicitly. `+refs/tags/x:refs/tags/x` forces the local tag to move when
   * upstream re-tags a version.
   */
  private ensureTagFetched(target: ChannelTarget, progress?: ProgressFn): boolean {
    const git = this.getGit()
    if (!git) return false
    const tag = target.selection.tag
    try {
      // `^{commit}` dereferences an annotated tag; a plain `refs/tags/x`
      // rev-parse would yield the tag object's sha, which never equals the
      // commit sha we compare against — the fetch would then run every launch.
      const have = this.gitSync(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], {
        timeoutMs: 15_000,
      }).trim()
      if (have === target.sha) return true
    } catch {
      /* tag not present locally yet */
    }
    try {
      this.removeStaleLocks()
      this.gitSync(
        ['fetch', '--depth', '1', this.remoteName(), `+refs/tags/${tag}:refs/tags/${tag}`],
        { timeoutMs: FETCH_TIMEOUT_MS }
      )
      return true
    } catch (err) {
      log('launcher', `ensureTagFetched(${tag}) failed: ${(err as Error).message.slice(0, 200)}`)
      progress?.(`获取标签 ${tag} 失败`)
      return false
    }
  }

  /**
   * Compare two git hashes that may be abbreviated to different lengths.
   *
   * `currentCommit()` returns a 7-char short hash (and normalises an env-var
   * fallback to 7 chars) while `ls-remote` yields the full 40. Comparing those
   * with `===` makes every launch look like there is an update, which would
   * trigger a full rebuild on every single start.
   */
  private sameCommit(a: string, b: string): boolean {
    if (!a || !b) return false
    if (a === 'unknown' || b === 'unknown') return false
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
    return longer.startsWith(shorter)
  }

  /**
   * Full hash currently pointed at by <remote>/<branch>, or '' when unknown.
   * Only used by the branch-tracking fallback; the channel path compares
   * against the resolved tag's sha instead.
   */
  private remoteHead(): string {
    const git = this.getGit()
    if (!git) return ''
    try {
      return this.gitSync(['rev-parse', `${this.remoteName()}/${BRANCH}`], { timeoutMs: 15_000 }).trim()
    } catch {
      return ''
    }
  }

  /** Short, human-readable description of the active channel for progress lines. */
  private channelLabel(target: ChannelTarget | null): string {
    const id = target?.selection.channel ?? this.channel()
    const def = channelDef(id)
    const version = target?.selection.version
    const base = version ? `${def.label} ${version}` : def.label
    return target?.selection.degraded ? `${base}（该通道暂无对应版本，已取可用版本）` : base
  }

  /**
   * Reset working copy to origin/master, reinstall deps when the lockfile
   * changed, then rebuild. Rolls the code back to the previous commit when
   * dependency install fails — and, since the build gates startup, also when
   * the build itself fails (see rollbackAfterBuildFailure).
   */
  async applyUpdate(progress: ProgressFn): Promise<void> {
    const oldHead = this.currentCommit()
    const git = this.getGit()

    const remote = this.remoteName()
    // Prefer the pinned channel tag. Only fall back to the branch tip when no
    // channel could be resolved — master's tip routinely carries alpha tags
    // that the plugin ecosystem does not support.
    const target = this.resolveChannelTarget()
    if (git && target && this.ensureTagFetched(target, progress)) {
      try { this.gitSync(['stash'], { timeoutMs: 30_000 }) } catch { /* nothing to stash */ }
      progress(`更新源码到 ${this.channelLabel(target)}...`)
      this.gitSync(['reset', '--hard', target.sha], { timeoutMs: 60_000 })
      try { this.gitSync(['stash', 'pop'], { timeoutMs: 30_000 }) } catch { /* no stash */ }
    } else if (git) {
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
    // After a git reset --hard (especially a channel switch), stale build
    // artifacts from the old version can reference modules the new version does
    // not provide — e.g. alpha.2's dsh-tools/lib imported @deepseek-ai/dsh-util-values
    // which rc.2 does not declare as a dependency. tsdown's incremental build
    // skips "unchanged" packages, leaving these broken .js in place →
    // ERR_MODULE_NOT_FOUND at runtime. A full artifact clean forces tsdown to
    // rebuild everything from the new source.
    this.cleanAllBuildArtifacts(progress)
    // Code changed → rebuild backend + frontend so the web UI matches.
    try {
      await this.buildAll(progress)
    } catch (err) {
      await this.rollbackAfterBuildFailure(oldHead, progress, err as Error)
      return
    }
    this.clearFailedCommit()
    // Plugin market re-install is deferred (non-critical, see ensureReady).
  }

  /**
   * Recovery for a build that failed right after an update.
   *
   * The build gates startup, so leaving the new-but-unbuildable commit in the
   * working tree makes the app unlaunchable: every launch would repeat the
   * same failure. Two things happen here:
   *
   *   1. The offending remote commit is recorded, so checkUpdate() stops
   *      offering it until upstream publishes something new.
   *   2. The working copy is reset to the commit that ran successfully before
   *      the update and rebuilt, so the app starts on a known-good version.
   *
   * Rebuilding the old code usually works without reinstalling (dependencies
   * are a superset), so we try that first and only reinstall when the plain
   * rebuild fails — a reinstall costs minutes.
   *
   * Throws when the rollback itself cannot be built; that is a real failure
   * the user must see.
   */
  /**
   * Escape hatch for a risky channel that cannot be built: switch to the
   * recommended channel, check it out and rebuild.
   *
   * Persisting the switch matters more than the rebuild succeeding — once the
   * preference says `next`, every later launch resolves to the rc line and the
   * broken prerelease is never offered again. That is what keeps a bad alpha
   * from needing a manual rescue: the app repairs its own configuration.
   *
   * Returns false when any step fails, so the caller can still try the
   * conventional rollback to the previously working commit.
   */
  private async downgradeToSafeChannel(progress: ProgressFn): Promise<boolean> {
    const target = this.resolveChannelTarget({ force: true, channel: DEFAULT_CHANNEL })
    const git = this.getGit()
    if (!target || !git) return false

    progress(`尝鲜通道版本无法构建，正在自动切换到 ${this.channelLabel(target)}...`)
    // Persist first: even if the rebuild below fails, the next launch starts
    // from the safe channel instead of retrying the broken one.
    this.setChannel(DEFAULT_CHANNEL)

    try {
      this.removeStaleLocks()
      if (!this.ensureTagFetched(target, progress)) return false
      this.gitSync(['reset', '--hard', target.sha], { timeoutMs: 60_000 })
    } catch (err) {
      log('launcher', `downgradeToSafeChannel: reset failed: ${(err as Error).message.slice(0, 200)}`)
      return false
    }
    // Channel switch → source code changed for every package. Clean ALL
    // build artifacts so tsdown cannot reuse stale .js from the old version
    // (which may import modules the new version does not provide).
    this.cleanAllBuildArtifacts(progress)
    try {
      await this.buildAll(progress)
    } catch {
      progress('切换后构建仍失败，正在重新安装依赖...')
      try {
        await this.installDeps(progress)
        this.cleanAllBuildArtifacts(progress)
        await this.buildAll(progress)
      } catch (err) {
        log('launcher', `downgradeToSafeChannel: rebuild failed: ${(err as Error).message.slice(0, 200)}`)
        return false
      }
    }
    progress(`已自动切换到 ${this.channelLabel(target)}（本次更新已跳过）`)
    return true
  }

  private async rollbackAfterBuildFailure(
    oldHead: string,
    progress: ProgressFn,
    buildError: Error
  ): Promise<void> {
    // HEAD is already the commit that failed to build (applyUpdate resets
    // before building), which is more accurate than the branch tip when the
    // workspace is pinned to a tag.
    const bad = this.currentCommit()
    this.writeFailedCommit(bad)

    // A prerelease channel that cannot build is a *channel* problem, not a
    // one-off bad commit: rolling back to the previous revision of the same
    // alpha line would fail again on the next launch. Drop to the recommended
    // channel instead.
    if (this.channelIsRisky()) {
      if (await this.downgradeToSafeChannel(progress)) {
        log(
          'launcher',
          `rollbackAfterBuildFailure: auto-downgraded off risky channel, skipped ${bad.slice(0, 7)}`
        )
        return
      }
      log('launcher', 'rollbackAfterBuildFailure: channel downgrade failed — falling back to previous commit')
    }

    const git = this.getGit()
    if (git && oldHead && oldHead !== 'unknown') {
      progress('新版本构建失败，正在回退到上一个可用版本...')
      try {
        this.removeStaleLocks()
        this.gitSync(['reset', '--hard', oldHead], { timeoutMs: 60_000 })
      } catch (err) {
        log('launcher', `rollbackAfterBuildFailure: reset failed: ${(err as Error).message.slice(0, 200)}`)
      }
    }
    // The old revision can have orphans of its own (packages it removed),
    // and the failed build may have left partial artifacts from the new version.
    this.cleanAllBuildArtifacts(progress)

    try {
      await this.buildAll(progress)
    } catch {
      progress('回退后构建仍失败，正在按旧版本重新安装依赖...')
      await this.installDeps(progress)
      this.cleanAllBuildArtifacts(progress)
      await this.buildAll(progress)
    }

    progress('已回退到上一个可用版本（本次更新已跳过）')
    log('launcher', `rollbackAfterBuildFailure: recovered on ${oldHead}, skipped ${bad.slice(0, 7)}`)
    void buildError // surfaced by the caller's progress/log trail
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
