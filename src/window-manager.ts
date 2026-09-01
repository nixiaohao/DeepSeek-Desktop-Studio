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

/** Height of the bottom status bar, px. */
export const STATUS_BAR_HEIGHT = 26
/** Draggable width limits for the right panel, px. */
export const PANEL_MIN_WIDTH = 240
export const PANEL_MAX_WIDTH = 720

export class WindowManager {
  private readonly win: BrowserWindow
  private panelView: WebContentsView | null = null
  private statusView: WebContentsView | null = null
  private prefs: PanelPrefs
  private avoidCssKey: string | null = null
  private resizeBound = false

  constructor(win: BrowserWindow) {
    this.win = win
    this.prefs = loadPanelPrefs()
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
    const assets = join(app.getAppPath(), 'assets')

    this.panelView = new WebContentsView({
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.panelView.webContents.loadFile(join(assets, 'panel.html'))

    this.statusView = new WebContentsView({
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.statusView.webContents.loadFile(join(assets, 'statusbar.html'))

    this.win.contentView.addChildView(this.panelView)
    this.win.contentView.addChildView(this.statusView)

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
    if (!this.panelView && !this.statusView) return
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
    const right = this.prefs.visible ? this.prefs.width : 0
    const bottom = this.prefs.statusVisible ? STATUS_BAR_HEIGHT : 0

    await this.clearAvoidance()
    if (right === 0 && bottom === 0) return

    const css =
      `html{padding-right:${right}px!important;padding-bottom:${bottom}px!important;box-sizing:border-box!important;}` +
      `body{padding-right:${right}px!important;padding-bottom:${bottom}px!important;box-sizing:border-box!important;}`
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

  private applyVisibility(): void {
    this.panelView?.setVisible(this.prefs.visible)
    this.statusView?.setVisible(this.prefs.statusVisible)
  }

  /** Tear down views. Call when the window closes. */
  destroy(): void {
    try {
      if (this.panelView) this.win.contentView.removeChildView(this.panelView)
      if (this.statusView) this.win.contentView.removeChildView(this.statusView)
    } catch { /* window already gone */ }
    this.panelView?.webContents.close()
    this.statusView?.webContents.close()
    this.panelView = null
    this.statusView = null
  }
}
