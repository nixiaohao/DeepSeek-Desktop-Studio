/**
 * Unit tests for src/diagnostics.ts.
 *
 * These tests exist because the two failures this module was written to catch
 * (a dead panel preload, an invisible window) were both diagnosed by reading
 * log files by hand twice. Every case below pins the wording a user is shown
 * when something is broken, not just the severity — a report that says "fail"
 * without saying why is the same blind diagnosis with extra steps.
 *
 * Run with: npm test
 */
const assert = require('node:assert')
const path = require('node:path')

const {
  buildReport,
  formatReport,
  tailLines,
} = require(path.join(__dirname, '..', 'lib-new', 'diagnostics.js'))

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass += 1
  } catch (error) {
    fail += 1
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}

console.log('diagnostics: self-check report')

// A healthy baseline. Every case below perturbs one field from this.
const NOW = 1_700_000_000_000
function input(over = {}) {
  return {
    version: '0.1.0',
    dsh: { version: '0.4.2', port: 8321, channel: 'next' },
    workspace: 'D:/dsh/workspace',
    logDir: 'C:/Users/u/AppData/Roaming/deepseek-studio/logs',
    logDirWritable: true,
    uptimeMs: 125_000,
    views: {
      panel: { readyAt: NOW - 5_000, errors: [] },
      statusbar: { readyAt: NOW - 5_000, errors: [] },
      sidebar: { readyAt: NOW - 4_000, errors: [] },
    },
    window: { width: 1440, height: 900, visible: true },
    health: {
      phase: 'ready',
      lastLineTs: NOW - 2_000,
      exitCode: null,
      recentErrors: 0,
      restartCount: 1,
      detail: '后端运行中',
    },
    healthPhaseLabel: '就绪',
    backendLines: 42,
    env: [
      { id: 'node', label: 'Node.js', ok: true, version: 'v22.11.0', detail: '满足要求' },
      { id: 'git', label: 'Git', ok: true, version: '2.47.0', detail: '可用' },
      { id: 'pnpm', label: 'pnpm', ok: true, version: '9.12.0', detail: '系统 pnpm 可用' },
    ],
    now: NOW,
    ...over,
  }
}

const byId = (report, id) => report.checks.find((c) => c.id === id)

// ── baseline ──

check('a healthy app reports ok with no failures or warnings', () => {
  const r = buildReport(input())
  assert.strictEqual(r.level, 'ok')
  assert.strictEqual(r.summary.fail, 0)
  assert.strictEqual(r.summary.warn, 0)
  assert.ok(r.summary.ok > 0)
})

check('every check carries a non-empty detail', () => {
  // A check that says nothing is worse than no check: the user learns the
  // severity and nothing else.
  const r = buildReport(input())
  for (const c of r.checks) {
    assert.ok(c.detail && c.detail.trim(), `${c.id} has an empty detail`)
  }
})

check('an ok check never carries a hint', () => {
  //
  // KNOWN EQUIVALENT MUTANT. Flipping the guard in `check()` to `hint: hint`
  // survives this suite, and it is not a blind assertion: every call site that
  // produces an `ok` row passes no hint at all, so the guard has nothing to
  // strip and the output is byte-identical. The guard is still worth keeping —
  // it makes "hints render only under non-ok rows" a property of the module
  // instead of a habit every future call site has to remember.
  //
  // If you ever add a call site that passes a hint alongside level 'ok', this
  // assertion stops being equivalent and will start catching the mutation.
  const r = buildReport(input())
  for (const c of r.checks) {
    if (c.level === 'ok') assert.strictEqual(c.hint, '', `${c.id} should not hint`)
  }
})

// ── the preload failure (bug #1) ──

check('a preload that never reported ready is a failure', () => {
  const r = buildReport(input({ views: { panel: { readyAt: 0, errors: [] } } }))
  const c = byId(r, 'view-panel')
  assert.strictEqual(c.level, 'fail')
  assert.strictEqual(r.summary.fail, 1)
})

check('the preload failure carries the captured error, not just a level', () => {
  const r = buildReport(
    input({
      views: { panel: { readyAt: 0, errors: ['Error: module not found ./health-monitor.js'] } },
    }),
  )
  const c = byId(r, 'view-panel')
  assert.ok(c.detail.includes('module not found'), c.detail)
  // The hint has to point at the actual cause, not at "try restarting".
  assert.ok(c.hint.includes('sandbox') || c.hint.includes('require'), c.hint)
})

check('the newest preload error is the one shown', () => {
  const r = buildReport(
    input({
      views: { panel: { readyAt: 0, errors: ['stale: old', 'current: new'] } },
    }),
  )
  const detail = byId(r, 'view-panel').detail
  assert.ok(detail.includes('current: new'), detail)
  assert.ok(!detail.includes('stale: old'), detail)
})

