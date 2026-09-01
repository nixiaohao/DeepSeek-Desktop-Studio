/**
 * git-service.ts — the ONLY place that shells out to git.
 *
 * Deliberately read-only in this version. The directory dsh works in is the
 * auto-update workspace: the updater runs `git fetch` / `git reset --hard`
 * against it, so any staged change, commit or checkout we made there would be
 * silently destroyed on the next update. Exposing those operations from a
 * sidebar that looks like an IDE would be actively dangerous, so the panel
 * reports `writeLocked` and offers nothing but status and diffs.
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
import { join } from 'node:path'
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
  async diffText(dir: string, file: string, opts: { staged?: boolean } = {}): Promise<GitDiffResult> {
    if (!dir || !file) return { ok: false, text: '', truncated: false, error: '缺少路径' }
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
 * Does this directory look like the root of a git work tree?
 *
 * `.git` is a directory normally but a FILE for worktrees and submodules, so
 * checking for either is what `git rev-parse` effectively does.
 */
export function looksLikeRepo(dir: string): boolean {
  if (!dir) return false
  return existsSync(join(dir, '.git'))
}
