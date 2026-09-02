/**
 * diagnostics.ts — Self-check report assembly. Pure logic, zero runtime imports.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two failures have now been diagnosed by reading logs by hand, because nothing
 * in the app could say what was wrong:
 *
 *   1. "面板桥接不可用（preload 未加载）" — the panel overlay's preload threw,
 *      so `window.dshPanel` was never exposed and the panel rendered a dead
 *      fallback string.
 *   2. "点击后只在任务栏上有个图标，不显示窗口" — `ready-to-show` never fired
 *      because the page errored during load, and the window stayed hidden.
 *
 * Both are invisible from inside the shell's own UI: in (1) the panel is the
 * thing that is broken, and in (2) there is no window to look at. The report
 * therefore has to be assembled from main-process state and rendered in a
 * SEPARATE window (see assets/diagnostics.html).
 *
 * WHY IT IS PURE
 * --------------
 * Every input is passed in as plain data. Nothing here touches Electron, the
 * filesystem, or the clock directly, so the whole thing — including the exact
 * wording a user sees when something is broken — is unit-testable in plain
 * node. That matters because the failure modes are precisely the ones that
 * cannot be reproduced on demand.
 *
 * Levels are `ok` / `warn` / `fail`. `warn` means "still usable, but this is
 * what will bite you next"; `fail` means "a feature is actually gone".
 */

/** Severity of a single check. */
export type CheckLevel = 'ok' | 'warn' | 'fail'

/** One row of the report. */
export interface Check {
  /** Stable id so the UI can keep scroll position across refreshes. */
  id: string
  /** Short Chinese label. */
  label: string
  level: CheckLevel
  /** What was actually observed. Never empty — a check that says nothing is useless. */
  detail: string
  /** What to do about it. Empty when level === 'ok'. */
  hint: string
}

/** Per-overlay preload readiness, as recorded by window-manager. */
export interface ViewState {
  /** Epoch ms when the preload reported ready; 0 when it never did. */
  readyAt: number
  /**
   * Preload / renderer failure strings captured for this view, oldest first.
   * These are the ONLY record of why a preload died — once it has thrown, that
   * view can no longer be asked anything.
   */
  errors: string[]
}

/** Everything the report needs, gathered by the main process. */
export interface DiagnosticsInput {
  /** App version string. */
  version: string
  /** dsh version, port and update channel. */
  dsh: { version: string; port: number | null; channel: string }
  /** Absolute workspace (dsh working directory). */
  workspace: string
  /** Absolute log directory; empty when it could not be created. */
  logDir: string
  /** True when the log directory is writable right now. */
  logDirWritable: boolean
  /** Process uptime in ms. */
  uptimeMs: number
  /** Which overlays exist at all — an intentionally hidden panel is not a failure. */
  views: Record<string, ViewState | undefined>
  /** Main window geometry; null before the window exists. */
  window: { width: number; height: number; visible: boolean } | null
  /** Health snapshot; null when the stream was never connected. */
  health: {
    phase: string
    lastLineTs: number
    exitCode: number | null
    recentErrors: number
    restartCount: number
    detail: string
  } | null
  /** Chinese label for the current health phase. */
  healthPhaseLabel: string
  /** Backend output lines currently buffered; 0 means nothing has arrived. */
  backendLines: number
  /** env-check rows (node / git / pnpm). */
  env: { id: string; label: string; ok: boolean; version: string; detail: string }[]
  /** Epoch ms — injected, not read from the clock, so reports are reproducible. */
  now: number
}

export interface DiagnosticsSummary {
  ok: number
  warn: number
  fail: number
}

export interface DiagnosticsReport {
  /** Epoch ms the report was assembled. */
  at: number
  checks: Check[]
  summary: DiagnosticsSummary
  /** Highest level present; 'ok' when everything passed. */
  level: CheckLevel
}

/**
 * Last `n` lines of a text blob, oldest first.
 *
 * `limit` is a BYTE budget read from the tail, not a line count, because the
 * caller is deciding how much of a 2 MB log file it is willing to pull over an
 * IPC boundary. Lines are then counted from what was read.
 *
 * A trailing newline does not produce an empty final line: log files end with
 * one and an empty row in the report looks like a dropped line.
 */
