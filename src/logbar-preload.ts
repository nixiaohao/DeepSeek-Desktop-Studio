/**
 * logbar-preload.ts — bridge for the bottom log panel.
 *
 * Its own preload rather than sharing panel-preload.js, for the same reason
 * the sidebar got one: that file's exposed API is brace-matched by
 * test/panel-api.contract.cjs, so every method added there would have to
 * satisfy the panel's contract too. Separate file, separate contract.
 *
 * The bridge is intentionally THIN: the page never parses log text. The main
 * process merges and shapes the two feeds through src/log-model.ts (unit
 * tested) and sends ready-to-render entries; the page filters by source and
 * draws. A formatting change in logging.ts therefore cannot silently break
 * this panel's view.
 *
 * SANDBOXED, like diagnostics/settings: it requires nothing but 'electron'.
 * Source labels ride into the page via logs:snapshot's `sources` list instead
 * of a local import — one less require, one less way for a broken module to
 * leave the logbar without a bridge.
 *
 * NOTE: the bridge object is the inline literal inside contextBridge's
 * exposeInMainWorld call below (not a separate `const api`), with keys at
 * 2-space indent. test/panel-api.contract.cjs brace-matches this exact form;
 * do not refactor it to a standalone object without updating the test in
 * lock-step. (The comment deliberately avoids quoting the call verbatim — the
 * brace matcher finds the FIRST occurrence of the bridge name, and a quoted
 * example would shadow the real object.)
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/** Remove a listener previously added by `onLines`. */
function off(channel: string, cb: (...args: unknown[]) => void): void {
  ipcRenderer.removeListener(channel, cb as never)
}

contextBridge.exposeInMainWorld('dshLogs', {
  /** One structured batch of log lines (see log-model.ts LogEntry). */
  onLines: (cb: (entries: unknown[]) => void): void => {
    ipcRenderer.on('logs:lines', (_e: IpcRendererEvent, entries) => cb(entries))
  },
  offLines: (cb: (...args: unknown[]) => void): void => off('logs:lines', cb),

  /** Buffered history from both feeds, merged/sorted/capped by the main process. */
  snapshot: (): Promise<{ entries: unknown[]; sources: { id: string; label: string }[] }> =>
    ipcRenderer.invoke('logs:snapshot'),

  /** Reveal the log directory in the OS file manager. */
  revealLogDir: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('logs:reveal-dir'),
})

/**
 * Tell the main process this preload finished and the bridge is live.
 *
 * Placed AFTER `exposeInMainWorld` on purpose, so the ping means "the bridge
 * exists" and not merely "the module started executing" — the diagnostics
 * report turns a MISSING ping into a red row naming the real cause.
 * Wrapped in try/catch: a failed ping must never take the bridge down.
 */
try {
  ipcRenderer.send('logs:view-ready', 'logbar')
} catch {
  /* the diagnostics report will show this view as never-ready */
}
