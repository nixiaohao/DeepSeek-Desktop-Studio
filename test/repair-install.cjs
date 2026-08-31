/**
 * Regression tests for the repair helpers on the dependency-install path.
 *
 * The knowledge encoded here is not obvious and is expensive to rediscover:
 * a killed `pnpm install` is STICKY. pnpm writes a completion marker next to
 * node_modules, and once that marker agrees with the lockfile it reports
 * "Already up to date" and skips the linking phase entirely — so the empty
 * directories the interrupted install left behind are never repaired, and the
 * build fails on "cannot find module" for a dependency package.json plainly
 * lists.
 *
 * Neither `--force` nor deleting `node_modules/.pnpm/lock.yaml` helps; only
 * removing the workspace state file does. If pnpm renames or adds a marker,
 * these tests are where that gets noticed.
 *
 * Run with: npm test
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const SHELL_ROOT = path.join(__dirname, '..')
const ROOT = path.join(os.tmpdir(), 'dsh-repair-install').replace(/\\/g, '/')

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

/** Build a workspace with node_modules holding exactly the given marker files. */
function makeWorkspace(name, markers) {
  const dir = path.join(ROOT, name)
  fs.rmSync(dir, { recursive: true, force: true })
  const nm = path.join(dir, 'node_modules')
  fs.mkdirSync(nm, { recursive: true })
  for (const m of markers) fs.writeFileSync(path.join(nm, m), '{}\n', 'utf-8')
  return { dir, src: new RuntimeSource(dir) }
}

;(async () => {
  console.log('=== A. pnpm 11 workspace state marker is removed ===')
  const a = makeWorkspace('a', ['.pnpm-workspace-state-v1.json'])
  a.src.forceDependencyRelink()
  check(
    'the pnpm 11 marker is gone',
    fs.existsSync(path.join(a.dir, 'node_modules', '.pnpm-workspace-state-v1.json')),
    false
  )

  console.log('\n=== B. Legacy .modules.yaml is removed ===')
  const b = makeWorkspace('b', ['.modules.yaml'])
  b.src.forceDependencyRelink()
  check(
    'the legacy pnpm marker is gone',
    fs.existsSync(path.join(b.dir, 'node_modules', '.modules.yaml')),
    false
  )

  console.log('\n=== C. Both markers removed in one pass ===')
  const c = makeWorkspace('c', ['.pnpm-workspace-state-v1.json', '.modules.yaml'])
  c.src.forceDependencyRelink()
  const left = fs
    .readdirSync(path.join(c.dir, 'node_modules'))
    .filter((n) => n.startsWith('.'))
  check('no marker survives', left, [])

  console.log('\n=== D. Nothing to remove is not an error ===')
  const d = makeWorkspace('d', [])
  let threw = false
  try {
    d.src.forceDependencyRelink()
  } catch {
    threw = true
  }
  check('a workspace without markers is left alone', threw, false)

  console.log('\n=== E. Only pnpm markers are touched ===')
  // A relink must never destroy the store or a lockfile copy — that would turn
  // a cheap relink into a full re-download.
  const e = makeWorkspace('e', ['.pnpm-workspace-state-v1.json'])
  fs.mkdirSync(path.join(e.dir, 'node_modules', '.pnpm'), { recursive: true })
  fs.writeFileSync(path.join(e.dir, 'node_modules', '.pnpm', 'lock.yaml'), 'lockfileVersion\n', 'utf-8')
  fs.writeFileSync(path.join(e.dir, 'pnpm-lock.yaml'), 'lockfileVersion\n', 'utf-8')
  e.src.forceDependencyRelink()
  check(
    'the virtual store survives',
    fs.existsSync(path.join(e.dir, 'node_modules', '.pnpm', 'lock.yaml')),
    true
  )
  check('the project lockfile survives', fs.existsSync(path.join(e.dir, 'pnpm-lock.yaml')), true)

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})()
