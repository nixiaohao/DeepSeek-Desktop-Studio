/**
 * settings-window.ts — the standalone settings window.
 *
 * WHY ITS OWN WINDOW, NOT A PANEL TAB
 * ------------------------------------
 * The settings edit things that determine whether the panels can be seen at
 * all (their visibility) and how large they are (the font scale). A tab inside
 * the panel would be a control surface that can switch itself off — toggle the
 * panel off from inside it and the tab disappears under the user's cursor.
 *
 * WHY IT SHARES NOTHING WITH THE OVERLAYS
 * ----------------------------------------
 * It is the place a user goes when something is misconfigured, so it must be
 * among the last windows that can fail. Its preload is sandboxed and requires
 * only 'electron' (see settings-preload.ts), and every list it renders arrives
 * over IPC from the main process.
 *
 * ONE WINDOW, EVER. Same reasoning as the diagnostics window: two settings
 * windows would let a user compare two copies of the same form and think the
 * app is not saving.
 */
import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { loadPanelPrefs } from './preferences.js'
import { uiScaleCss } from './ui-scale.js'

let win: BrowserWindow | null = null

/**
 * Open (or focus) the settings window.
 *
 * @param onSaved called after a successful save with whether the change needs
 *   an app restart, so the caller can prompt for it. Wired from main.ts: the
 *   relaunch is app-level, and a window module reaching for it directly would
 *   put the most disruptive action in the app behind the least visible API.
 */
export function openSettingsWindow(
  onSaved?: (restartRequired: boolean) => void
): BrowserWindow | null {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
    return win
  }

  try {
    win = new BrowserWindow({
      title: '设置',
      width: 760,
      height: 720,
      minWidth: 560,
      minHeight: 480,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, 'settings-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Deliberately NOT false. See settings-preload.ts: this window edits
        // the configuration, so it must not depend on loading project modules
        // that a bad configuration could have broken.
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

  // Match the panel font size the user chose. This page is entirely ours, but
  // it would look broken next to enlarged panels otherwise — and the font
  // scale is one of the settings being edited here, so it has to track live.
  const css = uiScaleCss(loadPanelPrefs().uiScale)
  const applyScale = (): void => {
    if (!win || win.isDestroyed()) return
    void win.webContents.insertCSS(css).catch(() => {})
  }
  win.webContents.on('did-finish-load', applyScale)
  applyScale()

  // The save happens in the IPC layer, which has no other way to reach the
  // window's opener.
  setSavedCallback(onSaved ?? null)

  void win.loadFile(join(app.getAppPath(), 'assets', 'settings.html'))
  return win
}

/** Close the window if it is open. Used during app teardown. */
export function closeSettingsWindow(): void {
  if (win && !win.isDestroyed()) win.close()
  win = null
}

// ── Save notification ──
//
// The IPC handler for `settings:save` lives in ipc-registry.ts, which is
// registered long before this module is imported and must not import it back
// (it would pull Electron window management into the IPC layer). A module-level
// callback is the smallest thing that closes the gap.

let savedCallback: ((restartRequired: boolean) => void) | null = null

function setSavedCallback(fn: ((restartRequired: boolean) => void) | null): void {
  savedCallback = fn
}

/** Called by the IPC layer after a successful save. */
export function notifySettingsSaved(restartRequired: boolean): void {
  try {
    savedCallback?.(restartRequired)
  } catch {
    // A failure to prompt must never make the save itself look like it failed.
  }
}

/** Re-read the prefs and re-inject the font scale (after a live change). */
export function refreshSettingsWindow(): void {
  if (!win || win.isDestroyed()) return
  void win.webContents.insertCSS(uiScaleCss(loadPanelPrefs().uiScale)).catch(() => {})
}