check('a view that was never created is not a failure', () => {
  const r = buildReport(input({ views: {} }))
  assert.strictEqual(byId(r, 'view-panel').level, 'ok')
  assert.strictEqual(r.summary.fail, 0)
})

check('all three overlays are reported separately', () => {
  const r = buildReport(input())
  for (const id of ['view-panel', 'view-statusbar', 'view-sidebar']) {
    assert.ok(byId(r, id), `missing ${id}`)
  }
})

check('a healthy preload reports how long ago it loaded', () => {
  const c = byId(buildReport(input()), 'view-panel')
  assert.ok(/已加载/.test(c.detail), c.detail)
  assert.ok(/秒|分/.test(c.detail), c.detail)
})

// ── the invisible window (bug #2) ──

check('an invisible window with a real size is a failure', () => {
  const r = buildReport(input({ window: { width: 1440, height: 900, visible: false } }))
  const c = byId(r, 'window')
  assert.strictEqual(c.level, 'fail')
  assert.ok(c.detail.includes('不可见'), c.detail)
  assert.ok(c.hint.includes('ready-to-show'), c.hint)
})

check('a zero-sized window is a failure and says so', () => {
  const r = buildReport(input({ window: { width: 0, height: 0, visible: true } }))
  const c = byId(r, 'window')
  assert.strictEqual(c.level, 'fail')
  assert.ok(c.detail.includes('0×0'), c.detail)
})

check('a window that does not exist yet is only a warning', () => {
  const r = buildReport(input({ window: null }))
  assert.strictEqual(byId(r, 'window').level, 'warn')
  assert.strictEqual(r.summary.fail, 0)
})

// ── backend ──

check('an exited backend names its exit code', () => {
  const r = buildReport(
    input({ health: { ...input().health, exitCode: 1, phase: 'exited', detail: '进程退出' } }),
  )
  const c = byId(r, 'backend')
  assert.strictEqual(c.level, 'fail')
  assert.ok(c.detail.includes('1'), c.detail)
})

check('degraded is a warning, error is a failure', () => {
  const base = input().health
  const warn = buildReport(
    input({ health: { ...base, phase: 'degraded', recentErrors: 6 }, healthPhaseLabel: '降级' }),
  )
  const err = buildReport(
    input({ health: { ...base, phase: 'error', recentErrors: 9 }, healthPhaseLabel: '异常' }),
  )
  assert.strictEqual(byId(warn, 'backend').level, 'warn')
  assert.strictEqual(byId(err, 'backend').level, 'fail')
  assert.ok(byId(err, 'backend').detail.includes('9'), byId(err, 'backend').detail)
})

check('idle is not a failure — a quiet agent is not a broken one', () => {
  const r = buildReport(
    input({ health: { ...input().health, phase: 'idle' }, healthPhaseLabel: '空闲' }),
  )
  assert.strictEqual(byId(r, 'backend').level, 'ok')
})

check('no stream at all is a warning, not a failure', () => {
  const r = buildReport(input({ health: null }))
  assert.strictEqual(byId(r, 'backend').level, 'warn')
})

check('an empty output buffer is flagged', () => {
  const r = buildReport(input({ backendLines: 0 }))
  assert.strictEqual(byId(r, 'feed').level, 'warn')
})

// ── environment ──

check('a failing env check is a failure and keeps its own detail', () => {
  const r = buildReport(
    input({
      env: [{ id: 'git', label: 'Git', ok: false, version: '未检测到', detail: '未安装' }],
    }),
  )
  const c = byId(r, 'env-git')
  assert.strictEqual(c.level, 'fail')
  assert.ok(c.detail.includes('未安装'), c.detail)
})

check('pnpm missing is reported ok because the shell bundles its own', () => {
  // env-check deliberately marks pnpm ok:true even when absent; the report must
  // not second-guess that into a failure.
  const r = buildReport(
    input({
      env: [{ id: 'pnpm', label: 'pnpm', ok: true, version: '未检测到', detail: '使用内置 pnpm' }],
    }),
  )
  assert.strictEqual(byId(r, 'env-pnpm').level, 'ok')
})

check('a missing env list does not throw', () => {
  const r = buildReport(input({ env: undefined }))
  assert.strictEqual(r.summary.fail, 0)
})

// ── paths ──

check('an unwritable log directory is a warning', () => {
  const r = buildReport(input({ logDirWritable: false }))
  assert.strictEqual(byId(r, 'logdir').level, 'warn')
  assert.ok(byId(r, 'logdir').detail.includes('不可写'), byId(r, 'logdir').detail)
})

check('a missing workspace is a warning, not a failure', () => {
  const r = buildReport(input({ workspace: '' }))
  assert.strictEqual(byId(r, 'workspace').level, 'warn')
})

check('version info is always present and always ok', () => {
  const c = byId(buildReport(input()), 'env-self')
  assert.strictEqual(c.level, 'ok')
  assert.ok(c.detail.includes('0.1.0'), c.detail)
  assert.ok(c.detail.includes('8321'), c.detail)
})

