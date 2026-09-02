/**
 * Unit tests for src/log-model.ts — pure logic, plain node.
 *
 * Run with: node test/log-model.unit.cjs   (wired into `npm test`)
 */
const assert = require('node:assert')
const path = require('node:path')
const {
  LOG_SOURCES,
  LOG_SOURCE_LABELS,
  parseShellLine,
  entryFromBackend,
  entryFromAgent,
  buildView,
} = require(path.join(__dirname, '..', 'lib-new', 'log-model.js'))

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

const ISO = '2026-09-02T04:00:00.000Z'
const TS = Date.parse(ISO)
const shellLine = (name, msg) => `[${name}] [${ISO}] ${msg}`

// ── parseShellLine ──

test('a valid shell line parses with source, ts and text', () => {
  const e = parseShellLine(shellLine('launcher', 'update check done'))
  assert.deepStrictEqual(e, { source: 'launcher', ts: TS, stream: 'out', text: 'update check done' })
})

test('shell-line sources are recognised (agent is never parsed from text)', () => {
  for (const s of ['launcher', 'wizard', 'backend', 'fatal']) {
    assert.strictEqual(parseShellLine(shellLine(s, 'x'))?.source, s)
  }
})

test('an unknown source is dropped, not guessed', () => {
  // `[evil]` is exactly the shape of a message that starts with a bracketed
  // word — it must not become an entry with a made-up source.
  assert.strictEqual(parseShellLine(shellLine('evil', 'x')), null)
})

test('a message containing brackets still parses', () => {
  const e = parseShellLine(shellLine('fatal', 'cannot read [a] then [b]'))
  assert.strictEqual(e.text, 'cannot read [a] then [b]')
})

test('an unparseable timestamp is dropped', () => {
  assert.strictEqual(parseShellLine('[launcher] [not-a-date] msg'), null)
})

test('a line without the timestamp bracket is dropped', () => {
  assert.strictEqual(parseShellLine('[launcher] no ts here'), null)
  assert.strictEqual(parseShellLine('totally free text'), null)
})

test('non-string input is dropped without throwing', () => {
  assert.strictEqual(parseShellLine(null), null)
  assert.strictEqual(parseShellLine(42), null)
  assert.strictEqual(parseShellLine({ ts: 1 }), null)
  assert.strictEqual(parseShellLine(undefined), null)
})

// ── entryFromBackend ──

test('backend records pass through with source backend', () => {
  const e = entryFromBackend({ ts: 1234, stream: 'err', text: '[ERR] boom' })
  assert.deepStrictEqual(e, { source: 'backend', ts: 1234, stream: 'err', text: '[ERR] boom' })
})

test('backend stdout keeps stream out', () => {
  assert.strictEqual(entryFromBackend({ ts: 1, stream: 'out', text: 'ok' }).stream, 'out')
})

// ── entryFromAgent ──

test('agent records pass through with source agent and stream out', () => {
  const e = entryFromAgent({ ts: 99, text: '[主] 调用 Write' })
  assert.deepStrictEqual(e, { source: 'agent', ts: 99, stream: 'out', text: '[主] 调用 Write' })
})

// ── labels ──

test('every source has a non-empty Chinese label', () => {
  for (const s of LOG_SOURCES) {
    assert.strictEqual(typeof LOG_SOURCE_LABELS[s], 'string')
    assert.ok(LOG_SOURCE_LABELS[s].length > 0, `label for ${s} is empty`)
  }
})

// ── buildView ──

test('empty inputs produce an empty view', () => {
  assert.deepStrictEqual(buildView([], [], [], null), [])
})

test('both feeds merge and sort oldest first', () => {
  const later = shellLine('launcher', 'later')
  const earlierIso = '2026-09-02T03:00:00.000Z'
  const earlier = `[launcher] [${earlierIso}] earlier`
  const backendMid = [{ ts: Date.parse('2026-09-02T03:30:00.000Z'), stream: 'out', text: 'mid' }]
  const view = buildView([later, earlier], backendMid, [], null)
  assert.deepStrictEqual(
    view.map((e) => e.text),
    ['earlier', 'mid', 'later'],
  )
})

