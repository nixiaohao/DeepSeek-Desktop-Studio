/**
 * layout-geometry tests.
 *
 * This module is the arithmetic behind the main window's three columns, and
 * it is the first thing that breaks when the layout regresses — so it is
 * tested here in plain node, with no Electron and no window.
 *
 * The invariants that matter are NOT the individual numbers. They are:
 *
 *   - the page starts exactly where the sidebar ends and ends exactly where
 *     the panel begins (no overlap, no gap) — this is what fixes both the
 *     "sidebar covers the dsh file tree" and the "blank strip before the
 *     panel" reports;
 *   - the page keeps a usable minimum width, and the overlays are the ones
 *     that give up space;
 *   - nothing ever comes out negative, because these numbers go straight
 *     into WebContentsView.setBounds(), which does not accept NaN and does
 *     not forgive a negative width.
 */

const assert = require('node:assert')
const path = require('node:path')

const {
  computeLayout,
  STATUS_BAR_HEIGHT,
  PANEL_MIN_WIDTH,
  PANEL_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  CONTENT_MIN_WIDTH,
  CONTENT_MIN_HEIGHT,
  LOGBAR_MIN_HEIGHT,
  LOGBAR_MAX_HEIGHT,
} = require(path.join(__dirname, '..', 'lib-new', 'layout-geometry.js'))

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

/** Everything on, 1280 content width — the common case. */
function base(overrides) {
  return computeLayout({
    width: 1280,
    height: 800,
    sidebarVisible: true,
    sidebarWidth: 240,
    panelVisible: true,
    panelWidth: 320,
    statusVisible: true,
    logbarVisible: false,
    logbarHeight: 180,
    ...overrides,
  })
}

// ── The reported default: 1280 wide, everything shown ──

check('1280×800: content sits exactly between sidebar and panel', () => {
  const r = base()
  assert.strictEqual(r.sidebar.x, 0)
  assert.strictEqual(r.sidebar.width, 240)
  assert.strictEqual(r.content.x, 240, 'page starts where the sidebar ends')
  assert.strictEqual(r.content.width, 1280 - 240 - 320)
  assert.strictEqual(r.panel.x, 1280 - 320)
  assert.strictEqual(r.panel.width, 320)
  // The whole point: page right edge == panel left edge.
  assert.strictEqual(r.content.x + r.content.width, r.panel.x)
})

check('status bar spans the window and the body is shortened by it', () => {
  const r = base()
  assert.strictEqual(r.statusBar.x, 0)
  assert.strictEqual(r.statusBar.width, 1280)
  assert.strictEqual(r.statusBar.height, STATUS_BAR_HEIGHT)
  assert.strictEqual(r.statusBar.y, 800 - STATUS_BAR_HEIGHT)
  assert.strictEqual(r.content.height, 800 - STATUS_BAR_HEIGHT)
  assert.strictEqual(r.content.y, 0)
})

check('status bar hidden gives the body the full height', () => {
  const r = base({ statusVisible: false })
  assert.strictEqual(r.content.height, 800)
  assert.strictEqual(r.panel.height, 800)
})

// ── Visibility toggles move the page, they do not cover it ──

check('sidebar hidden: page starts at 0 and takes the freed space', () => {
  const r = base({ sidebarVisible: false })
  assert.strictEqual(r.content.x, 0)
  assert.strictEqual(r.content.width, 1280 - 320)
})

check('panel hidden: page grows to the right edge', () => {
  const r = base({ panelVisible: false })
  assert.strictEqual(r.content.x + r.content.width, 1280)
  assert.strictEqual(r.content.width, 1280 - 240)
})

check('both overlays hidden: page fills the window', () => {
  const r = base({ sidebarVisible: false, panelVisible: false })
  assert.strictEqual(r.content.x, 0)
  assert.strictEqual(r.content.width, 1280)
})

// ── Clamping ──

