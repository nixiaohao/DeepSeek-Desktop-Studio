/**
 * End-to-end test for channel pinning, against a real throwaway git repo.
 *
 * Builds an "upstream" repository carrying the same tag shape as
 * deepseek-harness (annotated tags, so `ls-remote` emits both the tag object
 * and the `^{}` dereference line), clones it the way the app does, and drives
 * the real RuntimeSource class through resolve → fetch → checkout.
 *
 * The regression that matters most is section C2/G: a hash-length mismatch or
 * a tag-object/commit mix-up makes every launch look outdated, which would
 * trigger a full rebuild on every single start.
 *
 * HOME is redirected to a temp dir so the real ~/.dsh is never touched.
 * Skipped (exit 0) when git is unavailable.
 *
 * Run with: npm test
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFileSync, spawnSync } = require('node:child_process')

const SHELL_ROOT = path.join(__dirname, '..')

function hasGit() {
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf-8', windowsHide: true })
    return r.status === 0
  } catch {
    return false
  }
}

if (!hasGit()) {
  console.log('SKIP: git not available — skipping channel end-to-end test')
  process.exit(0)
}

// Everything lives under the OS temp dir; normalise separators for git.
const ROOT = path.join(os.tmpdir(), 'dsh-channel-e2e').replace(/\\/g, '/')
const UP = `${ROOT}/upstream`
const WS = `${ROOT}/workspace`
const FAKE_HOME = path.join(ROOT, 'home')
const LOGDIR = path.join(ROOT, 'logs')

fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(FAKE_HOME, { recursive: true })
fs.mkdirSync(LOGDIR, { recursive: true })

// Must happen BEFORE preferences.js loads: it computes ~/.dsh at module scope.
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME

// logging.js reaches for electron's app.getPath('userData').
const Module = require('module')
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => ROOT, getName: () => 'deepseek-studio' },
      shell: { openExternal: () => {}, openPath: () => {} },
      dialog: { showMessageBoxSync: () => 1 },
    }
  }
  return origLoad.call(this, request, ...rest)
}

const { RuntimeSource } = require(path.join(SHELL_ROOT, 'lib-new', 'runtime-source.js'))
const prefs = require(path.join(SHELL_ROOT, 'lib-new', 'preferences.js'))

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

function git(args, cwd) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', windowsHide: true }).trim()
}

// ── Build the fake upstream, oldest release first ──
fs.mkdirSync(UP, { recursive: true })
git(['init', '-q', '-b', 'master'], UP)
git(['config', 'user.email', 't@example.com'], UP)
git(['config', 'user.name', 't'], UP)
for (const v of [
  '0.1.0-rc.7',
  '0.1.0-rc.8',
  '0.1.1-rc.1',
  '0.1.1-rc.2',
  '0.1.2-alpha.1',
  '0.1.2-alpha.2',
]) {
  fs.writeFileSync(path.join(UP, 'version.txt'), `${v}\n`)
  git(['add', '-A'], UP)
  git(['commit', '-q', '-m', `release ${v}`], UP)
  // Annotated tags: these are what produce the `^{}` lines in ls-remote.
  git(['tag', '-a', `dsh-v${v}`, '-m', v], UP)
}
// A non-version tag must be ignored rather than break resolution.
git(['tag', '-a', 'not-a-version', '-m', 'junk'], UP)

fs.mkdirSync(WS, { recursive: true })
execFileSync('git', ['clone', '-q', '--branch', 'master', '--single-branch', UP, WS], {
  encoding: 'utf-8',
  windowsHide: true,
})

const src = new RuntimeSource(WS)

console.log('\n=== A. Default channel (no config, no env) ===')
check('channel() defaults to next', src.channel(), 'next')
check('next is not risky', src.channelIsRisky(), false)
const tNext = src.resolveChannelTarget({ force: true })
check('next resolves to the rc line', [tNext.selection.version, tNext.selection.tag], ['0.1.1-rc.2', 'dsh-v0.1.1-rc.2'])
check('resolved sha is a full hash', /^[0-9a-f]{40}$/.test(tNext.sha), true)

console.log('\n=== B. Workspace starts on the master tip (alpha) ===')
check('HEAD is not the rc.2 commit (i.e. tracking master would be wrong)', git(['rev-parse', 'HEAD'], WS) !== tNext.sha, true)

console.log('\n=== C. Fetch + check out the channel tag ===')
check('ensureTagFetched(next) succeeds', src.ensureTagFetched(tNext), true)
// Annotated tags: the ref points at a tag OBJECT, `^{commit}` at the commit.
// Resolving to the object sha is the bug that made every launch look outdated.
const tagObjSha = git(['rev-parse', `refs/tags/${tNext.selection.tag}`], WS)
const commitSha = git(['rev-parse', `refs/tags/${tNext.selection.tag}^{commit}`], WS)
check('(sanity) this tag is annotated, so object != commit', tagObjSha !== commitSha, true)
check('resolved sha is the COMMIT, not the tag object', tNext.sha, commitSha)
git(['reset', '--hard', tNext.sha], WS)
check('after reset, HEAD is the channel commit', git(['rev-parse', 'HEAD'], WS), tNext.sha)
check('version.txt now says the rc release', fs.readFileSync(path.join(WS, 'version.txt'), 'utf-8').trim(), '0.1.1-rc.2')
// currentCommit() is the 7-char short form; the resolved sha is the full 40.
check('currentCommit() agrees (short form of the resolved commit)', tNext.sha.startsWith(src.currentCommit()), true)

console.log('\n=== C2. No phantom updates (the regression this must never reintroduce) ===')
const tAgain = src.resolveChannelTarget({ force: true })
check('re-resolving yields HEAD (short vs full compare)', tAgain.sha.startsWith(src.currentCommit()), true)
check('a second ensureTagFetched is satisfied locally', src.ensureTagFetched(tAgain), true)
const tThird = src.resolveChannelTarget({ force: true })
check('and stays stable across repeated resolutions', tThird.sha, tAgain.sha)

console.log('\n=== D. Env var override (the escape hatch) ===')
process.env.DSH_CHANNEL = 'alpha'
check('channel() honours DSH_CHANNEL', src.channel(), 'alpha')
check('alpha is flagged risky', src.channelIsRisky(), true)
const tAlpha = src.resolveChannelTarget({ force: true, channel: 'alpha' })
check('alpha resolves to the newest tag', [tAlpha.selection.version, tAlpha.selection.tag], ['0.1.2-alpha.2', 'dsh-v0.1.2-alpha.2'])
process.env.DSH_CHANNEL = 'garbage-value'
check('invalid env value degrades to the preference/default', src.channel(), 'next')
delete process.env.DSH_CHANNEL

console.log('\n=== E. Risky channel writes a recovery guide; safe channel removes it ===')
src.setChannel('alpha')
check('preference persisted', prefs.loadPreferences().channel, 'alpha')
check('recovery guide created', prefs.hasRecoveryGuide(), true)
const guideText = fs.readFileSync(prefs.recoveryGuidePath(), 'utf-8')
check('guide names the channel', guideText.includes('alpha'), true)
check('guide documents the env-var escape', guideText.includes('DSH_CHANNEL'), true)
check('guide documents the prefs-file escape', guideText.includes('studio-prefs.json'), true)
check('guide explains the real failure mode', guideText.includes('settingsNamespace'), true)

src.setChannel('next')
check('switching back persists', prefs.loadPreferences().channel, 'next')
check('recovery guide removed on a safe channel', prefs.hasRecoveryGuide(), false)

console.log('\n=== F. Cannot-resolve is not a failure ===')
const emptySrc = new RuntimeSource(path.join(ROOT, 'does-not-exist'))
check('resolveChannelTarget returns null without a repo', emptySrc.resolveChannelTarget({ force: true }), null)
check('channel() still reports the configured channel', emptySrc.channel(), 'next')

;(async () => {
  console.log('\n=== G. checkUpdate: the "does every launch rebuild?" question ===')
  const noUpdate = await src.checkUpdate(() => {})
  check('already on the channel commit → no update', noUpdate, false)

  process.env.DSH_CHANNEL = 'alpha'
  const wantAlpha = await src.checkUpdate(() => {})
  check('switching to alpha → update reported', wantAlpha, true)
  delete process.env.DSH_CHANNEL

  // HEAD is still the rc.2 commit from section C, so next needs no change.
  const backToNext = await src.checkUpdate(() => {})
  check('back on next → no update (already on the rc.2 commit)', backToNext, false)

  // The auto-downgrade scenario: HEAD is an alpha commit, channel says next.
  git(['reset', '--hard', tAlpha.sha], WS)
  check('(sanity) HEAD is now the alpha commit', git(['rev-parse', 'HEAD'], WS), tAlpha.sha)
  const fromAlpha = await src.checkUpdate(() => {})
  check('on alpha with channel=next → update reported (must move back)', fromAlpha, true)

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})()
