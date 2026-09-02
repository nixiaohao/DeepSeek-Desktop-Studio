/**
 * Unit tests for src/command-registry.ts — pure logic, plain node.
 *
 * The actions are a fake MenuActions-shaped object; nothing here touches
 * Electron. Run with: node test/command-registry.unit.cjs   (wired into `npm test`)
 */
const assert = require('node:assert')
const path = require('node:path')
const {
  buildCommandList,
  dispatchCommand,
} = require(path.join(__dirname, '..', 'lib-new', 'command-registry.js'))

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    pass++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    fail++
    console.log(`  FAIL  ${name}\n        ${err.message}`)
  }
}

// A fake MenuActions: every action records the call.
function fakeActions() {
  const calls = []
  const rec = (name) => () => calls.push(name)
  return {
    calls,
    actions: {
      toggleSidebar: rec('toggleSidebar'),
      togglePanel: rec('togglePanel'),
      toggleStatusBar: rec('toggleStatusBar'),
      toggleLogbar: rec('toggleLogbar'),
      setLayout: (id) => calls.push(`setLayout:${id}`),
      setUiScale: (s) => calls.push(`setUiScale:${s}`),
      restartBackend: rec('restartBackend'),
      openLogs: rec('openLogs'),
      openDiagnostics: rec('openDiagnostics'),
      describeEditor: () => '系统默认',
      chooseEditor: rec('chooseEditor'),
      openSettings: rec('openSettings'),
      revealPrefs: rec('revealPrefs'),
      onCheckUpdate: rec('onCheckUpdate'),
      onShowAbout: rec('onShowAbout'),
    },
  }
}

const scales = [
  { value: 0.85, label: '85%' },
  { value: 1, label: '100%' },
  { value: 1.15, label: '115%' },
  { value: 1.3, label: '130%' },
]

// ── buildCommandList ──

test('the list covers every toggle, window and app action plus one row per scale', () => {
  const { actions } = fakeActions()
  const list = buildCommandList({ actions, scales })
  const ids = list.map((c) => c.id)
  for (const id of ['toggle-sidebar', 'toggle-panel', 'toggle-statusbar', 'toggle-logbar',
    'open-settings', 'open-diagnostics', 'restart-backend', 'open-logs',
    'choose-editor', 'reveal-prefs', 'check-update', 'about']) {
    assert.ok(ids.includes(id), `missing command ${id}`)
  }
  assert.strictEqual(ids.filter((id) => id.startsWith('ui-scale:')).length, scales.length)
})

test('every command has a non-empty string id and title', () => {
  const { actions } = fakeActions()
  for (const c of buildCommandList({ actions, scales })) {
    assert.strictEqual(typeof c.id, 'string')
    assert.ok(c.id.length > 0)
    assert.strictEqual(typeof c.title, 'string')
    assert.ok(c.title.length > 0)
  }
})

// ── dispatchCommand ──

test('each fixed id dispatches to exactly its action', () => {
  const map = {
    'toggle-sidebar': 'toggleSidebar',
    'toggle-panel': 'togglePanel',
    'toggle-statusbar': 'toggleStatusBar',
    'toggle-logbar': 'toggleLogbar',
    'open-settings': 'openSettings',
    'open-diagnostics': 'openDiagnostics',
    'restart-backend': 'restartBackend',
    'open-logs': 'openLogs',
    'choose-editor': 'chooseEditor',
    'reveal-prefs': 'revealPrefs',
    'check-update': 'onCheckUpdate',
    'about': 'onShowAbout',
  }
  for (const [id, expected] of Object.entries(map)) {
    const { calls, actions } = fakeActions()
    assert.strictEqual(dispatchCommand({ actions, scales }, id), true, `dispatch ${id}`)
    assert.deepStrictEqual(calls, [expected], `${id} must call ${expected}`)
  }
  // Layout presets: one id each, dispatching with the preset name.
  const layoutMap = {
    'layout-focus': 'focus',
    'layout-classic': 'classic',
    'layout-minimal': 'minimal',
  }
  for (const [id, preset] of Object.entries(layoutMap)) {
    const { calls, actions } = fakeActions()
    assert.strictEqual(dispatchCommand({ actions, scales }, id), true, `dispatch ${id}`)
    assert.deepStrictEqual(calls, [`setLayout:${preset}`], `${id} must apply preset ${preset}`)
  }
})

test('scale ids dispatch to setUiScale with the matching step', () => {
  const { calls, actions } = fakeActions()
  assert.strictEqual(dispatchCommand({ actions, scales }, 'ui-scale:1.3'), true)
  assert.deepStrictEqual(calls, ['setUiScale:1.3'])
})

test('an unknown scale step is rejected, not coerced', () => {
  const { calls, actions } = fakeActions()
  assert.strictEqual(dispatchCommand({ actions, scales }, 'ui-scale:9.9'), false)
  assert.deepStrictEqual(calls, [])
})

test('unknown / malformed ids return false and call nothing', () => {
  for (const bad of ['nope', '', null, undefined, 42, {}, 'ui-scale:', 'ui-scale:NaN']) {
    const { calls, actions } = fakeActions()
    assert.strictEqual(dispatchCommand({ actions, scales }, bad), false, `id ${JSON.stringify(bad)}`)
    assert.deepStrictEqual(calls, [])
  }
})

test('dispatching twice works (the palette stays usable)', () => {
  const { calls, actions } = fakeActions()
  const src = { actions, scales }
  dispatchCommand(src, 'toggle-panel')
  dispatchCommand(src, 'open-settings')
  assert.deepStrictEqual(calls, ['togglePanel', 'openSettings'])
})

console.log(`\ncommand-registry: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