check('over-wide requests are clamped to the drag maximums', () => {
  // Tested one at a time on purpose: with both open they compete for the same
  // room, so the sidebar's honest answer at 1280px behind a 720px panel is
  // "whatever is left", not its own maximum.
  const sidebar = base({ panelVisible: false, sidebarWidth: 4000 })
  assert.strictEqual(sidebar.sidebar.width, SIDEBAR_MAX_WIDTH)
  const panel = base({ sidebarVisible: false, panelWidth: 4000 })
  assert.strictEqual(panel.panel.width, PANEL_MAX_WIDTH)
})

check('under-narrow requests are clamped up to the drag minimums', () => {
  const r = base({ sidebarWidth: 10, panelWidth: 10 })
  assert.strictEqual(r.sidebar.width, SIDEBAR_MIN_WIDTH)
  assert.strictEqual(r.panel.width, PANEL_MIN_WIDTH)
})

check('the page keeps its minimum and the overlays yield first', () => {
  // 700px: the panel fits (700-360 = 340 ≥ 240), but nothing is left for a
  // 200px sidebar, so the sidebar collapses and the page keeps 380px.
  const r = base({ width: 700, sidebarWidth: 240, panelWidth: 320 })
  assert.strictEqual(r.panel.width, 320)
  assert.strictEqual(r.sidebar.width, 0, 'sidebar collapses rather than squeezing the page')
  assert.strictEqual(r.content.width, 380)
  assert.ok(r.content.width >= CONTENT_MIN_WIDTH, 'page never goes below its minimum')
  // A collapsed overlay must not leave the page offset behind it.
  assert.strictEqual(r.content.x, 0)
  assert.strictEqual(r.content.x + r.content.width + r.panel.width, 700)
})

check('an unusably narrow window still yields non-negative rects', () => {
  const r = base({ width: 80, height: 20 })
  for (const key of ['content', 'sidebar', 'panel', 'logbar', 'statusBar']) {
    const rect = r[key]
    assert.ok(rect.width >= 0, `${key}.width must not be negative (got ${rect.width})`)
    assert.ok(rect.height >= 0, `${key}.height must not be negative (got ${rect.height})`)
    assert.ok(rect.x >= 0, `${key}.x must not be negative (got ${rect.x})`)
    assert.ok(rect.y >= 0, `${key}.y must not be negative (got ${rect.y})`)
  }
})

check('a height below the status bar clamps to 0 instead of going negative', () => {
  const r = base({ height: 10 })
  assert.strictEqual(r.content.height, 0)
  assert.strictEqual(r.statusBar.y, 0)
})

// ── The bottom log bar ──

check('log bar hidden: zero-height rect, page keeps the full body', () => {
  const r = base()
  assert.deepStrictEqual(r.logbar, { x: 0, y: 800 - STATUS_BAR_HEIGHT, width: 1280, height: 0 })
  assert.strictEqual(r.content.height, 800 - STATUS_BAR_HEIGHT)
})

check('log bar visible: full-width strip between the body and the status bar', () => {
  const r = base({ logbarVisible: true })
  assert.strictEqual(r.logbar.width, 1280)
  assert.strictEqual(r.logbar.height, 180)
  assert.strictEqual(r.logbar.y, 800 - STATUS_BAR_HEIGHT - 180)
  // Every column gives up exactly the log bar's height.
  assert.strictEqual(r.content.height, 800 - STATUS_BAR_HEIGHT - 180)
  assert.strictEqual(r.sidebar.height, r.content.height)
  assert.strictEqual(r.panel.height, r.content.height)
  // The status bar itself does not move.
  assert.strictEqual(r.statusBar.y, 800 - STATUS_BAR_HEIGHT)
})

check('log bar collapses when the page would lose its vertical minimum', () => {
  // room = 400 - 28 = 372; reserving CONTENT_MIN_HEIGHT leaves 132 < MIN 100?
  // No — 132 >= 100, so the bar survives at 132. Choose a shorter window.
  const tight = base({ height: 350, logbarVisible: true })
  assert.strictEqual(tight.logbar.height, 0, 'collapses below the vertical minimum')
  assert.strictEqual(tight.content.height, 350 - STATUS_BAR_HEIGHT)

  // Just above the threshold: room-240 = 132 → the bar gets exactly that.
  const fitting = base({ height: 400, logbarVisible: true })
  assert.strictEqual(fitting.logbar.height, 400 - STATUS_BAR_HEIGHT - CONTENT_MIN_HEIGHT)
  assert.ok(fitting.logbar.height >= LOGBAR_MIN_HEIGHT)
  assert.strictEqual(fitting.content.height, CONTENT_MIN_HEIGHT)
})

