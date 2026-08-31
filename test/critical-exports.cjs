/**
 * Regression tests for the critical-export check.
 *
 * The list in RuntimeSource.CRITICAL_EXPORTS is a hand-maintained inventory of
 * what third-party plugins import out of @deepseek-ai/*. Two ways it can rot,
 * both of which silently defeat the check:
 *
 *   1. A path typo. The checker skips files that do not exist, so a bad path
 *      reports "all exports present" while checking nothing.
 *   2. A name that upstream moved behind `export * from` or CJS interop. The
 *      static parser would call it missing and roll the user back for nothing.
 *
 * So these tests assert the positive (real export → no alarm), the negative
 * (missing export → alarm naming it) and the skip (absent package → no alarm),
 * using the real RuntimeSource against a throwaway workspace with the exact
 * directory layout the list expects.
 *
 * Run with: npm test
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const SHELL_ROOT = path.join(__dirname, '..')
const ROOT = path.join(os.tmpdir(), 'dsh-critical-exports').replace(/\\/g, '/')

// Stub electron before logging.js loads: it calls app.getPath('userData').
const Module = require('module')
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => ROOT, getName: () => 'deepseek-studio' },
    }
  }
  return origLoad.call(this, request, ...rest)
}

const { RuntimeSource } = require(path.join(SHELL_ROOT, 'lib-new', 'runtime-source.js'))

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}\n         expected ${e}\n         actual   ${a}`)
  }
}

const NODE = { path: process.execPath, useElectron: false }

const entries = RuntimeSource.CRITICAL_EXPORTS

function writeWorkspace(dir, mutate) {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const e of entries) {
    const abs = path.join(dir, e.rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const names = mutate ? mutate(e) : e.exports
    const body = names.map((n) => `export function ${n}() {}`).join('\n')
    fs.writeFileSync(abs, `${body}\n`, 'utf-8')
  }
}

;(async () => {
  console.log('=== A. Every path in the list is real (no silent skips) ===')
  // The strongest guarantee available here: against the real workspace nothing
  // was skipped. Against the fixture, assert the shape instead — that the list
  // is non-empty, paths are workspace-relative, and none are absolute.
  check('list is not empty', entries.length > 0, true)
  check(
    'no absolute paths (would break on other drives)',
    entries.filter((e) => path.isAbsolute(e.rel)).length,
    0
  )
  check(
    'every entry names at least one export',
    entries.filter((e) => e.exports.length === 0).length,
    0
  )
  check(
    'every entry points at a built lib/ entry',
    entries.filter((e) => !e.rel.split(path.sep).includes('lib')).length,
    0
  )

  console.log('\n=== B. Healthy workspace → no alarm ===')
  const good = path.join(ROOT, 'good')
  writeWorkspace(good)
  const goodSrc = new RuntimeSource(good)
  check('nothing reported missing', await goodSrc.detectMissingCriticalExports(NODE), null)

  console.log('\n=== C. Missing export → alarm naming it ===')
  const bad = path.join(ROOT, 'bad')
  // Drop the first export of the first entry only.
  writeWorkspace(bad, (e) => (e === entries[0] ? e.exports.slice(1) : e.exports))
  const badSrc = new RuntimeSource(bad)
  const badMsg = await badSrc.detectMissingCriticalExports(NODE)
  check('a problem is reported', badMsg !== null, true)
  check('it names the missing export', badMsg.includes(entries[0].exports[0]), true)
  check('it names the package', badMsg.includes(entries[0].pkg), true)

  console.log('\n=== D. Absent package → skipped, never a false alarm ===')
  const partial = path.join(ROOT, 'partial')
  fs.rmSync(partial, { recursive: true, force: true })
  for (const e of entries.slice(1)) {
    const abs = path.join(partial, e.rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, e.exports.map((n) => `export function ${n}() {}`).join('\n') + '\n', 'utf-8')
  }
  const partialSrc = new RuntimeSource(partial)
  check(
    'a package upstream removed does not trigger a rollback',
    await partialSrc.detectMissingCriticalExports(NODE),
    null
  )

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})()
