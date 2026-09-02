/**
 * git-service.ts — the ONLY place that shells out to git.
 *
 * Reads are unconditional; WRITES (stage / unstage / commit) exist but are
 * guarded by three checks, all enforced here (see the write section below and
 * docs/analysis-2026-09-01 §3.8). The directory dsh works in is the
 * auto-update workspace: the updater runs `git fetch` / `git reset --hard`
 * against it, so anything we staged or committed there would be silently
 * destroyed on the next update. When the sidebar points at that directory the
 * panel reports `writeLocked`, the UI says so out loud, and every write is
 * refused before git is ever spawned.
 *
 * History-rewriting or work-destroying operations (checkout, reset --hard,
 * clean, branch switching) are deliberately absent — they need a different
 * confirmation design and are not justifiable from a side panel yet.
 *
 * Design rules, same as dsh-stream.ts:
 *  - **No Electron import** — it is `node:child_process` only, so the whole
 *    class can be driven from plain node tests with a fake spawn.
 *  - **Everything is bounded**: a timeout, an output cap, and a diff cap. A
 *    hung `git` (waiting on a credential prompt) or a 200 MB diff must degrade
 *    to a message, never freeze the panel.
 *  - **No shell** — args are passed as an array, so a filename containing
 *    `; rm -rf` is just a filename.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  parsePorcelainZ,
  parseBranch,
  summarizeGitStatus,
  isWithinRoot,
  type GitStatusEntry,
  type GitStatusSummary,
} from './fs-tree.js'

/** Hard ceiling for one git command. Anything longer is almost certainly hung. */
export const GIT_TIMEOUT_MS = 10_000
/** Cap on captured stdout/stderr, characters. A huge repo must not balloon memory. */
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024
/** Diffs bigger than this are reported as too large rather than shipped to the panel. */
export const MAX_DIFF_CHARS = 200 * 1024

/** Minimal shape of a spawned child; lets tests supply a plain fake. */
export interface ChildLike {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void }
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void }
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'close', cb: (code: number | null) => void): void
  kill(): void
}

export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; windowsHide: boolean }
) => ChildLike

export interface GitSnapshot {
  /** False when the directory is not a git work tree. */
  isRepo: boolean
  /** Current branch, or '' when detached / unknown. */
  branch: string
  /** Repo root, which may be ABOVE `dir` when the session runs in a subdir. */
  root: string
  entries: GitStatusEntry[]
  summary: GitStatusSummary
  /**
   * True when this directory is managed by the auto-updater, in which case the
   * shell refuses to write to it and the UI says so out loud.
   */
  writeLocked: boolean
  /** Human-readable problem; absent when everything worked. */
  error?: string
}

export interface GitDiffResult {
  ok: boolean
  /** Unified diff text (already truncated to MAX_DIFF_CHARS). */
  text: string
  truncated: boolean
  error?: string
}

/** Result of a write operation (stage / unstage / commit). */
export interface GitWriteResult {
  ok: boolean
  error?: string
}

/** One write may touch at most this many files (a drag box-selection bug must not stage a whole drive). */
export const WRITE_FILE_LIMIT = 500
/** Hard cap on a commit message coming over IPC. */
export const COMMIT_MESSAGE_MAX = 4000

export interface GitServiceOptions {
  /** Injected in tests; defaults to node's spawn. */
  spawn?: SpawnFn
  /**
   * Returns the directory the auto-updater owns, or null when unknown.
   * Injected rather than imported because workspace.ts pulls in Electron and
   * would make this module untestable.
   */
  getManagedDir?: () => string | null
  /** Override the timeout in tests. */
  timeoutMs?: number
}

const EMPTY_SUMMARY: GitStatusSummary = {
  total: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
}

export class GitService {
  private readonly spawnFn: SpawnFn
  private readonly getManagedDir: () => string | null
  private readonly timeoutMs: number
  /** Cached probe result: '' once git is known to work, else the failure text. */
  private gitProbe: string | null | undefined = undefined

  constructor(opts: GitServiceOptions = {}) {
    this.spawnFn = opts.spawn ?? (spawn as unknown as SpawnFn)
    this.getManagedDir = opts.getManagedDir ?? (() => null)
    this.timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS
  }

