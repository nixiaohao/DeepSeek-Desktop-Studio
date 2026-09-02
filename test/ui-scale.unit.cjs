/**
 * ui-scale.unit.cjs — the injected font-scale CSS and its input sanitising.
 *
 * The string produced here is injected into four separate Chromium pages. A
 * malformed value is NOT an error there: Chromium drops the invalid
 * declaration and the page quietly renders at the default size, so nothing
 * crashes, nothing logs, and the only symptom is that the user's font-size
 * choice appears to do nothing. That is why the normalisation is tested rather
 * than assumed.
 */
const assert = require('node:assert')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib-new')
const { uiScaleCss } = require(path.join(LIB, 'ui-scale.js'))
const { normalizeUiScale, uiScaleLabel, UI_SCALES, DEFAULT_PANEL_PREFS } = require(path.join(LIB, 'preferences.js'))

let assertions = 0
function check(label, fn) {
  try {
    fn()
    assertions += 1
  } catch (err) {
    console.error(`FAIL  ${label}\n      ${err.message}`)
    process.exitCode = 1
  }
}

console.log('ui-scale: injected CSS')

check('default scale emits the exact override the pages expect', () => {
  assert.strictEqual(uiScaleCss(1), ':root { --fs-scale: 1 !important; }')
})

check('every supported step round-trips into the CSS verbatim', () => {
  for (const s of UI_SCALES) {
    assert.strictEqual(uiScaleCss(s), `:root { --fs-scale: ${s} !important; }`)
  }
})

check('the override is !important — a bare rule loses to the page :root', () => {
  // The pages declare `--fs-scale: 1` in their own :root block. Without
  // !important the injected rule can lose the cascade and the page renders at
  // the default size while the menu shows the user's choice as active.
  assert.match(uiScaleCss(1.3), /!important/)
  assert.match(uiScaleCss(1.3), /--fs-scale:\s*1\.3/)
})

// ── hostile / hand-edited prefs values ──

check('0 is lifted to the smallest step, never injected as 0', () => {
  // --fs-scale: 0 renders every panel as blank text — indistinguishable from a
  // crash. This is the single worst value the prefs file can hold.
  assert.strictEqual(normalizeUiScale(0), UI_SCALES[0])
  assert.doesNotMatch(uiScaleCss(0), /--fs-scale:\s*0(\s|;|$)/)
})

check('NaN is lifted to the default', () => {
  // JSON can hold `null`, and Number.isFinite rejects it; without this guard a
  // `null` becomes the string "null" in CSS → invalid declaration → silent
  // default size, which reads as "the menu item is broken".
  assert.strictEqual(normalizeUiScale(NaN), 1)
  assert.strictEqual(normalizeUiScale(null), 1)
  assert.strictEqual(normalizeUiScale(undefined), 1)
  assert.strictEqual(normalizeUiScale('1.15'), 1)
})

check('out-of-range numbers land on the nearest legal step', () => {
  assert.strictEqual(normalizeUiScale(-5), UI_SCALES[0])
  assert.strictEqual(normalizeUiScale(999), UI_SCALES[UI_SCALES.length - 1])
  // Between two steps → nearest, never rounded up past the largest.
  assert.strictEqual(normalizeUiScale(1.1), 1.15)
  assert.strictEqual(normalizeUiScale(0.95), 1)
})

check('no input can produce a non-numeric or negative scale', () => {
  for (const v of [0, -1, NaN, Infinity, -Infinity, null, undefined, '', {}, [], 1e9]) {
    const css = uiScaleCss(v)
    const m = /--fs-scale:\s*([^\s;!]+)/.exec(css)
    assert.ok(m, `no scale parsed from ${css}`)
    const n = Number(m[1])
    assert.ok(Number.isFinite(n) && n > 0, `scale ${n} from input ${String(v)} is not a positive number`)
  }
})

// ── labels + default ──

check('every step has a non-empty Chinese label', () => {
  for (const s of UI_SCALES) {
    const label = uiScaleLabel(s)
    assert.ok(typeof label === 'string' && label.length > 0, `no label for ${s}`)
    assert.ok(!/undefined|标准$/.test(label) || s === 1, `step ${s} fell back to the default label`)
  }
  // Distinct labels: four identical radio entries would be useless in the menu.
  const labels = UI_SCALES.map(uiScaleLabel)
  assert.strictEqual(new Set(labels).size, labels.length)
})

check('the shipped default is the baseline step', () => {
  assert.strictEqual(DEFAULT_PANEL_PREFS.uiScale, 1)
  assert.ok(UI_SCALES.includes(DEFAULT_PANEL_PREFS.uiScale))
})

console.log(`ui-scale: ${assertions} assertions`)
