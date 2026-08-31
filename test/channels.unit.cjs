/**
 * Unit tests for the release-channel resolver (src/channels.ts → lib-new/channels.js).
 *
 * The first fixture is the real upstream tag list exactly as
 * `git ls-remote --tags` prints it — including the `^{}` dereference lines of
 * annotated tags — so the tests pin what each channel resolves to on today's
 * upstream, not just that the comparator happens to work.
 *
 * Run with: npm test
 */
const path = require('node:path')
const C = require(path.join(__dirname, '..', 'lib-new', 'channels.js'))

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

// ── Fixture 1: real upstream tags, raw ls-remote shape ──
const REAL_LS_REMOTE = [
  '99f6f02f\trefs/tags/dsh-v0.1.0-rc.7',
  '141eb6fe\trefs/tags/dsh-v0.1.0-rc.8',
  '528c682e\trefs/tags/dsh-v0.1.1-rc.1',
  'b150a551\trefs/tags/dsh-v0.1.1-rc.2',
  'b150a551\trefs/tags/dsh-v0.1.1-rc.2^{}',
  'cd5ef814\trefs/tags/dsh-v0.1.2-alpha.1',
  '0a53fb55\trefs/tags/dsh-v0.1.2-alpha.2',
  '0a53fb55\trefs/tags/dsh-v0.1.2-alpha.2^{}',
  'deadbeef\trefs/tags/not-a-version',
]
const realTags = REAL_LS_REMOTE.map((l) => l.split('\t')[1])

console.log('\n=== Fixture 1: real upstream tags (2026-08) ===')
const next = C.selectChannelTag('next', realTags)
const alpha = C.selectChannelTag('alpha', realTags)
const canary = C.selectChannelTag('canary', realTags)
const stable = C.selectChannelTag('stable', realTags)
// Tag names are short refs so callers can build refspecs from them directly.
check('next   → 0.1.1-rc.2 (the rc line plugins support)', [next.version, next.tag], ['0.1.1-rc.2', 'dsh-v0.1.1-rc.2'])
check('alpha  → 0.1.2-alpha.2 (newest, plugin-breaking)', [alpha.version, alpha.tag], ['0.1.2-alpha.2', 'dsh-v0.1.2-alpha.2'])
// rc is inside the canary accept-list, so this is a legitimate match.
check('canary → 0.1.1-rc.2 (no canary tag yet; rc is in-channel)', [canary.channel, canary.version, canary.degraded], ['canary', '0.1.1-rc.2', false])
// A "stable" request resolving to an rc must be flagged, never passed off as stable.
check('stable → 0.1.1-rc.2 but flagged degraded', [stable.channel, stable.version, stable.degraded], ['stable', '0.1.1-rc.2', true])
check('^{} deref lines do not leak into tag names', /(?:\^\{\})$/.test(next.tag), false)
check('non-version tag ignored', C.tagToVersion('refs/tags/not-a-version'), null)

// ── Fixture 2: upstream later publishes canary + a final release ──
console.log('\n=== Fixture 2: future upstream (canary + 0.2.0 final) ===')
const FUTURE = [...realTags, 'refs/tags/dsh-v0.1.2-canary.1', 'refs/tags/dsh-v0.2.0']
check('stable → 0.2.0', C.selectChannelTag('stable', FUTURE).version, '0.2.0')
check('next   → 0.2.0', C.selectChannelTag('next', FUTURE).version, '0.2.0')
// 0.2.0 is a higher semver than 0.1.2-canary.1 and sits in the canary
// accept-list, so it wins — a canary user is not pinned to an older line once
// something newer is released.
check('canary → 0.2.0 (newest in-channel, beats the older canary)', C.selectChannelTag('canary', FUTURE).version, '0.2.0')
check('canary is no longer degraded once a final release exists', C.selectChannelTag('canary', FUTURE).degraded, false)
check('stable → 0.2.0 and not degraded', (() => { const s = C.selectChannelTag('stable', FUTURE); return [s.version, s.degraded] })(), ['0.2.0', false])
check('alpha  → 0.2.0 (alpha accepts everything, newest wins)', C.selectChannelTag('alpha', FUTURE).version, '0.2.0')

// ── Fixture 3: semver ordering edges ──
console.log('\n=== Fixture 3: semver ordering ===')
const cmp = (a, b) => Math.sign(C.compareVersion(a, b))
check('0.1.1-rc.2 > 0.1.1-rc.1', cmp('0.1.1-rc.2', '0.1.1-rc.1'), 1)
check('rc.10 > rc.2 (numeric, not lexicographic)', cmp('0.1.0-rc.10', '0.1.0-rc.2'), 1)
check('1.0.0 > 1.0.0-rc.1 (release beats prerelease)', cmp('1.0.0', '1.0.0-rc.1'), 1)
check('0.1.2-alpha.2 > 0.1.1-rc.2 (alpha is a NEWER line)', cmp('0.1.2-alpha.2', '0.1.1-rc.2'), 1)
check('alpha < canary < rc within one line', [cmp('0.1.2-alpha.1', '0.1.2-canary.1'), cmp('0.1.2-canary.1', '0.1.2-rc.1')], [-1, -1])
check('equal versions compare as 0', cmp('0.1.1-rc.2', '0.1.1-rc.2'), 0)

// ── Fixture 4: channel hygiene ──
console.log('\n=== Fixture 4: channel id handling ===')
check("normalizeChannel('nonsense') → next", C.normalizeChannel('nonsense'), 'next')
check('normalizeChannel(undefined) → next', C.normalizeChannel(undefined), 'next')
check("normalizeChannel('alpha') → alpha", C.normalizeChannel('alpha'), 'alpha')
check('next channel has no fallback (must not jump to stable)', C.channelFallbacks('next'), [])
check('alpha falls back canary → next', C.channelFallbacks('alpha'), ['canary', 'next'])
check('alpha/canary are risky, stable/next are not', C.CHANNELS.map((c) => c.risky), [false, false, true, true])
check('empty tag list resolves to null (caller keeps old behaviour)', C.selectChannelTag('next', []), null)
check('unparseable tags only → null', C.selectChannelTag('next', ['refs/tags/whatever']), null)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