check('log bar height is clamped to the drag range', () => {
  const tall = base({ logbarVisible: true, logbarHeight: 4000 })
  assert.strictEqual(tall.logbar.height, LOGBAR_MAX_HEIGHT)
  const short = base({ logbarVisible: true, logbarHeight: 5 })
  assert.strictEqual(short.logbar.height, LOGBAR_MIN_HEIGHT)
})

check('hiding the status bar hands its strip to the log bar, not to overlap', () => {
  const r = base({ statusVisible: false, logbarVisible: true })
  assert.strictEqual(r.logbar.y + r.logbar.height, 800)
  assert.strictEqual(r.content.height, 800 - 180)
})

// ── The invariant sweep: this is the regression net ──

check('sweep: page is always flush with both overlays, never overlapping', () => {
  const widths = [0, 1, 200, 320, 480, 640, 900, 1024, 1280, 1600, 1920, 2560]
  const heights = [0, 1, 26, 400, 800, 1440]
  for (const width of widths) {
    for (const height of heights) {
      for (const sidebarVisible of [true, false]) {
        for (const panelVisible of [true, false]) {
          for (const logbarVisible of [true, false]) {
            const r = computeLayout({
              width,
              height,
              sidebarVisible,
              sidebarWidth: 240,
              panelVisible,
              panelWidth: 320,
              statusVisible: true,
              logbarVisible,
              logbarHeight: 180,
            })
            const where = `width=${width} height=${height} sidebar=${sidebarVisible} panel=${panelVisible} logbar=${logbarVisible}`

            // No gap and no overlap on the left edge.
            assert.strictEqual(r.content.x, r.sidebar.width, `left edge: ${where}`)
            // No gap and no overlap on the right edge.
            assert.strictEqual(
              r.content.x + r.content.width + r.panel.width,
              width,
              `right edge must be flush: ${where}`
            )
            // The panel is anchored to the right edge.
            assert.strictEqual(r.panel.x + r.panel.width, width, `panel anchor: ${where}`)
            // Overlays never overlap each other.
            assert.ok(
              r.sidebar.x + r.sidebar.width <= r.panel.x || r.panel.width === 0,
              `sidebar/panel overlap: ${where}`
            )
            // Whatever is left for the page is never negative.
            assert.ok(r.content.width >= 0, `negative page width: ${where}`)

            // Vertical stack: body columns, then the log bar, then the status
            // bar — the three slices must tile the window exactly. Above a
            // degenerate window (height < the status strip) the status bar
            // cannot be fitted at all, so the invariant is stated against the
            // space the status bar actually leaves.
            const bar = STATUS_BAR_HEIGHT
            assert.strictEqual(
              r.content.height + r.logbar.height,
              Math.max(0, height - bar),
              `vertical tiling: ${where}`
            )
            assert.strictEqual(
              r.logbar.y + r.logbar.height,
              Math.max(0, height - bar),
              `log bar sits on the status bar: ${where}`
            )
            assert.ok(r.logbar.height >= 0, `negative log bar height: ${where}`)
          }
        }
      }
    }
  }
})

check('sweep: widening the window never shrinks the page', () => {
  let previous = -1
  for (let width = 1024; width <= 2560; width += 64) {
    const r = computeLayout({
      width,
      height: 800,
      sidebarVisible: true,
      sidebarWidth: 240,
      panelVisible: true,
      panelWidth: 320,
      statusVisible: true,
      logbarVisible: true,
      logbarHeight: 180,
    })
    assert.ok(
      r.content.width >= previous,
      `page shrank when the window grew: ${width - 64}px → ${width}px`
    )
    previous = r.content.width
  }
})

console.log(`\nlayout-geometry: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