export function tailLines(text: string, n: number, limitBytes = 65_536): string[] {
  if (n <= 0 || !text) return []
  // Slice by UTF-16 units, which is what a JS string index is.
  const truncated = text.length > limitBytes
  const slice = truncated ? text.slice(text.length - limitBytes) : text
  //
  // Only skip the first line when we actually cut: it is a partial line, and
  // showing half a log line as if it were a whole one is worse than dropping
  // it. Skipping it unconditionally would eat a real first line whenever the
  // file fits in the budget — which is the common case for three of the four
  // logs.
  const cut = truncated ? slice.indexOf('\n') : -1
  const body = cut >= 0 ? slice.slice(cut + 1) : slice
  const lines = body.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  // When a single line is longer than the whole budget there is no '\n' to cut
  // at, so the partial line is all we have. Keep it: a lone surrogate renders
  // as U+FFFD, which is honest for a truncated log tail.
  return lines.slice(Math.max(0, lines.length - n))
}

const LEVEL_RANK: Record<CheckLevel, number> = { fail: 0, warn: 1, ok: 2 }

function check(id: string, label: string, level: CheckLevel, detail: string, hint = ''): Check {
  return { id, label, level, detail, hint: level === 'ok' ? '' : hint }
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

/**
 * Assemble the report.
 *
 * Never throws and never returns a partial list because one input was missing:
 * a diagnostics view that fails to open is worse than no diagnostics view, and
 * the inputs are gathered from subsystems that may not exist yet.
 */
export function buildReport(input: DiagnosticsInput): DiagnosticsReport {
  const checks: Check[] = []
  const push = (c: Check): void => {
    checks.push(c)
  }

  // ── the two failures that started all this ──

  for (const name of ['panel', 'statusbar', 'sidebar']) {
    const view = input.views?.[name]
    const label = name === 'panel' ? '监控面板' : name === 'statusbar' ? '状态栏' : '文件侧栏'
    if (!view) {
      push(check(`view-${name}`, `${label} preload`, 'ok', '未启用（未创建该视图）'))
      continue
    }
    if (view.readyAt > 0) {
      const age = Math.max(0, input.now - view.readyAt)
      push(check(`view-${name}`, `${label} preload`, 'ok', `已加载（${fmtDuration(age)}前）`))
      continue
    }
    const err = view.errors.length ? ` ${view.errors[view.errors.length - 1]}` : ''
    push(
      check(
        `view-${name}`,
        `${label} preload`,
        'fail',
        `未加载：该视图的 preload 脚本没有上报就绪。${err}`.trim(),
        '最常见原因是沙箱化的 preload 里 require 了项目文件（Electron 22+ 只允许 require("electron")），' +
          '或该 js 文件没有随 app.asar 打包。打开日志文件夹看 launcher.log 里的 preload-error 行。',
      ),
    )
  }

  if (!input.window) {
    push(check('window', '主窗口', 'warn', '窗口尚未创建'))
  } else if (input.window.width <= 0 || input.window.height <= 0) {
    push(
      check(
        'window',
        '主窗口',
        'fail',
        `尺寸为 0（${input.window.width}×${input.window.height}）`,
        '窗口被创建但没有尺寸，通常是 show 之前就出错导致 bounds 从未设置。',
      ),
    )
  } else if (!input.window.visible) {
    push(
      check(
        'window',
        '主窗口',
        'fail',
        `不可见（${input.window.width}×${input.window.height}）`,
        '窗口已创建但从未显示——页面加载出错时 ready-to-show 不会触发。' +
          '应用有 12 秒兜底强制显示；若仍然只有任务栏图标，看 launcher.log 的页面加载错误。',
      ),
    )
  } else {
    push(check('window', '主窗口', 'ok', `可见（${input.window.width}×${input.window.height}）`))
  }

  // ── backend ──

  if (!input.health) {
    push(
      check(
        'backend',
        '后端服务',
        'warn',
        '未连接（变更流尚未建立）',
        '若 agent 已运行一段时间仍如此，检查 dsh web 是否真的在监听，以及端口是否被占用。',
      ),
    )
  } else {
    const h = input.health
    const since = h.lastLineTs > 0 ? fmtDuration(Math.max(0, input.now - h.lastLineTs)) : '从未'
    if (h.exitCode !== null) {
      push(
        check(
          'backend',
          '后端服务',
          'fail',
          `已退出，退出码 ${h.exitCode}（${h.detail}）`,
          '用面板上的「重启服务」恢复；若退出码反复出现，看 backend.log 末尾。',
        ),
      )
    } else if (h.phase === 'error') {
      push(
        check(
          'backend',
          '后端服务',
          'fail',
          `${input.healthPhaseLabel}：${h.detail}（最近 1 分钟错误 ${h.recentErrors} 行，距上次输出 ${since}）`,
          '看 backend.log 末尾与面板的「运行监控」区。',
        ),
      )
    } else if (h.phase === 'degraded') {
      push(
        check(
          'backend',
          '后端服务',
          'warn',
          `${input.healthPhaseLabel}：${h.detail}（最近 1 分钟错误 ${h.recentErrors} 行，距上次输出 ${since}）`,
          '还能用，但错误在堆积。',
        ),
      )
    } else if (h.phase === 'idle') {
      push(
        check(
          'backend',
          '后端服务',
          'ok',
          `${input.healthPhaseLabel}：${h.detail}（距上次输出 ${since}）`,
        ),
      )
    } else {
      push(
        check(
          'backend',
          '后端服务',
          'ok',
          `${input.healthPhaseLabel}：${h.detail}（距上次输出 ${since}，重启 ${h.restartCount} 次）`,
        ),
      )
    }
  }

  push(
    input.backendLines > 0
      ? check('feed', '后端输出', 'ok', `已缓冲 ${input.backendLines} 行`)
      : check(
          'feed',
          '后端输出',
          'warn',
          '缓冲区为空',
          '若后端已连接却一行都没有，输出可能没走 appendChildOutput，或日志被清空过。',
        ),
  )

  // ── environment ──

  for (const e of input.env ?? []) {
    push(
      check(
        `env-${e.id}`,
        e.label,
        e.ok ? 'ok' : 'fail',
        `${e.version} — ${e.detail}`,
        e.ok ? '' : '按提示安装或升级后重启应用。',
      ),
    )
  }

  // ── paths ──

  push(
    input.logDir && input.logDirWritable
      ? check('logdir', '日志目录', 'ok', input.logDir)
      : check(
          'logdir',
          '日志目录',
          'warn',
          input.logDir ? `${input.logDir}（不可写）` : '目录未创建',
          '日志写不进去时，其它一切都将无法诊断。检查磁盘权限与剩余空间。',
        ),
  )

  push(
    input.workspace
      ? check('workspace', '工作区', 'ok', input.workspace)
      : check(
          'workspace',
          '工作区',
          'warn',
          '未设置',
          '工作区由自动更新使用 git 管理，不要把自己的代码放进去——每次更新都会被 reset。',
        ),
  )

  push(
    check(
      'env-self',
      '版本信息',
      'ok',
      `shell ${input.version} · dsh ${input.dsh.version || '未知'} · 通道 ${input.dsh.channel} · ` +
        `端口 ${input.dsh.port ?? '未分配'} · 已运行 ${fmtDuration(input.uptimeMs)}`,
    ),
  )

  checks.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])

  const summary: DiagnosticsSummary = { ok: 0, warn: 0, fail: 0 }
  for (const c of checks) summary[c.level] += 1

  return {
    at: input.now,
    checks,
    summary,
    level: summary.fail ? 'fail' : summary.warn ? 'warn' : 'ok',
  }
}

/**
 * Plain-text rendering of a report, for clipboard copy.
 *
 * Deliberately free of any token: reports get pasted into issue reports, and
 * the dsh launch token is minted per process. Callers must run the whole text
 * through `redactTokenInText` before it leaves the process.
 */
export function formatReport(report: DiagnosticsReport): string {
  const head = `DeepSeek Studio 自检报告 · ${new Date(report.at).toISOString()} · ` +
    `通过 ${report.summary.ok} / 警告 ${report.summary.warn} / 失败 ${report.summary.fail}`
  const lines = report.checks.map((c) => {
    const tag = c.level === 'ok' ? '[OK]  ' : c.level === 'warn' ? '[WARN]' : '[FAIL]'
    let out = `${tag} ${c.label}：${c.detail}`
    if (c.hint) out += `\n       建议：${c.hint}`
    return out
  })
  return [head, ...lines].join('\n')
}