  /** Is `dir` the auto-update workspace (or inside it)? */
  isWriteLocked(dir: string): boolean {
    const managed = this.getManagedDir()
    if (!managed || !dir) return false
    return isWithinRoot(managed, dir)
  }

  /**
   * Branch + working-tree status for one directory.
   *
   * Never rejects: a sidebar that throws on a bad directory is worse than one
   * that says "not a git repo".
   */
  async snapshot(dir: string): Promise<GitSnapshot> {
    if (!dir) {
      return { isRepo: false, branch: '', root: '', entries: [], summary: EMPTY_SUMMARY, writeLocked: false, error: '目录为空' }
    }
    if (!existsSync(dir)) {
      return { isRepo: false, branch: '', root: '', entries: [], summary: EMPTY_SUMMARY, writeLocked: false, error: `目录不存在：${dir}` }
    }

    const writeLocked = this.isWriteLocked(dir)

    // One call settles two questions: is this a repo at all, and where is its
    // root (which may sit above `dir`, and is what status paths are relative to).
    const rootRun = await this.run(dir, ['rev-parse', '--show-toplevel'])
    const root = rootRun.code === 0 ? rootRun.stdout.trim() : ''
    if (!root) {
      return {
        isRepo: false,
        branch: '',
        root: '',
        entries: [],
        summary: EMPTY_SUMMARY,
        writeLocked,
        ...(rootRun.error ? { error: rootRun.error } : {}),
      }
    }

    // Two independent facts, fetched in parallel: a detached HEAD must not
    // blank out the status list, and neither depends on the other.
    const [branchRun, statusRun] = await Promise.all([
      this.run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      this.run(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    ])

    const entries = parsePorcelainZ(statusRun.stdout)
    return {
      isRepo: true,
      branch: parseBranch(branchRun.stdout),
      root,
      entries,
      summary: summarizeGitStatus(entries),
      writeLocked,
      ...(statusRun.error ? { error: statusRun.error } : {}),
    }
  }

/**
 * Unified diff for one file.
 *
 * `--` separates paths from options so a filename starting with `-` (legal
 * on every platform) cannot be parsed as a flag.
 */
async diffText(dir: string, file: string, opts: { staged?: boolean } = {}): Promise<GitDiffResult> {    if (!dir || !file) return { ok: false, text: '', truncated: false, error: '缺少路径' }
    // Traversal guard. The renderer hands us strings over IPC; this is the last
    // place before the process boundary where we can refuse.
    if (!isSafeDiffPath(dir, file)) {
      return { ok: false, text: '', truncated: false, error: '路径不在该目录内' }
    }
    const args = ['diff', '--no-color', '--no-ext-diff']
    if (opts.staged) args.push('--cached')
    args.push('--', file)

    const run = await this.run(dir, args)
    if (run.error) return { ok: false, text: '', truncated: false, error: run.error }
    if (run.code !== 0) {
      return { ok: false, text: '', truncated: false, error: run.stderr.trim() || `git diff 退出码 ${run.code}` }
    }
    if (run.stdout.length > MAX_DIFF_CHARS) {
      return { ok: true, text: run.stdout.slice(0, MAX_DIFF_CHARS), truncated: true }
    }
    return { ok: true, text: run.stdout, truncated: false }
  }

  // ── write operations (stage / unstage / commit) ──
  //
  // The class was read-only for a reason: when the sidebar points at the
  // auto-update workspace, the updater runs `git fetch` / `git reset --hard`
  // against it and would silently destroy anything we wrote. Writes are
  // therefore guarded by THREE checks (docs/analysis-2026-09-01 §3.8), all
  // enforced HERE, in the only module that shells out to git — the renderer
  // cannot bypass them by crafting an IPC message:
  //
  //   1. `isWriteLocked(dir)` — the directory is the auto-update workspace
  //      (or inside it): every write is refused, and the sidebar shows why.
  //   2. a live `.git/index.lock` — another process holds the index (an
  //      editor, the updater mid-run): refuse rather than fight over it.
  //      Located via `git rev-parse --git-path` so worktrees/submodules
  //      (where `.git` is a file) resolve correctly.
  //   3. commit refuses an empty/oversized message — a blank commit made by
  //      a mis-click is worse than one not made.
  //
  // What is deliberately NOT here: checkout/reset/clean/branch switching.
  // Those destroy uncommitted work and need a different confirmation design;
  // stage/unstage/commit only move content between the worktree, the index
  // and history — nothing the user typed is ever lost.

  /** Stage current worktree content for the given files. */
  async stage(dir: string, files: readonly string[]): Promise<GitWriteResult> {
    return this.writeFiles(dir, files, ['add', '--'], '暂存')
  }

  /** Unstage (index → HEAD) for the given files. */
  async unstage(dir: string, files: readonly string[]): Promise<GitWriteResult> {
    return this.writeFiles(dir, files, ['reset', '-q', 'HEAD', '--'], '取消暂存')
  }

  /** Commit whatever is staged. Hooks run normally — never skipped. */
  async commit(dir: string, message: string): Promise<GitWriteResult> {
    const guard = await this.guardWrite(dir)
    if (guard) return { ok: false, error: guard }
    const msg = typeof message === 'string' ? message.trim() : ''
    if (!msg) return { ok: false, error: '提交信息不能为空' }
    if (msg.length > COMMIT_MESSAGE_MAX) {
      return { ok: false, error: `提交信息过长（上限 ${COMMIT_MESSAGE_MAX} 字符）` }
    }
    const run = await this.run(dir, ['commit', '-m', msg])
    if (run.error) return { ok: false, error: run.error }
    if (run.code !== 0) {
      // The common failure — no user.name/user.email — deserves a plain
      // sentence rather than git's multi-line hint.
      const err = run.stderr.trim()
      return {
        ok: false,
        error: err.includes('user.name') || err.includes('user.email')
          ? 'git 尚未配置提交身份（user.name / user.email），请先在 git 里配置'
          : err || `git commit 退出码 ${run.code}`,
      }
    }
    return { ok: true }
  }

  private async writeFiles(
    dir: string,
    files: readonly string[],
    cmd: readonly string[],
    verb: string,
  ): Promise<GitWriteResult> {
    const guard = await this.guardWrite(dir)
    if (guard) return { ok: false, error: guard }
    const list = this.safeFileList(dir, files)
    if (typeof list === 'string') return { ok: false, error: list }
    if (list.length === 0) return { ok: false, error: `未选择任何要${verb}的文件` }
    const run = await this.run(dir, [...cmd, ...list])
    if (run.error) return { ok: false, error: run.error }
    if (run.code !== 0) {
      return { ok: false, error: run.stderr.trim() || `git ${cmd[0]} 退出码 ${run.code}` }
    }
    return { ok: true }
  }

  /**
   * The three write guards, shared by every entry point. Returns the refusal
   * reason, or null when the write may proceed.
   */
  private async guardWrite(dir: string): Promise<string | null> {
    if (!dir) return '目录为空'
    if (this.isWriteLocked(dir)) return '此目录由自动更新管理，禁止写操作'
    const lock = await this.indexLockPath(dir)
    if (lock && existsSync(lock)) return 'git 正被其他进程占用（index.lock），请稍后再试'
    return null
  }

  /**
   * Ask git itself where the index lock lives, so worktrees/submodules
   * (where `.git` is a FILE pointing elsewhere) resolve correctly. A null
   * answer means "could not ask" — treated as no lock rather than a veto,
   * because the write attempt itself will fail honestly if there is one.
   */
  private async indexLockPath(dir: string): Promise<string | null> {
    const run = await this.run(dir, ['rev-parse', '--git-path', 'index.lock'])
    if (run.code !== 0) return null
    const out = run.stdout.trim()
    if (!out) return null
    return isAbsolute(out) ? out : join(dir, out)
  }

  /**
   * Validate a renderer-supplied file list: strings only, inside `dir`,
   * no `..`, deduped, bounded. Returns the cleaned list, or an error string.
   */
  private safeFileList(dir: string, files: readonly string[]): string[] | string {
    if (!Array.isArray(files)) return '文件列表无效'
    if (files.length > WRITE_FILE_LIMIT) return `一次最多操作 ${WRITE_FILE_LIMIT} 个文件`
    const out: string[] = []
    for (const f of files) {
      if (typeof f !== 'string' || f.length === 0) return '文件列表包含空路径'
      if (!isSafeDiffPath(dir, f)) return '路径不在该目录内'
      if (!out.includes(f)) out.push(f)
    }
    return out
  }

  // ── destructive operations (checkout / discard) ──
  //
  // These DESTROY uncommitted work — that is their purpose — so they carry
  // one extra requirement beyond the three write guards: the confirmation is
  // the page's job (docs/analysis-2026-09-01 §3.8: "checkout 等破坏性操作
  // 二次确认"), but these server-side limits make a confirmed mistake as
  // small as it can be:
  //
  //   - discardFile only touches files that are tracked AND have unstaged
  //     changes (restored from the index). Staged content survives — the
  //     user explicitly staged it, so a stray click must not take it too.
  //     Untracked files are refused outright: `checkout --` cannot remove
  //     them, and deleting them is a different, bigger decision.
  //   - checkoutBranch validates the branch name against a conservative
  //     pattern, so a renderer string can never become a git option.

  /** Local branches, current one first and marked. */
  async listBranches(dir: string): Promise<{ ok: boolean; branches?: { name: string; current: boolean }[]; error?: string }> {
    if (!dir) return { ok: false, error: '目录为空' }
    if (this.isWriteLocked(dir)) return { ok: false, error: '此目录由自动更新管理，禁止写操作' }
    const run = await this.run(dir, ['branch', '--format=%(refname:short)'])
    if (run.error) return { ok: false, error: run.error }
    if (run.code !== 0) {
      return { ok: false, error: run.stderr.trim() || `git branch 退出码 ${run.code}` }
    }
    // `git branch` marks the current branch with `* ` (and `+` for worktrees,
    // which are NOT this worktree's current branch — leave them unmarked).
    // The marker is stripped from every name first; the current detection
    // then looks at the raw lines.
    const branches = run.stdout
      .split('\n')
      .map((line) => line.replace(/^[*+]\s+/, '').trim())
      .filter((line) => line.length > 0)
      .map((name) => ({ name, current: false }))
    const current = run.stdout.split('\n').find((line) => line.startsWith('* '))
    if (current) {
      const name = current.replace(/^[*+]\s+/, '').trim()
      const mark = branches.find((b) => b.name === name)
      if (mark) mark.current = true
    }
    return { ok: true, branches }
  }

  /**
   * Switch to a local branch. Git itself refuses when uncommitted changes
   * would be clobbered; that refusal is surfaced verbatim, not worked
   * around — silently stashing would be the destructive surprise here.
   */
  async checkoutBranch(dir: string, branch: string): Promise<GitWriteResult> {
    const guard = await this.guardWrite(dir)
    if (guard) return { ok: false, error: guard }
    if (!isSafeBranchName(branch)) return { ok: false, error: '分支名无效' }
    const run = await this.run(dir, ['checkout', branch])
    if (run.error) return { ok: false, error: run.error }
    if (run.code !== 0) {
      return { ok: false, error: run.stderr.trim() || `git checkout 退出码 ${run.code}` }
    }
    return { ok: true }
  }

  /**
   * Discard ONE file's unstaged changes (worktree → index).
   *
   * Refuses untracked files (nothing to restore from) and files with no
   * unstaged side — a click on a clean row must be a no-op, not an accident
   * waiting for a second one.
   */
  async discardFile(dir: string, file: string, status: { staged: boolean; unstaged: boolean; untracked: boolean }): Promise<GitWriteResult> {
    const guard = await this.guardWrite(dir)
    if (guard) return { ok: false, error: guard }
    if (typeof file !== 'string' || file.length === 0) return { ok: false, error: '空路径' }
    if (!isSafeDiffPath(dir, file)) return { ok: false, error: '路径不在该目录内' }
    if (status.untracked) return { ok: false, error: '未跟踪文件没有可放弃的基线，请直接删除文件' }
    if (!status.unstaged) return { ok: false, error: '该文件没有未暂存的改动' }
    const run = await this.run(dir, ['checkout', '--', file])
    if (run.error) return { ok: false, error: run.error }
    if (run.code !== 0) {
      return { ok: false, error: run.stderr.trim() || `git checkout 退出码 ${run.code}` }
    }
    return { ok: true }
  }

  /**
   * Run one git command. Never rejects; failures come back in the result.
   *
   * A rejected promise here would propagate out of an IPC handler as a generic
   * "Error invoking remote method", which tells the user nothing.
   */
  private async run(dir: string, args: readonly string[]): Promise<RunResult> {
    const missing = await this.probeGit(dir)
    if (missing) return { code: -1, stdout: '', stderr: '', error: missing }

    return new Promise<RunResult>((resolve) => {
      let child: ChildLike
      try {
        child = this.spawnFn('git', args, { cwd: dir, windowsHide: true })
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: '', error: `无法启动 git：${(err as Error).message}` })
        return
      }

      let out = ''
      let errText = ''
      let settled = false
      const finish = (result: RunResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        finish({ code: -1, stdout: out, stderr: errText, error: `git ${args[0]} 超时（${this.timeoutMs / 1000}s）` })
      }, this.timeoutMs)

      child.stdout.on('data', (chunk) => {
        if (out.length < MAX_OUTPUT_CHARS) out += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        if (errText.length < MAX_OUTPUT_CHARS) errText += String(chunk)
      })
      child.on('error', (err) => {
        // ENOENT means git is not on PATH — the common case, and worth saying
        // plainly instead of surfacing "spawn git ENOENT".
        const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? '未找到 git，请安装 Git 后重启本程序'
          : `git 启动失败：${err.message}`
        this.gitProbe = msg
        finish({ code: -1, stdout: '', stderr: '', error: msg })
      })
      child.on('close', (code) => {
        finish({ code: code ?? -1, stdout: out, stderr: errText })
      })
    })
  }

  /**
   * One-time check that git exists, so every failure says the same thing.
   *
   * The SUCCESS is cached too: without that, every `run()` would pay an extra
   * `git --version` spawn, and a single snapshot() spawns three commands.
   */
  private async probeGit(dir: string): Promise<string | null> {
    if (this.gitProbe !== undefined) return this.gitProbe || null
    const result = await new Promise<number>((resolve) => {
      let child: ChildLike
      try {
        child = this.spawnFn('git', ['--version'], { cwd: dir, windowsHide: true })
      } catch {
        resolve(-1)
        return
      }
      let settled = false
      const done = (code: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(code)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* gone */ }
        done(-1)
      }, 5_000)
      child.on('error', () => done(-1))
      child.on('close', (code) => done(code ?? -1))
    })
    this.gitProbe = result === 0 ? '' : '未找到 git，请安装 Git 后重启本程序'
    return this.gitProbe || null
  }
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
  error?: string
}

/**
 * Accept an absolute path inside `dir`, or a repo-relative path from
 * `git status` — but never one that climbs out with `..`.
 */
function isSafeDiffPath(dir: string, file: string): boolean {
  const normalized = file.replace(/\\/g, '/')
  if (normalized.split('/').includes('..')) return false
  const isAbsolute = normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('//')
  if (!isAbsolute) return true
  return isWithinRoot(dir, file)
}

/**
 * Conservative branch-name check for strings that crossed the IPC boundary.
 * Local branches are letters/digits plus `._/-` separators; ruling out
 * leading `-` and whitespace means the name can never be parsed as a git
 * option or smuggle extra arguments.
 */
export function isSafeBranchName(name: string): boolean {
  return typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
}

/**
 * Does this directory look like the root of a git work tree?
 *
 * `.git` is a directory normally but a FILE for worktrees and submodules, so
 * checking for either is what `git rev-parse` effectively does.
 */
export function looksLikeRepo(dir: string): boolean {
  if (!dir) return false
  return existsSync(join(dir, '.git'))
}
