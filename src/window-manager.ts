/**
 * window-manager.ts — three-column layout for the main window.
 *
 * THE LAYOUT
 * ----------
 *      ┌──────────┬──────────────────────────┬─────────┐
 *      │ sidebar  │  dsh page (content view) │ panel   │
 *      └──────────┴──────────────────────────┴─────────┘
 *      │                status bar                     │
 *
 * All four are `WebContentsView`s owned by this class — INCLUDING the dsh page.
 * That last part is the whole point, and it is the one non-obvious decision
 * here, so it is worth spelling out.
 *
 * WHY THE dsh PAGE IS ITS OWN VIEW (and not the BrowserWindow's webContents)
 * --------------------------------------------------------------------------
 * A BrowserWindow's built-in webContents is NOT part of contentView.children
 * and cannot be moved or resized (verified with a probe on Electron 33.4.11).
 * While the page lived there, our overlays could only COVER it, and the
 * workaround was to inject CSS padding so the content reflowed out from
 * underneath. That workaround caused both reported symptoms:
 *
 *   - the sidebar hid the dsh file tree (padding would have pushed the tree
 *     into the chat column instead, which was reported earlier as "挤压"), and
 *   - the injected right padding left a blank strip before the panel, because
 *     padding shrinks the content box but does NOT move the viewport the page
 *     lays itself out in.
 *
 * Giving the page its own view makes the window a real three-column layout:
 * the page is bounded to the space between the overlays, so it reflows itself
 * — nothing is covered, nothing is padded, and no CSS is injected into a page
 * we do not own. The rectangles all come from layout-geometry.ts.
 *
 * TWO RULES THAT STILL BITE
 * -------------------------
 *  1. z-order is insertion order: the content view MUST be added before the
 *     overlays or it paints on top of them.
 *  2. Child view bounds are absolute and are NOT auto-updated on window
 *     resize, so every geometry change must go through layout().
 *
 * FONT SIZE
 * ---------
 * The shell pages get their type scale from `--fs-scale`, which the main
 * process overrides with insertCSS (see ui-scale.ts). The overlay views are
 * injected on creation AND on every did-finish-load, because insertCSS does not
 * survive a navigation; setUiScale() re-injects into the live views.
 */
import { app, BrowserWindow, WebContentsView, type WebContents } from 'electron'
import { join } from 'node:path'
import { loadPanelPrefs, savePanelPrefs, type PanelPrefs, type UiScale } from './preferences.js'
import { uiScaleCss } from './ui-scale.js'
import { log } from './logging.js'
import type { ViewState } from './diagnostics.js'
import {
  computeLayout,
  CONTENT_MIN_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  STATUS_BAR_HEIGHT,
} from './layout-geometry.js'

/** Re-exported so existing importers keep working. */
export { STATUS_BAR_HEIGHT, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH }

/**
 * How many preload/renderer failure strings are kept per view.
 *
 * These strings are the ONLY surviving record of why a preload died: once it
 * has thrown, that view can no longer be asked anything, so there is no way to
 * reconstruct the reason later. Small on purpose — it is diagnostics text, and
 * the full history is already in launcher.log.
 */
const VIEW_ERROR_LIMIT = 8

/** The overlays whose preload health is tracked. */
export type ViewLabel = 'panel' | 'statusbar' | 'sidebar'

/** Options for the dsh page's view. */
export interface ContentViewOptions {
  /** The authenticated localhost URL (carries the per-process token). */
  url: string
  /** Absolute path to the main window's preload. */
  preload: string
}

export class WindowManager {
  private readonly win: BrowserWindow
  /** The dsh page. Null until createContentView(). */
  private contentView: WebContentsView | null = null
  private panelView: WebContentsView | null = null
  private statusView: WebContentsView | null = null
  private sidebarView: WebContentsView | null = null
  private prefs: PanelPrefs
  private resizeBound = false
  /**
   * Per-overlay preload health, seeded in attach() and updated from the
   * `*:view-ready` ping and the preload-error / render-process-gone events.
   *
   * The ping is what makes a dead preload *diagnosable* rather than merely
   * visible: without it the only symptom is the page's own fallback string,
   * which cannot say whether the preload never ran, threw while requiring a
   * module, or was never packaged.
   */
  private readonly viewState = new Map<ViewLabel, { readyAt: number; errors: string[] }>()

