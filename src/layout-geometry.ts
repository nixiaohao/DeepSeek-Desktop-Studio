/**
 * layout-geometry.ts — the arithmetic behind the main window's three columns.
 *
 * WHY THIS IS A SEPARATE, ELECTRON-FREE MODULE
 * --------------------------------------------
 * The window is a real three-column layout:
 *
 *      ┌──────────┬──────────────────────────┬─────────┐
 *      │ sidebar  │  dsh page (content)      │ panel   │
 *      ├──────────┴──────────────────────────┴─────────┤
 *      │                log bar (logs)                 │
 *      ├───────────────────────────────────────────────┤
 *      │                status bar                     │
 *
 * Every rectangle is derived from the SAME numbers that draw the overlays, so
 * the page can neither be covered by them nor leave a dead gap beside them.
 * Getting that wrong is invisible in code review and obvious only on screen,
 * which is exactly the kind of arithmetic worth testing — hence no Electron
 * import here, so `test/layout-geometry.unit.cjs` can run it in plain node.
 *
 * WHY THE PAGE HAS ITS OWN VIEW AT ALL (see window-manager.ts)
 * ------------------------------------------------------------
 * A BrowserWindow's built-in webContents is not part of contentView.children
 * and cannot be moved or resized (verified on Electron 33.4.11). While the dsh
 * page lived there, the overlays could only COVER it, and the workaround was
 * to inject CSS padding. That produced both reported symptoms: the sidebar
 * hid the dsh file tree, and the injected right padding left a blank strip
 * before the panel, because padding moves content but does not move the
 * viewport the page lays itself out in.
 */

/**
 * Height of the bottom status bar, px.
 *
 * 28, not 26: the bar's text runs at --fs-md (13px, see statusbar.html) with a
 * 1.45 line-height, which needs ~19px of text box; 26px left the buttons
 * touching the divider. Keep in sync with the shell's type scale.
 */
export const STATUS_BAR_HEIGHT = 28
/** Draggable width limits for the right panel, px. */
export const PANEL_MIN_WIDTH = 240
export const PANEL_MAX_WIDTH = 720
/** Draggable width limits for the left file/git sidebar, px. */
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 560
/**
 * Narrowest the dsh page is ever squeezed to, px.
 *
 * Below this the chat column stops being usable, so the overlays give up their
 * space (see `fit`) instead of the page.
 */
export const CONTENT_MIN_WIDTH = 360

/** Draggable height limits for the bottom log bar, px. */
export const LOGBAR_MIN_HEIGHT = 100
export const LOGBAR_MAX_HEIGHT = 480
/**
 * Vertical space the dsh page is ever squeezed to, px.
 *
 * The horizontal `CONTENT_MIN_WIDTH` has a vertical counterpart for the same
 * reason: when the window is too short to show both a usable page and the log
 * bar, the log bar collapses to 0 (via `fit`) instead of drawing a clipped
 * strip over a page that has already been squeezed flat.
 */
export const CONTENT_MIN_HEIGHT = 240

/** What the layout is computed from. All lengths in px. */
export interface LayoutInput {
  /** Window content width (window size minus the OS frame), px. */
  width: number
  /** Window content height, px. */
  height: number
  sidebarVisible: boolean
  /** Preferred sidebar width; clamped, so it is not necessarily the drawn one. */
  sidebarWidth: number
  panelVisible: boolean
  /** Preferred panel width; clamped, so it is not necessarily the drawn one. */
  panelWidth: number
  statusVisible: boolean
  /** Bottom log bar shown. */
  logbarVisible: boolean
  /** Preferred log bar height; clamped, so it is not necessarily the drawn one. */
  logbarHeight: number
}

/** A rectangle in window-content coordinates. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Every rectangle of the main window, computed together. */
export interface WindowLayout {
  /** The dsh page: the space BETWEEN the two overlays. */
  content: Rect
  sidebar: Rect
  panel: Rect
  /** Full-width strip above the status bar (zero height when hidden/collapsed). */
  logbar: Rect
  statusBar: Rect
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Width an overlay is actually drawn at.
 *
 * `room` is what is left once the page's minimum is reserved. When there is
 * less than `min` there is no honest way to draw the overlay, so it collapses
 * to 0 and the page gets the space back. Returning `min` instead would draw a
 * clipped overlay on top of a page that had already been shrunk past its
 * minimum — the "dead gap" class of bug, just on the other edge.
 */
function fit(preferred: number, min: number, max: number, room: number): number {
  if (room < min) return 0
  return clamp(preferred, min, Math.min(max, room))
}

/**
 * Compute all four rectangles at once.
 *
 * Single source of truth on purpose: when the sidebar's drawn width and the
 * page's x-offset were computed in two places they drifted, and the page ended
 * up padded for a sidebar that was never drawn.
 */
export function computeLayout(input: LayoutInput): WindowLayout {
  const bar = input.statusVisible ? STATUS_BAR_HEIGHT : 0
  const room = Math.max(0, input.height - bar)

  // The log bar is decided before the columns because it takes a horizontal
  // slice out of every one of their heights. Same `fit` semantics as the
  // overlays: when reserving the page's vertical minimum would leave less
  // than LOGBAR_MIN_HEIGHT, the bar collapses to 0 instead of drawing a
  // clipped strip.
  const logbarHeight = input.logbarVisible
    ? fit(input.logbarHeight, LOGBAR_MIN_HEIGHT, LOGBAR_MAX_HEIGHT, room - CONTENT_MIN_HEIGHT)
    : 0
  const bodyHeight = Math.max(0, room - logbarHeight)

  // Panel first: it is anchored to the right edge, so its clamped width has to
  // be known before the sidebar can be told how much room is left.
  const panelWidth = input.panelVisible
    ? fit(input.panelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, input.width - CONTENT_MIN_WIDTH)
    : 0
  const sidebarWidth = input.sidebarVisible
    ? fit(
        input.sidebarWidth,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH,
        input.width - panelWidth - CONTENT_MIN_WIDTH,
      )
    : 0

  return {
    // The page starts exactly where the sidebar ends and ends exactly where
    // the panel begins: no overlap, no gap.
    content: {
      x: sidebarWidth,
      y: 0,
      width: Math.max(0, input.width - sidebarWidth - panelWidth),
      height: bodyHeight,
    },
    sidebar: { x: 0, y: 0, width: sidebarWidth, height: bodyHeight },
    panel: {
      x: Math.max(0, input.width - panelWidth),
      y: 0,
      width: panelWidth,
      height: bodyHeight,
    },
    logbar: {
      x: 0,
      y: Math.max(0, input.height - bar - logbarHeight),
      width: input.width,
      height: logbarHeight,
    },
    statusBar: {
      x: 0,
      y: Math.max(0, input.height - STATUS_BAR_HEIGHT),
      width: input.width,
      height: STATUS_BAR_HEIGHT,
    },
  }
}