test('equal timestamps keep arrival order (stable sort)', () => {
  const view = buildView(
    [shellLine('launcher', 'first'), shellLine('wizard', 'second')],
    [{ ts: TS, stream: 'out', text: 'third' }],
    [],
    null,
  )
  assert.deepStrictEqual(
    view.map((e) => e.text),
    ['first', 'second', 'third'],
  )
})

test('active filter keeps only selected sources', () => {
  const view = buildView(
    [shellLine('launcher', 'a'), shellLine('fatal', 'b')],
    [{ ts: TS, stream: 'out', text: 'c' }],
    [{ ts: TS, text: 'ag' }],
    ['fatal'],
  )
  assert.deepStrictEqual(
    view.map((e) => e.text),
    ['b'],
  )
})

test('active=null shows everything', () => {
  const view = buildView(
    [shellLine('launcher', 'a'), shellLine('fatal', 'b')],
    [{ ts: TS, stream: 'out', text: 'c' }],
    [{ ts: TS, text: 'ag' }],
    null,
  )
  assert.strictEqual(view.length, 4)
})

test('cap keeps the newest entries AFTER filtering', () => {
  // 3 launcher + 3 fatal lines; limit 4 while showing only fatal → the 3
  // fatal lines survive even though a pre-filter cap of 4 would have cut one.
  const shell = [
    `[launcher] [2026-09-02T01:00:00.000Z] l1`,
    `[fatal] [2026-09-02T01:01:00.000Z] f1`,
    `[launcher] [2026-09-02T02:00:00.000Z] l2`,
    `[fatal] [2026-09-02T02:01:00.000Z] f2`,
    `[launcher] [2026-09-02T03:00:00.000Z] l3`,
    `[fatal] [2026-09-02T03:01:00.000Z] f3`,
  ]
  const view = buildView(shell, [], [], ['fatal'], 4)
  assert.deepStrictEqual(
    view.map((e) => e.text),
    ['f1', 'f2', 'f3'],
  )
})

test('cap trims the OLDEST entries when everything matches', () => {
  const shell = [1, 2, 3, 4, 5].map((n) => shellLine('launcher', `m${n}`))
  const view = buildView(shell, [], [], null, 2)
  assert.deepStrictEqual(
    view.map((e) => e.text),
    ['m4', 'm5'],
  )
})

test('malformed shell lines are skipped during the merge', () => {
  const view = buildView(['junk', shellLine('wizard', 'good'), null, 5], [], [], null)
  assert.deepStrictEqual(
    view.map((e) => e.text),
    ['good'],
  )
})

test('agent feed merges into the timeline and follows the filter', () => {
  const agent = [
    { ts: Date.parse('2026-09-02T05:00:00.000Z'), text: '[主] 调用 Bash' },
    { ts: Date.parse('2026-09-02T05:01:00.000Z'), text: '[子] 调用 Read' },
  ]
  const all = buildView([], [], agent, null)
  assert.deepStrictEqual(all.map((e) => e.text), ['[主] 调用 Bash', '[子] 调用 Read'])
  assert.ok(all.every((e) => e.source === 'agent'))
  const onlyLauncher = buildView([shellLine('launcher', 'l')], [], agent, ['launcher'])
  assert.deepStrictEqual(onlyLauncher.map((e) => e.text), ['l'])
})

test('agent entries are capped together with the other feeds', () => {
  const agent = [1, 2, 3].map((n) => ({ ts: n, text: `a${n}` }))
  const view = buildView([], [], agent, ['agent'], 2)
  assert.deepStrictEqual(view.map((e) => e.text), ['a2', 'a3'])
})

console.log(`\nlog-model: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