// ── ordering and summary ──

check('failures sort above warnings, which sort above passes', () => {
  const r = buildReport(
    input({
      window: { width: 0, height: 0, visible: true },
      workspace: '',
      backendLines: 0,
    }),
  )
  const rank = { fail: 0, warn: 1, ok: 2 }
  for (let i = 1; i < r.checks.length; i++) {
    assert.ok(
      rank[r.checks[i - 1].level] <= rank[r.checks[i].level],
      `${r.checks[i - 1].id}(${r.checks[i - 1].level}) before ${r.checks[i].id}(${r.checks[i].level})`,
    )
  }
})

check('the summary counts match the checks', () => {
  const r = buildReport(
    input({ workspace: '', window: { width: 0, height: 0, visible: true }, backendLines: 0 }),
  )
  const counted = { ok: 0, warn: 0, fail: 0 }
  for (const c of r.checks) counted[c.level] += 1
  assert.deepStrictEqual(r.summary, counted)
  assert.strictEqual(r.checks.length, counted.ok + counted.warn + counted.fail)
})

check('top-level level is fail when any check fails', () => {
  const r = buildReport(input({ workspace: '' }))
  assert.strictEqual(r.level, 'warn')
  const f = buildReport(input({ window: { width: 0, height: 0, visible: true } }))
  assert.strictEqual(f.level, 'fail')
})

check('the report timestamp is the injected now, not a fresh clock read', () => {
  assert.strictEqual(buildReport(input()).at, NOW)
})

// ── tailLines ──

check('tailLines returns the last n lines, oldest first', () => {
  assert.deepStrictEqual(tailLines('a\nb\nc\nd', 2), ['c', 'd'])
})

check('tailLines drops a trailing newline instead of an empty last line', () => {
  assert.deepStrictEqual(tailLines('a\nb\n', 5), ['a', 'b'])
})

check('tailLines returns everything when there are fewer than n lines', () => {
  assert.deepStrictEqual(tailLines('a\nb', 5), ['a', 'b'])
})

check('tailLines handles CRLF', () => {
  assert.deepStrictEqual(tailLines('a\r\nb\r\nc', 2), ['b', 'c'])
})

check('tailLines of empty input is empty', () => {
  assert.deepStrictEqual(tailLines('', 5), [])
  assert.deepStrictEqual(tailLines('a', 0), [])
})

check('tailLines honours the byte budget', () => {
  // 40 one-char lines then a marker; a 10-byte budget must cut most of them.
  const text = Array.from({ length: 40 }, (_, i) => String(i)).join('\n') + '\nEND'
  const out = tailLines(text, 100, 10)
  assert.ok(out.length < 10, `expected a truncated tail, got ${out.length} lines`)
  assert.strictEqual(out[out.length - 1], 'END')
})

check('tailLines starts from a line boundary after truncation', () => {
  // The first line of a truncated read is the partial one and is dropped,
  // otherwise the report shows half a log line as if it were a whole one.
  const text = 'x'.repeat(200) + '\nWHOLE\n'
  const out = tailLines(text, 10, 20)
  assert.deepStrictEqual(out, ['WHOLE'])
})

// ── formatReport ──

check('formatReport says how many of each level', () => {
  const r = buildReport(input({ workspace: '' }))
  const text = formatReport(r)
  assert.ok(text.includes('警告'), text)
  assert.ok(text.includes(String(r.summary.ok)), text)
})

check('formatReport marks every line with its level', () => {
  // Deliberately one of EACH level. The [WARN] assertion was missing at first
  // and a mutation that collapsed warn into fail survived — the test only ever
  // looked at a report that had no warnings in it, so the warn tag was never
  // rendered and never checked.
  const text = formatReport(
    buildReport(
      input({
        window: { width: 0, height: 0, visible: true }, // fail
        workspace: '', // warn
      }), // everything else ok
    ),
  )
  assert.ok(/\[FAIL\]/.test(text), text)
  assert.ok(/\[OK\]/.test(text), text)
  assert.ok(
    /\[WARN\]/.test(text),
    `no [WARN] line in a report that has a warning: ${text}`,
  )
})

check('formatReport includes the hint under the failing line', () => {
  const text = formatReport(
    buildReport(input({ window: { width: 0, height: 0, visible: true } })),
  )
  assert.ok(text.includes('建议：'), text)
})

check('formatReport carries no raw token-shaped secret', () => {
  // Reports get pasted into issue reports. The dsh launch token is minted per
  // process, so any 64-hex run here would be a leak.
  const text = formatReport(buildReport(input()))
  assert.ok(!/\b[0-9a-f]{32,}\b/i.test(text), 'found a token-shaped hex run in the report')
})

console.log(`\ndiagnostics: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
