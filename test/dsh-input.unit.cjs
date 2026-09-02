/**
 * dsh-input tests.
 *
 * The buildChatInsert side is pure formatting and gets pinned down here. The
 * buildInsertScript side is the script that runs inside dsh's renderer — we
 * cannot execute it without a real DOM, but we CAN prove two things that
 * matter just as much:
 *
 *   - the produced string parses as JavaScript (new vm.Script throws on a
 *     syntax error);
 *   - the payload is interpolated as a JSON-encoded string literal, so a
 *     backslash, a quote, a newline, or a Chinese character all survive the
 *     round-trip without breaking the script.
 *
 * The first check is what makes a malformed renderer-side change fail in
 * CI rather than as a "nothing happened" toast in the packaged app. The
 * second is what protects against the class of bug where a user adds a file
 * whose name contains a quote and the script silently fails to parse.
 */

const assert = require('node:assert')
const vm = require('node:vm')
const path = require('node:path')

const { buildChatInsert, buildInsertScript } = require(
  path.join(__dirname, '..', 'lib-new', 'dsh-input.js'),
)

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

/** Round-trip the payload through the script and pull it back out. */
function payloadOf(script) {
  // The IIFE ends with `(<payload>);` — slice that off and JSON.parse it
  // back to the original string. This is the closest we get to "does the
  // interpolation survive" without spinning up a renderer.
  const start = script.lastIndexOf('})(')
  assert.ok(start > 0, 'script must end with })(<payload>);')
  const tail = script.slice(start + 3)
  const end = tail.lastIndexOf(');')
  assert.ok(end > 0, 'script must end with );')
  const literal = tail.slice(0, end)
  return JSON.parse(literal)
}

// ── buildChatInsert ────────────────────────────────────────────────────

check('empty / non-string input yields ""', () => {
  assert.strictEqual(buildChatInsert(''), '')
  assert.strictEqual(buildChatInsert(null), '')
  assert.strictEqual(buildChatInsert(undefined), '')
  assert.strictEqual(buildChatInsert(123), '')
  assert.strictEqual(buildChatInsert({}), '')
})

check('forward slashes are turned into backslashes for display', () => {
  assert.strictEqual(
    buildChatInsert('D:/DevWorks/foo/bar.ts'),
    '@D:\\DevWorks\\foo\\bar.ts',
  )
})

check('mixed slashes are normalised to backslashes', () => {
  assert.strictEqual(
    buildChatInsert('D:\\DevWorks/foo\\bar.ts'),
    '@D:\\DevWorks\\foo\\bar.ts',
  )
})

check('leading @ is always prepended (even on an already-prefixed path)', () => {
  // We do not try to detect "already an @-ref" — the user can trim it from
  // the chat input themselves, and prepending a second @ would only confuse
  // dsh's parser.
  assert.strictEqual(
    buildChatInsert('@already-a-ref.ts'),
    '@@already-a-ref.ts',
  )
})

check('non-ASCII paths are returned verbatim (only slashes are touched)', () => {
  assert.strictEqual(
    buildChatInsert('D:/工作区/源代码/main.ts'),
    '@D:\\工作区\\源代码\\main.ts',
  )
})

// ── buildInsertScript ──────────────────────────────────────────────────

check('non-string input yields an empty string, not a malformed script', () => {
  assert.strictEqual(buildInsertScript(undefined), '')
  assert.strictEqual(buildInsertScript(null), '')
  assert.strictEqual(buildInsertScript(42), '')
})

check('the produced script parses as valid JavaScript', () => {
  // vm.Script throws on a syntax error. A broken interpolation (a stray
  // quote, an unescaped newline) is the failure mode this guard exists for.
  const script = buildInsertScript('hello')
  new vm.Script(script) // throws on bad syntax
  assert.ok(script.includes('hello'), 'payload must be embedded in the script')
})

check('payload round-trips: the IIFE call site sees the original text', () => {
  const cases = [
    'plain',
    'with spaces and 7-bit punctuation !@#$%^&*()',
    'D:\\DevWorks\\DeepSeek-Desktop-Studio\\shell\\src\\main.ts',
    'with "double" and \'single\' quotes',
    'with\nnewlines\nand\ttabs',
    'with backslash \\ and slash /',
    'with unicode 工作区 🚀 ñ',
    '', // empty string still valid
  ]
  for (const text of cases) {
    const script = buildInsertScript(text)
    new vm.Script(script) // must still parse
    assert.strictEqual(payloadOf(script), text, `round-trip failed for ${JSON.stringify(text)}`)
  }
})

check('a quote in the payload does not break out of the string literal', () => {
  // The defence: JSON.stringify produces \" for ", so the resulting literal
  // is still one syntactically valid string. If we ever switched to naive
  // concatenation this would be the first regression to catch.
  const text = `a"b'c`
  const script = buildInsertScript(text)
  new vm.Script(script)
  assert.ok(
    !script.includes(`'a"b'c'`),
    'the raw payload must not appear unescaped in the script',
  )
  assert.strictEqual(payloadOf(script), text)
})

check('a literal newline in the payload does not break the script', () => {
  const text = 'line1\nline2'
  const script = buildInsertScript(text)
  new vm.Script(script)
  // JSON.stringify turns \n into the two-character sequence \n, so the
  // produced script must NOT contain a raw newline inside the string.
  // We slice the call site to check the literal portion in isolation.
  const literal = payloadOf.bind(null)
  assert.strictEqual(literal(script), text)
})

check('the IIFE wraps the payload so it cannot be re-evaluated as code', () => {
  // `1+1` as a payload would be `eval`-able. JSON.stringify wraps it as
  // a string literal so the IIFE just sees the four characters "1+1".
  const script = buildInsertScript('1+1')
  new vm.Script(script)
  assert.strictEqual(payloadOf(script), '1+1')
})

check('the script includes a textarea branch and a contenteditable fallback', () => {
  const script = buildInsertScript('x')
  assert.ok(script.includes('querySelectorAll(\'textarea\')'), 'textarea branch present')
  assert.ok(script.includes('[contenteditable="true"]'), 'contenteditable fallback present')
})

check('the script returns the diagnostic fields the IPC handler reports back', () => {
  const script = buildInsertScript('x')
  assert.ok(script.includes('target: \'textarea\''), 'textarea target label')
  assert.ok(script.includes('target: \'contenteditable\''), 'contenteditable target label')
  assert.ok(script.includes('inserted: insert'), 'inserted payload exposed')
  assert.ok(script.includes('ok: false, error:'), 'failure result shape present')
})

console.log(`dsh-input: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
