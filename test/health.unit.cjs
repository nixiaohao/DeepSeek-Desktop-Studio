/**
 * Unit tests for the backend health state machine
 * (src/health-monitor.ts → lib-new/health-monitor.js).
 *
 * This module is deliberately pure logic with time passed in, so the whole
 * state machine is exercised here without Electron. Two behaviours are pinned
 * on purpose because they are easy to regress and expensive when wrong:
 *
 *   1. Silence must degrade to `idle`, never to an error — an agent that is
 *      thinking produces no output, and false alarms destroy trust in the
 *      monitor (and would tempt someone into auto-restarting live sessions).
 *   2. Error counting must use a sliding window, not a lifetime counter.
 *
 * A recursion guard is included: the notify path once called snapshot(), which
 * called setPhase(), which called emit() — infinite recursion.
 *
 * Run with: npm test
 */
const path = require('node:path')
const {
  HealthMonitor,
  PHASE_LABEL,
} = require(path.join(__dirname, '..', 'lib-new', 'health-monitor.js'))

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(
      `  FAIL  ${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`
    )
  }
}

const T0 = 1_700_000_000_000 // fixed clock base
const line = (ts, stream = 'out') => ({ ts, stream, text: 'x' })

console.log('health-monitor: initial state')
{
  const m = new HealthMonitor()
  check('starts in starting', m.snapshot(T0).phase, 'starting')
  check('no lines seen yet', m.snapshot(T0).lastLineTs, 0)
  check('no restarts yet', m.snapshot(T0).restartCount, 0)
}

console.log('health-monitor: ready and normal output')
{
  const m = new HealthMonitor()
  m.noteReady()
  check('ready after noteReady', m.snapshot(T0).phase, 'ready')
  m.feedLine(line(T0))
  check('lastLineTs recorded', m.snapshot(T0).lastLineTs, T0)
  check('still ready 60s later', m.snapshot(T0 + 60_000).phase, 'ready')
}

console.log('health-monitor: silence is idle, never an error')
{
  const m = new HealthMonitor()
  m.noteReady()
  m.feedLine(line(T0))
  check('119s quiet → still ready', m.snapshot(T0 + 119_000).phase, 'ready')
  const s = m.snapshot(T0 + 121_000)
  check('121s quiet → idle', s.phase, 'idle')
  check('idle is not degraded/exited', ['degraded', 'exited', 'error'].includes(s.phase), false)
  check('idle detail mentions no output', /无输出/.test(s.detail), true)
  // Recovery: output resumes → back to ready
  m.feedLine(line(T0 + 130_000))
  check('output resumes → ready again', m.snapshot(T0 + 130_000).phase, 'ready')
}

console.log('health-monitor: error sliding window')
{
  const m = new HealthMonitor()
  m.noteReady()
  for (let i = 0; i < 4; i++) m.feedLine({ ts: T0 + i, stream: 'err', text: 'boom' })
  check('4 errors → still ready', m.snapshot(T0 + 1_000).phase, 'ready')
  check('4 errors counted', m.snapshot(T0 + 1_000).recentErrors, 4)

  m.feedLine({ ts: T0 + 5, stream: 'err', text: 'boom' })
  const s = m.snapshot(T0 + 1_000)
  check('5 errors → degraded', s.phase, 'degraded')
  check('5 errors counted', s.recentErrors, 5)

  // Window slides: the old errors drop out and health recovers. A lifetime
  // counter would keep this session yellow forever.
  const later = m.snapshot(T0 + 61_000)
  check('errors expire out of window', later.recentErrors, 0)
  check('recovers to ready', later.phase, 'ready')
}

console.log('health-monitor: terminal states')
{
  const m = new HealthMonitor()
  m.noteReady()
  m.noteExit(1)
  const s = m.snapshot(T0)
  check('exit → exited', s.phase, 'exited')
  check('exit code recorded', s.exitCode, 1)

  m.noteReady()
  check('noteReady cannot revive an exited backend', m.snapshot(T0).phase, 'exited')
}

console.log('health-monitor: spawn error')
{
  const m = new HealthMonitor()
  m.noteSpawnError('ENOENT node')
  const s = m.snapshot(T0)
  check('spawn failure → error', s.phase, 'error')
  check('detail carries the message', /ENOENT/.test(s.detail), true)
}

console.log('health-monitor: restart resets counters')
{
  const m = new HealthMonitor()
  m.noteReady()
  for (let i = 0; i < 6; i++) m.feedLine({ ts: T0 + i, stream: 'err', text: 'boom' })
  check('degraded before restart', m.snapshot(T0 + 1_000).phase, 'degraded')

  m.noteRestart()
  const s = m.snapshot(T0 + 2_000)
  check('restart → starting', s.phase, 'starting')
  check('restart increments counter', s.restartCount, 1)
  check('restart clears error window', s.recentErrors, 0)
  check('restart clears exit code', s.exitCode, null)
  check('restart clears lastLineTs', s.lastLineTs, 0)
}

console.log('health-monitor: notify path (recursion guard)')
{
  const m = new HealthMonitor()
  let notifications = 0
  const unsub = m.subscribe(() => { notifications++ })
  m.noteReady()
  check('listener notified on phase change', notifications > 0, true)

  // Every feedLine emits; if emit() ever calls snapshot() again this blows the
  // stack instead of merely failing.
  let threw = null
  try {
    for (let i = 0; i < 500; i++) m.feedLine(line(T0 + i))
  } catch (e) {
    threw = e && e.message
  }
  check('500 feeds without stack overflow', threw, null)

  // A listener that throws must not break monitoring.
  const m2 = new HealthMonitor()
  m2.subscribe(() => { throw new Error('bad listener') })
  let threw2 = null
  try {
    m2.noteReady()
    m2.feedLine(line(T0))
  } catch (e) {
    threw2 = e && e.message
  }
  check('throwing listener is contained', threw2, null)

  unsub()
  const before = notifications
  m.noteExit(0)
  check('unsubscribe stops notifications', notifications, before)
}

console.log('health-monitor: labels')
{
  const phases = ['starting', 'ready', 'idle', 'degraded', 'exited', 'error']
  check('every phase has a Chinese label', phases.every((p) => typeof PHASE_LABEL[p] === 'string'), true)
}

console.log(`\nhealth-monitor: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
