/**
 * Regression test: hasMissingClientArtifacts() detects client-face packages
 * that lack lib/index.js output.
 *
 * In deepseek-harness >= rc.2, 43+ packages declare "dsh": { "client": ... }
 * in their package.json. The build pipeline (scripts/build.ts) runs two passes:
 *   - host: tsc + tsdown --env.DSH_BUILD_FACE host
 *   - client: tsc + tsdown --env.DSH_BUILD_FACE client
 *
 * If only the host pass completed, needsBuild() would return false (all 5
 * CRITICAL_EXPORTS host packages have lib/index.js) and the app would skip
 * straight to spawning dsh web — which then crashes with
 * ERR_MODULE_NOT_FOUND for any client UI package cordis tries to import.
 *
 * This test verifies that hasMissingClientArtifacts() catches the gap.
 *
 * NOTE: hasMissingClientArtifacts() only scans packages/, apps/,
 * and vendor/ subdirectories (with their nested package dirs).
 * All test cases must place packages under these group directories.
 */

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { RuntimeSource } = require('../lib-new/runtime-source')

// ---- helpers -----------------------------------------------------------

let tmpRoot
let rs

function pkgJson(dshClient) {
  return JSON.stringify({
    name: '@deepseek-ai/test-client-pkg',
    version: '0.0.1',
    dsh: dshClient ? { client: { platform: 'web' } } : undefined,
  })
}

/**
 * Create a package directory at the given absolute path with optional config.
 */
function makePkg(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true })
  if (opts.manifest !== false) {
    fs.writeFileSync(path.join(dir, 'package.json'), pkgJson(opts.client))
  }
  if (opts.lib) {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export {}')
  }
  if (!opts.noSrc) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {}')
  }
  return dir
}

// ---- tests -------------------------------------------------------------

; (async () => {
  tmpRoot = fs.mkdtempSync(
    path.join(
      process.env.TMP || process.env.TEMP || process.env.USERPROFILE || '.',
      'dsh-test-client-artifacts-'
    )
  )
  console.log('tmp:', tmpRoot)

  let passed = 0
  let failed = 0

  function ok(desc, fn) {
    try {
      fn()
      passed++
      console.log(`  OK  ${desc}`)
    } catch (e) {
      failed++
      console.log(`  FAIL ${desc}: ${e.message}`)
    }
  }

  // --- Workspace with no client-face packages → false ---
  {
    const base = path.join(tmpRoot, 'no-client')
    makePkg(path.join(base, 'packages', 'host', 'settings'), { client: false, lib: true })
    rs = new RuntimeSource(base)
    ok('no client-face packages -> false', () => {
      assert.equal(rs.hasMissingClientArtifacts(), false)
    })
  }

  // --- Client-face package WITH lib -> false ---
  {
    const base = path.join(tmpRoot, 'client-with-lib')
    makePkg(path.join(base, 'packages', 'client', 'ui-plan'), { client: true, lib: true })
    rs = new RuntimeSource(base)
    ok('client-face with lib -> false', () => {
      assert.equal(rs.hasMissingClientArtifacts(), false)
    })
  }

  // --- Client-face package WITHOUT lib -> true ---
  {
    const base = path.join(tmpRoot, 'client-no-lib')
    makePkg(path.join(base, 'packages', 'client', 'ui-trajectory'), { client: true })
    rs = new RuntimeSource(base)
    ok('client-face without lib -> true', () => {
      assert.equal(rs.hasMissingClientArtifacts(), true)
    })
  }

  // --- Mixed: some with lib, some without -> true ---
  {
    const base = path.join(tmpRoot, 'mixed')
    makePkg(path.join(base, 'packages', 'client', 'pkg-a'), { client: true, lib: true })
    makePkg(path.join(base, 'packages', 'client', 'pkg-b'), { client: true }) // no lib!
    rs = new RuntimeSource(base)
    ok('mixed: one missing -> true', () => {
      assert.equal(rs.hasMissingClientArtifacts(), true)
    })
  }

  // --- Two-level layout: packages/<group>/<pkg>/ ---
  {
    const base = path.join(tmpRoot, 'two-level')
    const pkgDir = path.join(base, 'packages', 'client', 'ui-trajectory')
    makePkg(pkgDir, { client: true }) // no lib

    rs = new RuntimeSource(base)
    ok('two-level layout, no lib -> true', () => {
      assert.equal(rs.hasMissingClientArtifacts(), true)
    })

    // Now add lib/
    fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'lib', 'index.js'), 'export {}')

    rs = new RuntimeSource(base)
    ok('two-level layout, with lib -> false', () => {
      assert.equal(rs.hasMissingClientArtifacts(), false)
    })
  }

  // --- Vendor-level layout: vendor/<pkg>/ ---
  {
    const base = path.join(tmpRoot, 'vendor-layout')
    const pkgDir = path.join(base, 'vendor', 'cordis-plugin-loader')
    makePkg(pkgDir, { client: true }) // no lib/

    rs = new RuntimeSource(base)
    ok('vendor layout, no lib -> true', () => {
      assert.equal(rs.hasMissingClientArtifacts(), true)
    })
  }

  // --- Package without manifest in candidate dir -> skipped ---
  {
    const base = path.join(tmpRoot, 'no-manifest')
    const pkgDir = path.join(base, 'packages', 'client', 'empty')
    fs.mkdirSync(pkgDir, { recursive: true })
    // No package.json written

    rs = new RuntimeSource(base)
    ok('no package.json -> skipped (false)', () => {
      assert.equal(rs.hasMissingClientArtifacts(), false)
    })
  }

  // --- Empty workspace -> false ---
  {
    const empty = path.join(tmpRoot, 'empty-ws')
    for (const g of ['packages', 'apps', 'vendor']) {
      fs.mkdirSync(path.join(empty, g), { recursive: true })
    }
    rs = new RuntimeSource(empty)
    ok('empty workspace -> false', () => {
      assert.equal(rs.hasMissingClientArtifacts(), false)
    })
  }

  // --- needsBuild() integrates client check ---
  {
    const base = path.join(tmpRoot, 'needsbuild-integration')
    const pkgDir = path.join(base, 'packages', 'client', 'ui-pkg')
    makePkg(pkgDir, { client: true }) // no lib!

    // Simulate frontend being built
    const distDir = path.join(base, 'apps', 'web', 'dist')
    fs.mkdirSync(distDir, { recursive: true })
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html></html>')

    rs = new RuntimeSource(base)
    ok('needsBuild returns true when client artifacts missing', () => {
      assert.equal(rs.needsBuild(), true)
    })

    // Add client lib
    fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'lib', 'index.js'), 'export {}')

    rs = new RuntimeSource(base)
    ok('needsBuild returns false when all artifacts present', () => {
      assert.equal(rs.needsBuild(), false)
    })
  }

  // Cleanup
  fs.rmSync(tmpRoot, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
})()
