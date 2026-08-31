/**
 * Regression tests for the workspace-husk cleanup on the build path.
 *
 * The knowledge encoded here is expensive to rediscover, and the failure mode
 * it guards against reports the wrong package name:
 *
 *   [@deepseek-ai/dsh-root] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]
 *
 * That message is NOT about the root package. tsdown falls back to the root
 * package's name when a workspace directory has no package.json to read one
 * from, so a leftover directory from a package this revision deleted gets
 * blamed on the monorepo anchor. Following the message leads to the root
 * package, which is not broken.
 *
 * How the husk gets there: `git reset --hard` removes tracked files but leaves
 * the directory when it still holds untracked content — and pnpm puts a
 * node_modules/ inside every workspace package. tsdown's workspace glob matches
 * on path, so the husk is treated as a package, produces no lib/types/*.js to
 * bundle, and aborts the entire build (including the 220+ healthy packages).
 *
 * Run with: npm test
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const SHELL_ROOT = path.join(__dirname, '..')
const ROOT = path.join(os.tmpdir(), 'dsh-orphan-dirs').replace(/\\/g, '/')

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

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Fresh workspace under ROOT, optionally initialised as a git repository. */
function makeWorkspace(name, { asGitRepo = false } = {}) {
  const dir = path.join(ROOT, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  if (asGitRepo) {
    git(['init', '-q'], dir)
    git(['config', 'user.email', 't@example.com'], dir)
    git(['config', 'user.name', 'test'], dir)
  }
  return { dir, src: new RuntimeSource(dir) }
}

/**
 * A real package: manifest + source, tracked by git.
 */
function makeRealPackage(dir, rel, { track = true } = {}) {
  const pkg = path.join(dir, rel)
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"@deepseek-ai/x"}\n', 'utf-8')
  fs.writeFileSync(path.join(pkg, 'src', 'index.ts'), 'export const x = 1\n', 'utf-8')
  fs.mkdirSync(path.join(pkg, 'node_modules', 'dep'), { recursive: true })
  if (track) git(['add', '--', rel.replace(/\\/g, '/')], dir)
  return pkg
}

/**
 * A husk: what a deleted package leaves behind. No manifest, no source — only
 * the node_modules pnpm created, which git never tracked.
 */
function makeHusk(dir, rel) {
  const pkg = path.join(dir, rel)
  fs.mkdirSync(path.join(pkg, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'node_modules', 'dep', 'package.json'), '{}\n', 'utf-8')
  return pkg
}

;(async () => {
  console.log('=== A. Deleted package husks are removed (git workspace) ===')
  const a = makeWorkspace('a', { asGitRepo: true })
  makeRealPackage(a.dir, 'packages/util/timeout')
  const huskA = makeHusk(a.dir, 'packages/util/values')
  const prunedA = a.src.pruneOrphanWorkspaceDirs()
  check('one husk reported', prunedA, 1)
  check('the husk is gone', fs.existsSync(huskA), false)
  check(
    'the real package survives',
    fs.existsSync(path.join(a.dir, 'packages/util/timeout/package.json')),
    true
  )
  check(
    'the real package source survives',
    fs.existsSync(path.join(a.dir, 'packages/util/timeout/src/index.ts')),
    true
  )

  console.log('\n=== B. Husks in vendor/ and apps/ are covered too ===')
  const b = makeWorkspace('b', { asGitRepo: true })
  const huskVendor = makeHusk(b.dir, 'vendor/dropped')
  const huskApp = makeHusk(b.dir, 'apps/dropped')
  const prunedB = b.src.pruneOrphanWorkspaceDirs()
  check('both husks reported', prunedB, 2)
  check('vendor husk gone', fs.existsSync(huskVendor), false)
  check('apps husk gone', fs.existsSync(huskApp), false)

  console.log('\n=== C. Without git, a node_modules-only dir is still cleaned ===')
  // ZIP-copied workspaces have no git history, so the content whitelist has to
  // carry the decision on its own.
  const c = makeWorkspace('c', { asGitRepo: false })
  const huskC = makeHusk(c.dir, 'packages/util/deque')
  const prunedC = c.src.pruneOrphanWorkspaceDirs()
  check('husk reported without git', prunedC, 1)
  check('husk gone without git', fs.existsSync(huskC), false)

  console.log('\n=== D. Source code is never collateral damage ===')
  // The safety net that matters most: an uncommitted package must survive even
  // though git tracks nothing there. Deleting is irreversible, so this errs
  // toward keeping the directory.
  const d = makeWorkspace('d', { asGitRepo: true })
  const uncommitted = path.join(d.dir, 'packages/util/brand-new')
  fs.mkdirSync(path.join(uncommitted, 'src'), { recursive: true })
  fs.writeFileSync(path.join(uncommitted, 'src', 'index.ts'), 'export const n = 1\n', 'utf-8')
  const prunedD = d.src.pruneOrphanWorkspaceDirs()
  check('nothing removed', prunedD, 0)
  check('uncommitted source survives', fs.existsSync(path.join(uncommitted, 'src/index.ts')), true)

  console.log('\n=== E. A directory git still tracks is kept, even without a manifest ===')
  const e = makeWorkspace('e', { asGitRepo: true })
  const tracked = path.join(e.dir, 'packages/util/odd')
  fs.mkdirSync(tracked, { recursive: true })
  fs.writeFileSync(path.join(tracked, 'README.md'), '# odd\n', 'utf-8')
  git(['add', '--', 'packages/util/odd'], e.dir)
  const prunedE = e.src.pruneOrphanWorkspaceDirs()
  check('nothing removed', prunedE, 0)
  check('tracked content survives', fs.existsSync(path.join(tracked, 'README.md')), true)

  console.log('\n=== F. A clean workspace is a no-op ===')
  const f = makeWorkspace('f', { asGitRepo: true })
  makeRealPackage(f.dir, 'packages/settings/settings')
  makeRealPackage(f.dir, 'vendor/cordis')
  let threw = false
  try {
    f.src.pruneOrphanWorkspaceDirs()
  } catch {
    threw = true
  }
  check('no error on a clean workspace', threw, false)
  check('zero removed', f.src.pruneOrphanWorkspaceDirs(), 0)
  check(
    'packages intact',
    fs.existsSync(path.join(f.dir, 'packages/settings/settings/package.json')),
    true
  )
  check('vendor intact', fs.existsSync(path.join(f.dir, 'vendor/cordis/package.json')), true)

  console.log('\n=== G. Mixed: husks removed, everything else untouched ===')
  const g = makeWorkspace('g', { asGitRepo: true })
  makeRealPackage(g.dir, 'packages/util/timeout')
  makeRealPackage(g.dir, 'packages/util/home-paths')
  const husks = [
    makeHusk(g.dir, 'packages/util/values'),
    makeHusk(g.dir, 'packages/util/crypto'),
    makeHusk(g.dir, 'packages/util/time'),
  ]
  const prunedG = g.src.pruneOrphanWorkspaceDirs()
  check('all three husks reported', prunedG, 3)
  check(
    'every husk is gone',
    husks.map((h) => fs.existsSync(h)),
    [false, false, false]
  )
  check(
    'both real packages survive',
    [
      fs.existsSync(path.join(g.dir, 'packages/util/timeout/package.json')),
      fs.existsSync(path.join(g.dir, 'packages/util/home-paths/package.json')),
    ],
    [true, true]
  )

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})()