  constructor(win: BrowserWindow) {
    this.win = win
    this.prefs = loadPanelPrefs()
  }

  /**
   * Record that an overlay's preload ran to completion and exposed its bridge.
   *
   * Called over IPC from the preload itself, which is the only place that can
   * truthfully claim it: a preload that throws never reaches the send.
   */
  markViewReady(label: string): void {
    const key = label as ViewLabel
    if (!this.viewState.has(key)) return
    this.viewState.set(key, { readyAt: Date.now(), errors: this.viewState.get(key)?.errors ?? [] })
  }

  /** Per-view preload health, for the diagnostics report. */
  viewStates(): Record<string, ViewState> {
    const out: Record<string, ViewState> = {}
    for (const [key, value] of this.viewState) out[key] = { ...value, errors: value.errors.slice() }
    return out
  }

  /**
   * Keep a bounded record of why a view died.
   *
   * Deliberately does NOT reset `readyAt`: a view that loaded fine and then
   * crashed is a different problem from one that never loaded, and collapsing
   * them would tell the user to look for a preload bug that isn't there.
   */
  private recordViewError(label: ViewLabel, message: string): void {
    const current = this.viewState.get(label)
    if (!current) return
    const errors = [...current.errors, message]
    if (errors.length > VIEW_ERROR_LIMIT) errors.splice(0, errors.length - VIEW_ERROR_LIMIT)
    this.viewState.set(label, { readyAt: current.readyAt, errors })
  }

  /** The main window the views are attached to. */
  get window(): BrowserWindow {
    return this.win
  }

  /** The view rendering the dsh page (null until createContentView()). */
  get content(): WebContentsView | null {
    return this.contentView
  }

  /**
   * The dsh page's WebContents, or null before the content view exists.
   *
   * Anything that wants to load, reload, re-theme or script the page must go
   * through this and NOT through `window.webContents`: the BrowserWindow's own
   * webContents is now an empty backdrop, and talking to it silently does
   * nothing at all.
   */
  get pageContents(): WebContents | null {
    return this.contentView?.webContents ?? null
  }

  /** The panel's WebContentsView (null until attach()). */
  get panel(): WebContentsView | null {
    return this.panelView
  }

  /** The status bar's WebContentsView (null until attach()). */
  get statusBar(): WebContentsView | null {
    return this.statusView
  }

  /** The file/git sidebar's WebContentsView (null until attach()). */
  get sidebar(): WebContentsView | null {
    return this.sidebarView
  }

  get panelPrefs(): PanelPrefs {
    return { ...this.prefs }
  }

  /**
   * Create the view that renders the dsh page and load it.
   *
   * MUST be called before attach(): contentView.children paint in insertion
   * order, so the page has to be the first child or it covers its own panel.
   *
   * `loadURL` is async, and `did-finish-load` is delivered from the renderer
   * over IPC — it therefore cannot fire before the current synchronous block
   * returns, so callers can safely attach their load listeners to the returned
   * view afterwards.
   */
  createContentView(opts: ContentViewOptions): WebContentsView {
    if (this.contentView) return this.contentView
    const view = new WebContentsView({
      webPreferences: {
        preload: opts.preload,
        contextIsolation: true,
        nodeIntegration: false,
        // Same reasoning as the overlays below: keep the main preload's
        // require() working if it ever grows one.
        sandbox: false,
      },
    })
    this.contentView = view
    this.win.contentView.addChildView(view)
    void view.webContents.loadURL(opts.url)
    this.layout()
    return view
  }

  /**
   * Keep one view's font scale applied across its whole lifetime.
   *
   * The first insertCSS is best-effort and may land before the document exists
   * (loadFile is async); the did-finish-load handler is the one that reliably
   * takes effect, and it also covers any later reload.
   */
  private bindUiScale(view: WebContentsView): void {
    const apply = (): void => {
      void view.webContents.insertCSS(uiScaleCss(this.prefs.uiScale)).catch(() => {})
    }
    apply()
    view.webContents.on('did-finish-load', apply)
  }

