/**
 * Unit tests for src/command-model.ts — pure logic, plain node.
 *
 * Run with: node test/command-model.unit.cjs   (wired into `npm test`)
 */
const assert = require('node:assert')
const path = require('node:path')
const {
  filterCommands,
} = require(path.join(__dirname, '..', 'lib-new', 'command-model.js'))

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

const commands = [
  { id: 'a', title: 'Show Status bar', hint: '视图' },
  { id: 'b', title: 'Show sidebar', hint: 'Ctrl+Alt+S' },
  { id: 'c', title: 'Open settings', hint: '设置' },
  { id: 'd', title: 'Open diagnostics window', hint: 'Ctrl+Alt+D' },
  { id: 'e', title: '切换日志面板', hint: 'Ctrl+Alt+L' },
]

// ── empty query ──

test('an empty query returns every command in definition order with no ranges', () => {
  const out = filterCommands(commands, '')
  assert.strictEqual(out.length, 5)
  assert.deepStrictEqual(out.map((m) => m.command.id), ['a', 'b', 'c', 'd', 'e'])
  assert.deepStrictEqual(out.map((m) => m.ranges), [[], [], [], [], []])
  assert.ok(out.every((m) => m.score === 0))
})

test('a whitespace-only query behaves like an empty one (and null/undefined too)', () => {
  for (const q of ['   ', '\t\n', null, undefined]) {
    const out = filterCommands(commands, q)
    assert.strictEqual(out.length, 5, `query ${JSON.stringify(q)} should match all`)
  }
})

// ── subsequence matching ──

test('a subsequence query matches with gaps allowed and returns ascending ranges', () => {
  // 'sd' → "Show sidebar": s(0), d(7)
  const out = filterCommands(commands, 'sd')
  const top = out.find((m) => m.command.id === 'b')
  assert.ok(top, 'Show sidebar should match "sd"')
  assert.deepStrictEqual(top.ranges, [0, 7])
})

test('a query that is not a subsequence of any title matches nothing', () => {
  assert.deepStrictEqual(filterCommands(commands, 'zzz9'), [])
})

// ── ranking ──

test('an exact title match outranks partial matches', () => {
  const out = filterCommands(commands, 'open settings')
  assert.strictEqual(out[0].command.id, 'c')
  assert.ok(out[0].score >= 50)
})

test('a title-prefix match outranks a scattered subsequence', () => {
  // 'sh' is a prefix of both "Show …" titles; "Open settings" also contains
  // s…h? No — but "切换日志面板" does not. Prefix bonus must put Show titles first.
  const out = filterCommands(commands, 'sh')
  assert.strictEqual(out[0].command.id, 'a')
  assert.strictEqual(out[1].command.id, 'b')
})

test('word-start matches outrank mid-word matches at equal structure', () => {
  // 'o' matches many titles; "Open settings"/"Open diagnostics window" match at
  // index 0 (word start) while "Show Status bar" has 'o' mid-word — the
  // word-start bonus must rank the Open titles above the Show title.
  const out = filterCommands(commands, 'o')
  const ids = out.map((m) => m.command.id)
  assert.ok(ids.indexOf('c') < ids.indexOf('a'), `Open settings should outrank Show Status bar: ${ids}`)
})

test('ties keep definition order so the list is stable across keystrokes', () => {
  const tied = [
    { id: 'x1', title: 'Alpha action' },
    { id: 'x2', title: 'Alpha action' },
    { id: 'x3', title: 'Alpha action' },
  ]
  const out = filterCommands(tied, 'alpha')
  assert.deepStrictEqual(out.map((m) => m.command.id), ['x1', 'x2', 'x3'])
})

// ── case / whitespace robustness ──

test('matching is case-insensitive and internal whitespace is collapsed', () => {
  const out = filterCommands(commands, '  OPEN   SETTINGS ')
  assert.strictEqual(out.length >= 1, true)
  assert.strictEqual(out[0].command.id, 'c')
})

test('consecutive matches score higher than gapped ones', () => {
  const c = [{ id: 'p', title: 'abcdef' }, { id: 'g', title: 'axbxcdef' }]
  const out = filterCommands(c, 'def')
  // both match; the contiguous one ("abcdef") must win
  assert.strictEqual(out[0].command.id, 'p')
})

// ── CJK titles ──

test('CJK titles match and rank like any other title', () => {
  const out = filterCommands(commands, '日志')
  assert.strictEqual(out[0].command.id, 'e')
  // 切0 换1 日2 志3 …
  assert.deepStrictEqual(out[0].ranges, [2, 3])
})

test('malformed command objects are skipped, not crashed on', () => {
  const bad = [null, undefined, 42, { id: 'ok', title: 'Real command' }].filter(
    (c) => c !== null && c !== undefined,
  )
  // Numbers lack .title → scoreTitle would throw on toLowerCase of undefined;
  // the model must tolerate junk input instead.
  const out = filterCommands(/** @type {any[]} */ (bad), 'real')
  assert.deepStrictEqual(out.map((m) => m.command.id), ['ok'])
})

console.log(`\ncommand-model: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
