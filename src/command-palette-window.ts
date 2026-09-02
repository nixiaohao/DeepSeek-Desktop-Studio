/**
 * command-palette-window.ts — the Ctrl+K command palette.
 *
 * WHY ITS OWN WINDOW, NOT A WEBCONTENTSVIEW OVERLAY
 * -------------------------------------------------
 * The three overlays (panel/sidebar/logbar) live inside the main window's
 * geometry, which layout-geometry.ts computes and owns; a palette would add a
 * fourth region to every resize computation, plus z-order and focus-handoff
 * rules, for a surface that is visible only a few seconds at a time. A
 * frameless, skipTaskbar child window pinned over the main window is the
 * settings-window pattern re-used for an overlay shape: no layout coupling,
 * no resizer, no insertCSS lifecycle to maintain.
 *
 * SAME SANDBOX RULE AS SETTINGS/DIAGNOSTICS
 * -----------------------------------------
 * The palette's preload (command-preload.ts) requires nothing but 'electron';
 * the command list arrives over IPC (see command-registry.ts). The palette is
 * the surface a user opens when they have lost track of the UI, so it must not
 * depend on the thing they are trying to find.
 *
 * LIFECYCLE: hidden, not destroyed, between uses (instant reopen), destroyed
 * when the parent window closes; app teardown calls closeCommandPalette().
 */
import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { uiScaleCss } from './ui-scale.js'
import { loadPanelPrefs } from './preferences.js'
import { log } from './logging.js'

let win: BrowserWindow | null = null

/** Late-bound parent lookup; main.ts is the only place that knows the main window. */
let getParent: (() => BrowserWindow | null) | null = null

export function setPaletteParentAccessor(fn: () => BrowserWindow | null): void {
  getParent = fn
}

/**
 * Show (or create) the palette, positioned top-centre over the main window's
 * content area. Recomputed on every open so the palette follows the window
 * even after it was moved or resized while hidden.
 */
export function openCommandPalette(): void {
  try {
    if (win && !win.isDestroyed()) {
      positionOver(win)
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return
    }

    win = new BrowserWindow({
      width: 560,
      height: 400,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      // Child of the main window: stays above it and closes with it.
      parent: getParent?.() ?? undefined,
      webPreferences: {
        preload: join(__dirname, 'command-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    win.on('closed', () => {
      win = null
    })

    // Hide instead of closing on blur — the standard palette behaviour: a
    // click anywhere outside dismisses it, but the next Ctrl+K must be instant.
    win.on('blur', () => {
      if (win && !win.isDestroyed() && win.isVisible()) win.hide()
    })

    // Match the panel font size (same rule as the settings window), re-injected
    // after each load because insertCSS does not survive navigation.
    const applyScale = (): void => {
      if (!win || win.isDestroyed()) return
      void win.webContents.insertCSS(uiScaleCss(loadPanelPrefs().uiScale)).catch(() => {})
    }
    win.webContents.on('did-finish-load', applyScale)

    void win.loadFile(join(app.getAppPath(), 'assets', 'command-palette.html'))
    win.once('ready-to-show', () => {
      // Unlike the main window, the palette's own webContents IS the page
      // (no WebContentsView layering), so ready-to-show is reliable here.
      if (win && !win.isDestroyed()) {
        positionOver(win)
        win.show()
        win.focus()
      }
    })
  } catch (err) {
    log('launcher', `命令面板打开失败：${(err as Error).message}`)
    win = null
  }
}

/** Park the palette top-centre over the parent's CONTENT area. */
function positionOver(palette: BrowserWindow): void {
  const parent = getParent?.() ?? null
  if (!parent || parent.isDestroyed()) return
  try {
    const bounds = parent.getContentBounds()
    const [w] = palette.getSize()
    const x = Math.round(bounds.x + (bounds.width - w) / 2)
    const y = Math.round(bounds.y + 80)
    palette.setPosition(x, y)
  } catch {
    // Best-effort positioning; the window manager default is fine.
  }
}

/** Hide the palette (Escape in the page, or after a command runs). */
export function hideCommandPalette(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide()
}

/** Close and forget the window. Used during app teardown. */
export function closeCommandPalette(): void {
  if (win && !win.isDestroyed()) win.close()
  win = null
}
