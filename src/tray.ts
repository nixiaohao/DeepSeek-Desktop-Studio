/**
 * System tray — minimal: tooltip shows version, double-click shows window.
 */
import { Tray, Menu, nativeImage } from 'electron'
import type { Launcher } from './launcher.js'
import { loadPackagedIcon } from './icons.js'

let tray: Tray | null = null

export function createTray(
  win: Electron.BrowserWindow,
  launcher: Launcher,
  onQuit: () => void,
) {
  // Decoded from a buffer, not a path: `assets/` lives inside app.asar, which
  // native icon loading cannot read (see src/icons.ts). A path-based load
  // returns an empty image here too, and the tray then shows a blank icon.
  let icon: Electron.NativeImage = loadPackagedIcon()
  if (icon.isEmpty()) {
    console.warn('Tray icon could not be decoded from assets/')
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip(`DeepSeek Studio ${launcher.version}`)

  // Minimal context menu: only quit
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '退出 DeepSeek Studio',
      click: () => {
        onQuit()
      },
    },
  ]))

  // Double-click → show window
  tray.on('double-click', () => {
    win.show()
    win.focus()
  })
}

export function destroyTray() {
  tray?.destroy()
  tray = null
}
