/**
 * System tray — minimal: tooltip shows version, double-click shows window.
 */
import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'node:path'
import type { Launcher } from './launcher.js'

let tray: Tray | null = null

export function createTray(
  win: Electron.BrowserWindow,
  launcher: Launcher,
  onQuit: () => void,
) {
  // Use app.getAppPath() for reliable path resolution in both dev and packaged modes
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const iconPath = join(app.getAppPath(), 'assets', iconFile)
  let icon: Electron.NativeImage
  try {
    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      console.warn(`Tray icon is empty at: ${iconPath}`)
      icon = nativeImage.createEmpty()
    }
  } catch (err) {
    console.warn(`Failed to load tray icon: ${err}`)
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
