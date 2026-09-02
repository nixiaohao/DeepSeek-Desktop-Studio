/**
 * window-manager.ts — overlay panel + status bar on the main window.
 *
 * WHY OVERLAY VIEWS INSTEAD OF TOUCHING THE PAGE
 * ----------------------------------------------
 * The main window shows the dsh web UI, which is NOT our asset: it is a
 * localhost page owned by the harness, rebuilt on every upstream update.
 * Injecting DOM or depending on its selectors would break constantly.
 *
 * So the panel and status bar are separate `WebContentsView`s composited by
 * Electron, loaded from our own assets/ HTML. They know nothing about dsh and
 * dsh knows nothing about them.
 *
 * THE ONE CAVEAT (measured, not assumed)
 * --------------------------------------
 * A BrowserWindow's own webContents is NOT part of contentView.children — it
 * cannot be resized or repositioned (verified with a probe on Electron
 * 33.4.11). Overlays therefore COVER the page rather than shrinking it.
 *
 * Mitigation: we inject padding CSS into the page so its content reflows out
 * from under the overlay. If that ever misbehaves for a particular dsh build
 * the user can turn it off (panel.avoidCss) and get plain overlay behaviour.
 *
 * Also note: child view bounds are absolute and are NOT auto-updated on window
 * resize, so every geometry change must go through layout().
 */
import { app, BrowserWindow, WebContentsView } from 'electron'
import { join } from 'node:path'
import { loadPanelPrefs, savePanelPrefs, type PanelPrefs } from './preferences.js'
import { log } from './logging.js'
import type { ViewState } from './diagnostics.js'

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

/** Height of the bottom status bar, px. */
export const STATUS_BAR_HEIGHT = 26
/** Draggable width limits for the right panel, px. */
export const PANEL_MIN_WIDTH = 240
export const PANEL_MAX_WIDTH = 720
/** Draggable width limits for the left file/git sidebar, px. */
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 560

export class WindowManager {
  private readonly win: BrowserWindow
  private panelView: WebContentsView | null = null
  private statusView: WebContentsView | null = null
  private sidebarView: WebContentsView | null = null
  private prefs: PanelPrefs
  private avoidCssKey: string | null = null
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

  /** The main window the overlays are attached to. */
  get window(): BrowserWindow {
    return this.win
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

    this.win.contentView.addChildView(this.panelView)
    this.win.contentView.addChildView(this.statusView)
    this.win.contentView.addChildView(this.sidebarView)

    // Re-inject the avoidance padding after every navigation: Electron drops
    // inserted CSS when the page reloads.
    this.win.webContents.on('did-finish-load', () => {
      void this.refreshAvoidance()
    })

    if (!this.resizeBound) {
      this.win.on('resize', () => this.layout())
      this.resizeBound = true
    }

    this.applyVisibility()
    this.layout()
    void this.refreshAvoidance()
  }

  /** Recompute every overlay's bounds. Call after ANY geometry change. */
  layout(): void {
    if (!this.panelView && !this.statusView && !this.sidebarView) return
    const [cw, ch] = this.win.getContentSize()
    const bar = this.prefs.statusVisible ? STATUS_BAR_HEIGHT : 0

    if (this.statusView) {
      this.statusView.setBounds({ x: 0, y: ch - STATUS_BAR_HEIGHT, width: cw, height: STATUS_BAR_HEIGHT })
    }
    if (this.panelView) {
      this.panelView.setBounds({
        x: Math.max(0, cw - this.prefs.width),
        y: 0,
        width: this.prefs.width,
        height: Math.max(0, ch - bar),
      })
    }
    if (this.sidebarView) {
      // sidebarWidthNow(), not prefs.sidebarWidth: the drawn width is clamped,
      // and the padding injected by refreshAvoidance() has to match what was
      // actually drawn or the page ends up with a gap.
      this.sidebarView.setBounds({
        x: 0,
        y: 0,
        width: this.sidebarWidthNow(),
        height: Math.max(0, ch - bar),
      })
    }
  }

  setPanelVisible(visible: boolean): void {
    this.prefs = { ...this.prefs, visible }
    savePanelPrefs({ visible })
    this.applyVisibility()
    this.layout()
    void this.refreshAvoidance()
  }

  togglePanel(): void {
    this.setPanelVisible(!this.prefs.visible)
  }

  setSidebarVisible(visible: boolean): void {
    this.prefs = { ...this.prefs, sidebarVisible: visible }
    savePanelPrefs({ sidebarVisible: visible })
    this.applyVisibility()
    this.layout()
    void this.refreshAvoidance()
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
    void this.refreshAvoidance()
  }

