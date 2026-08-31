/**
 * Regression tests for the build gate (RuntimeSource.needsBuild).
 *
 * The gate decides whether a launch rebuilds the workspace. Getting it wrong
 * is expensive in both directions, and the two directions are asymmetric:
 *
 *   - Too eager  → a full backend+frontend rebuild (minutes) on every launch.
 *   - Too lazy   → the app skips the rebuild, spawns `dsh web` against missing
 *                  backend output, dies with ERR_MODULE_NOT_FOUND, and stays
 *                  unlaunchable because nothing in the startup path ever
 *                  rebuilds again.
 *
 * The second case is what motivated checking backend artifacts at all: the
 * frontend bundle (`apps/web/dist/index.html`) and the backend `lib/` trees are
 * produced by one script but cached separately, so the frontend can survive
 * while every backend artifact is gone.
 *
 * Run with: npm test
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const SHELL_ROOT = path.join(__dirname, '..')
const ROOT = path.join(os.tmpdir(), 'dsh-needs-build').replace(/\\/g, '/')

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

const entries = RuntimeSource.CRITICAL_EXPORTS

/**
 * Build a fixture workspace.
 *
 * @param dir        fixture root
 * @param opts.frontend  write apps/web/dist/index.html
 * @param opts.backend   write <pkg>/lib/index.js for every critical package
 * @param opts.manifest  write <pkg>/package.json (i.e. the package exists)
 * @param opts.except    skip these entry indexes when writing backend output
 */
function makeWorkspace(dir, opts) {
  fs.rmSync(dir, { recursive: true, force: true })
  if (opts.frontend) {
    const abs = path.join(dir, 'apps', 'web', 'dist', 'index.html')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, '<html></html>\n', 'utf-8')
  }
  entries.forEach((e, i) => {
    // <pkg>/lib/index.js → <pkg>
    const pkgDir = path.join(dir, path.dirname(path.dirname(e.rel)))
    if (opts.manifest) {
      fs.mkdirSync(pkgDir, { recursive: true })
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: e.pkg, version: '0.0.0' }, null, 2),
        'utf-8'
      )
    }
    if (opts.backend && !(opts.except || []).includes(i)) {
      const abs = path.join(dir, e.rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, e.exports.map((n) => `export function ${n}() {}`).join('\n') + '\n', 'utf-8')
    }
  })
  return new RuntimeSource(dir)
}

;(async () => {
  console.log('=== A. Frontend missing → rebuild, regardless of backend ===')
  const noFrontend = makeWorkspace(path.join(ROOT, 'a'), {
    frontend: false,
    backend: true,
    manifest: true,
  })
  check('rebuild when the client bundle is absent', noFrontend.needsBuild(), true)

  console.log('\n=== B. Fully built workspace → no rebuild ===')
  const complete = makeWorkspace(path.join(ROOT, 'b'), {
    frontend: true,
    backend: true,
    manifest: true,
  })
  check('both faces present → skip the build', complete.needsBuild(), false)

  console.log('\n=== C. The regression: frontend present, backend gone ===')
  // Exactly the state an interrupted build or a hand cleanup leaves behind.
  // The old gate looked only at the frontend bundle and reported "ready",
  // so the app launched straight into ERR_MODULE_NOT_FOUND.
  const backendGone = makeWorkspace(path.join(ROOT, 'c'), {
    frontend: true,
    backend: false,
    manifest: true,
  })
  check('rebuild when backend artifacts are missing', backendGone.needsBuild(), true)

  console.log('\n=== D. One missing package is enough to trigger it ===')
  const oneGone = makeWorkspace(path.join(ROOT, 'd'), {
    frontend: true,
    backend: true,
    manifest: true,
    except: [0],
  })
  check('a single absent lib/ triggers a rebuild', oneGone.needsBuild(), true)

  console.log('\n=== E. Packages this revision does not have → no rebuild loop ===')
  // Upstream deleted the package: there is neither a manifest nor output.
  // Counting it as missing would pin needsBuild() to true forever and force a
  // multi-minute rebuild on every launch.
  const noManifest = makeWorkspace(path.join(ROOT, 'e'), {
    frontend: true,
    backend: false,
    manifest: false,
  })
  check('removed packages do not force a rebuild', noManifest.needsBuild(), false)

  const partialManifest = makeWorkspace(path.join(ROOT, 'e2'), {
    frontend: true,
    backend: true,
    manifest: true,
  })
  // Remove one package entirely (manifest + output), keep the rest intact.
  const victim = path.join(ROOT, 'e2', path.dirname(path.dirname(entries[0].rel)))
  fs.rmSync(victim, { recursive: true, force: true })
  check('a removed package alongside healthy ones → no rebuild', partialManifest.needsBuild(), false)

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})()
