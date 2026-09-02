/**
 * command-preload.ts — bridge for the Ctrl+K command palette.
 *
 * STAYS SANDBOXED, SAME REASONING AS settings-preload.ts: the palette is the
 * surface a user opens when they have lost track of the UI, so it must depend
 * on nothing but 'electron'. The command list is main-process data (built by
 * command-registry.ts and filtered by command-model.ts on the main side); the
 * renderer only ever sees {id, title, hint} rows and sends ids back.
 *
 * Channels are namespaced `palette:*` like every other overlay's.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshPalette', {
  /** Filtered, ranked commands for a query string ('' = full list). */
  query: (q: string): Promise<unknown> => ipcRenderer.invoke('palette:query', q),

  /** Run a command by id. The main process hides the palette on success. */
  run: (id: string): Promise<unknown> => ipcRenderer.invoke('palette:run', id),

  /** Ask the main process to hide the window (Escape / selection). */
  hide: (): void => ipcRenderer.send('palette:hide'),
})
