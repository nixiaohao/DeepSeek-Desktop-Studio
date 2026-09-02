/**
 * diagnostics-window.ts — the standalone self-check window.
 *
 * WHY A SEPARATE WINDOW AND NOT A PANEL TAB
 * -----------------------------------------
 * A self-check that lives inside the thing being checked cannot report that
 * thing's failure. Both failures this was built for are exactly that shape:
 *
 *   - the panel's preload throws → the panel cannot ask for a report;
 *   - the window never shows     → there is no visible surface to put one on.
 *
 * So the diagnostics view gets its own BrowserWindow, its own HTML and its own
 * preload, sharing nothing with the overlays. The preload requires only
 * 'electron' and therefore runs sandboxed, which is what lets this window still
 * open when the panel's does not.
 *
 * ONE WINDOW, EVER. Opening a second copy would let the user compare two
 * reports taken seconds apart and think the app is flapping; focusing the
 * existing one also costs nothing.
 */
import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'

let win: BrowserWindow | null = null

/**
 * Open (or focus) the self-check window.
 *
 * Returns the window so callers can do something on failure, and null only if
 * Electron refused to create one — in which case there is nothing useful to
 * show the user anyway.
 */
export function openDiagnosticsWindow(): BrowserWindow | null {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
    return win
  }

  try {
    win = new BrowserWindow({
      title: '诊断自检',
      width: 900,
      height: 660,
      minWidth: 620,
      minHeight: 420,
      // No overlay avoidance, no injected CSS: this page is ours from top to
      // bottom, so it needs none of the contortions the dsh web page requires.
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, 'diagnostics-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Deliberately NOT set to false. See the file comment in
        // diagnostics-preload.ts: this preload must survive the failure mode
        // that forced `sandbox: false` on every other overlay.
        sandbox: true,
      },
    })
  } catch {
    win = null
    return null
  }

  win.on('closed', () => {
    win = null
  })

  void win.loadFile(join(app.getAppPath(), 'assets', 'diagnostics.html'))
  return win
}

/** Close the window if it is open. Used during app teardown. */
export function closeDiagnosticsWindow(): void {
  if (win && !win.isDestroyed()) win.close()
  win = null
}