  setStatusVisible(visible: boolean): void {
    this.prefs = { ...this.prefs, statusVisible: visible }
    savePanelPrefs({ statusVisible: visible })
    this.applyVisibility()
    this.layout()
    void this.refreshAvoidance()
  }

  /**
   * Turn the content-avoidance padding on/off.
   *
   * This is the escape hatch for the one caveat in the file header: if
   * injecting padding ever breaks a particular dsh build's layout, the user
   * can switch to plain overlay behaviour from the menu.
   */
  setAvoidCss(enabled: boolean): void {
    if (this.prefs.avoidCss === enabled) return
    this.prefs = { ...this.prefs, avoidCss: enabled }
    savePanelPrefs({ avoidCss: enabled })
    void this.refreshAvoidance()
  }

  /** Resize the panel (dragged from its left edge inside panel.html). */
  setPanelWidth(width: number): void {
    const clamped = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)))
    if (clamped === this.prefs.width) return
    const [cw] = this.win.getContentSize()
    // Never let the panel eat the whole window.
    const safe = Math.min(clamped, Math.max(PANEL_MIN_WIDTH, cw - 320))
    this.prefs = { ...this.prefs, width: safe }
    savePanelPrefs({ width: safe })
    this.layout()
    void this.refreshAvoidance()
  }

  /**
   * Inject CSS padding so the dsh page reflows out from under the overlays.
   * No-op when disabled or when nothing is shown.
   */
  async refreshAvoidance(): Promise<void> {
    if (!this.prefs.avoidCss) {
      await this.clearAvoidance()
      return
    }
    const left = this.prefs.sidebarVisible ? this.sidebarWidthNow() : 0
    const right = this.prefs.visible ? this.prefs.width : 0
    const bottom = this.prefs.statusVisible ? STATUS_BAR_HEIGHT : 0

    await this.clearAvoidance()
    if (left === 0 && right === 0 && bottom === 0) return

    // `padding-left` is what keeps the dsh page from sliding under the
    // sidebar. It is only correct while the sidebar is actually that wide —
    // see sidebarWidthNow().
    const css =
      `html{padding-left:${left}px!important;padding-right:${right}px!important;padding-bottom:${bottom}px!important;box-sizing:border-box!important;}` +
      `body{padding-left:${left}px!important;padding-right:${right}px!important;padding-bottom:${bottom}px!important;box-sizing:border-box!important;}`
    try {
      this.avoidCssKey = await this.win.webContents.insertCSS(css)
    } catch (err) {
      log('launcher', `panel: CSS avoidance injection failed: ${(err as Error).message}`)
    }
  }

  /** Remove any previously injected avoidance CSS. */
  private async clearAvoidance(): Promise<void> {
    if (this.avoidCssKey === null) return
    const key = this.avoidCssKey
    this.avoidCssKey = null
    try {
      await this.win.webContents.removeInsertedCSS(key)
    } catch {
      // Expected after a navigation: the key no longer exists. Not an error.
    }
  }

  /**
   * The width the sidebar is ACTUALLY drawn at, which is not always the
   * configured one: on a narrow window the sidebar plus the panel would
   * otherwise squeeze the page away to nothing, so the width is clamped at
   * draw time and a minimum of 320px is always left for the page.
   *
   * Single source of truth on purpose. `layout()` uses it to set the bounds and
   * `refreshAvoidance()` uses it to size the padding — when those two
   * disagreed, the page was padded for a sidebar that was never drawn and a
   * dead gap appeared along the left edge.
   */
  private sidebarWidthNow(): number {
    const [cw] = this.win.getContentSize()
    const right = this.prefs.visible ? this.prefs.width : 0
    return Math.min(this.prefs.sidebarWidth, Math.max(SIDEBAR_MIN_WIDTH, cw - right - 320))
  }

  private applyVisibility(): void {
    this.panelView?.setVisible(this.prefs.visible)
    this.statusView?.setVisible(this.prefs.statusVisible)
    this.sidebarView?.setVisible(this.prefs.sidebarVisible)
  }

  /** Tear down views. Call when the window closes. */
  destroy(): void {
    try {
      if (this.panelView) this.win.contentView.removeChildView(this.panelView)
      if (this.statusView) this.win.contentView.removeChildView(this.statusView)
      if (this.sidebarView) this.win.contentView.removeChildView(this.sidebarView)
    } catch { /* window already gone */ }
    this.panelView?.webContents.close()
    this.statusView?.webContents.close()
    this.sidebarView?.webContents.close()
    this.panelView = null
    this.statusView = null
    this.sidebarView = null
  }
}