  /** Re-apply the font scale to every live shell view. */
  private applyUiScaleNow(): void {
    const css = uiScaleCss(this.prefs.uiScale)
    for (const view of [this.panelView, this.statusView, this.sidebarView]) {
      if (!view || view.webContents.isDestroyed()) continue
      void view.webContents.insertCSS(css).catch(() => {})
    }
  }

  /**
   * Change the panel font size (one of UI_SCALES).
   *
   * The value is normalised on read (preferences.normalizeUiScale) as well as
   * on load, so a hand-edited prefs file cannot blank the panels out.
   */
  setUiScale(scale: UiScale): void {
    this.prefs = { ...this.prefs, uiScale: scale }
    savePanelPrefs({ uiScale: scale })
    this.applyUiScaleNow()
  }

  get uiScale(): UiScale {
    return this.prefs.uiScale
  }

  /**
   * Create the overlay views and start tracking geometry.
   * Safe to call once per window.
   */
  attach(): void {
    if (this.panelView) return

    const preload = join(__dirname, 'panel-preload.js')
    const sidebarPreload = join(__dirname, 'sidebar-preload.js')
    const assets = join(app.getAppPath(), 'assets')

    // IMPORTANT: `sandbox: false` here and on every overlay.
    //
    // Electron 22+ defaults webPreferences.sandbox to true. In a sandboxed
    // renderer the preload script is allowed only `require('electron')`,
    // `require('events')`, etc. — NOT project files. panel-preload.js requires
    // `./path-links.js` and `./health-monitor.js` (both bundled in app.asar),
    // and the second require fails before contextBridge.exposeInMainWorld runs,
    // so `window.dshPanel` stays undefined and the panel shows
    // "preload 未加载". The main window's preload only requires 'electron'
    // so it survives either way, but for the overlays we MUST opt out.
    //
    // It is still safe: panel.html / statusbar.html are our own static assets
    // loaded from `file://` inside app.asar, not remote content.
    this.panelView = new WebContentsView({
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    // The query string is how the preload learns which overlay it is running
    // in. panel-preload.js serves BOTH the panel and the status bar, so the
    // label cannot be baked into the file; it reports itself back over
    // `panel:view-ready` and the diagnostics report is keyed on it.
    this.panelView.webContents.loadFile(join(assets, 'panel.html'), { query: { view: 'panel' } })

    this.statusView = new WebContentsView({
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    this.statusView.webContents.loadFile(join(assets, 'statusbar.html'), { query: { view: 'statusbar' } })

    // The sidebar gets its OWN preload rather than sharing panel-preload.js:
    // that file's exposed API is brace-matched by test/panel-api.contract.cjs,
    // so every sidebar method added there would have to satisfy the panel's
    // contract too. Separate file, separate contract.
    //
    // `sandbox: false` for the same reason as the others — see the long comment
    // above. It requires no local modules today, but the next person to add one
    // should not have to rediscover this.
    this.sidebarView = new WebContentsView({
      webPreferences: {
        preload: sidebarPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    this.sidebarView.webContents.loadFile(join(assets, 'sidebar.html'), { query: { view: 'sidebar' } })

    // Seed the health map BEFORE the views can report anything: a view that
    // never pings must still appear in the report as "never reported ready"
    // rather than being absent, because absence would read as "not enabled".
    this.viewState.set('panel', { readyAt: 0, errors: [] })
    this.viewState.set('statusbar', { readyAt: 0, errors: [] })
    this.viewState.set('sidebar', { readyAt: 0, errors: [] })

    // Font scaling. Registered per view, not once globally: insertCSS is
    // per-WebContents and does not survive a navigation, so each view re-applies
    // its own copy on reload. See ui-scale.ts for why this is CSS and not zoom.
    for (const view of [this.panelView, this.statusView, this.sidebarView]) {
      if (!view) continue
      this.bindUiScale(view)
    }

    // Catch preload failures. Electron emits this when the script throws OR
    // never finishes loading. Without it the user sees only a dead "preload 未
    // 加载" string with no clue why; with it we get a real reason in the log
    // and panel.html can show it instead of the dead default.
    for (const view of [this.panelView, this.statusView, this.sidebarView]) {
      if (!view) continue
      const label: ViewLabel =
        view === this.panelView ? 'panel' : view === this.statusView ? 'statusbar' : 'sidebar'
      view.webContents.on('preload-error', (_e, preloadPath, err) => {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        log('launcher', `preload-error[${label}] path=${preloadPath} ${message}`)
        this.recordViewError(label, `preload-error: ${message}`)
      })
      view.webContents.on('render-process-gone', (_e, details) => {
        log('launcher', `renderer-gone[${label}] reason=${details.reason} exitCode=${details.exitCode}`)
        this.recordViewError(label, `renderer-gone: reason=${details.reason} exitCode=${details.exitCode}`)
      })
    }

    // AFTER the content view — see createContentView().
    this.win.contentView.addChildView(this.panelView)
    this.win.contentView.addChildView(this.statusView)
    this.win.contentView.addChildView(this.sidebarView)

    if (!this.resizeBound) {
      this.win.on('resize', () => this.layout())
      this.resizeBound = true
    }

    this.applyVisibility()
    this.layout()
  }

  /** Recompute every view's bounds. Call after ANY geometry change. */
  layout(): void {
    if (!this.contentView && !this.panelView && !this.statusView && !this.sidebarView) return
    const [width, height] = this.win.getContentSize()

    const rects = computeLayout({
      width,
      height,
      sidebarVisible: this.prefs.sidebarVisible,
      sidebarWidth: this.prefs.sidebarWidth,
      panelVisible: this.prefs.visible,
      panelWidth: this.prefs.width,
      statusVisible: this.prefs.statusVisible,
    })

    this.contentView?.setBounds(rects.content)
    this.panelView?.setBounds(rects.panel)
    this.statusView?.setBounds(rects.statusBar)
    this.sidebarView?.setBounds(rects.sidebar)
  }

  setPanelVisible(visible: boolean): void {
    this.prefs = { ...this.prefs, visible }
    savePanelPrefs({ visible })
    this.applyVisibility()
    this.layout()
  }

  togglePanel(): void {
    this.setPanelVisible(!this.prefs.visible)
  }

  setSidebarVisible(visible: boolean): void {
    this.prefs = { ...this.prefs, sidebarVisible: visible }
    savePanelPrefs({ sidebarVisible: visible })
    this.applyVisibility()
    this.layout()
  }

  toggleSidebar(): void {
    this.setSidebarVisible(!this.prefs.sidebarVisible)
  }

  /** Resize the sidebar (dragged from its right edge inside sidebar.html). */
  setSidebarWidth(width: number): void {
    const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
    if (clamped === this.prefs.sidebarWidth) return
    this.prefs = { ...this.prefs, sidebarWidth: clamped }
    savePanelPrefs({ sidebarWidth: clamped })
    this.layout()
  }

  setStatusVisible(visible: boolean): void {
    this.prefs = { ...this.prefs, statusVisible: visible }
    savePanelPrefs({ statusVisible: visible })
    this.applyVisibility()
    this.layout()
  }

  /** Resize the panel (dragged from its left edge inside panel.html). */
  setPanelWidth(width: number): void {
    const clamped = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)))
    if (clamped === this.prefs.width) return
    this.prefs = { ...this.prefs, width: clamped }
    savePanelPrefs({ width: clamped })
    // No manual "don't eat the whole window" clamp here: computeLayout()
    // already refuses to draw a panel that would leave the page less than
    // CONTENT_MIN_WIDTH. Clamping in both places would just make the drawn
    // width and the stored width disagree.
    this.layout()
  }

  private applyVisibility(): void {
    this.panelView?.setVisible(this.prefs.visible)
    this.statusView?.setVisible(this.prefs.statusVisible)
    this.sidebarView?.setVisible(this.prefs.sidebarVisible)
  }

  /** Tear down views. Call when the window closes. */
  destroy(): void {
    for (const view of [this.contentView, this.panelView, this.statusView, this.sidebarView]) {
      if (!view) continue
      try {
        this.win.contentView.removeChildView(view)
      } catch { /* window already gone */ }
      view.webContents.close()
    }
    this.contentView = null
    this.panelView = null
    this.statusView = null
    this.sidebarView = null
  }
}
