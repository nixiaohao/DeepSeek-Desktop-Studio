/**
 * Preload script — exposes a safe bridge between main process and web page.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshStudio', {
  /** Switch theme by ID */
  switchTheme: (themeId: string) => ipcRenderer.send('switch-theme', themeId),

  /** Get available themes */
  getThemes: () => ipcRenderer.invoke('get-themes'),

  /** Get current version */
  getVersion: () => ipcRenderer.invoke('get-version'),

  /** Minimize window */
  minimize: () => ipcRenderer.send('window-minimize'),

  /** Maximize/restore window */
  maximize: () => ipcRenderer.send('window-maximize'),

  /** Close window */
  close: () => ipcRenderer.send('window-close'),
})
