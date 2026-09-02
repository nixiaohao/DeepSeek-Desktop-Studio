/**
 * settings-preload.ts — bridge for the standalone settings window.
 *
 * STAYS SANDBOXED, SAME REASONING AS diagnostics-preload.ts.
 * ---------------------------------------------------------
 * The settings window is where a user goes to fix a bad configuration, so it
 * has to be among the last things that can break. Requiring a local module
 * here would force `sandbox: false` (a sandboxed preload that requires a
 * project file throws before `exposeInMainWorld` runs), which would re-couple
 * this window to the very modules that might be failing.
 *
 * So this preload requires NOTHING but 'electron'. Concretely that means the
 * page cannot enumerate themes, channels, font steps or editor presets on its
 * own — the main process ships all of them in `settings:read`. That is not a
 * workaround, it is the point: the lists are main-process data, and the window
 * that edits them should not depend on being able to import them.
 *
 * Channels are namespaced `settings:*` like every other overlay's.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshSettings', {
  /** Current settings plus every list the dropdowns need. */
  read: (): Promise<unknown> => ipcRenderer.invoke('settings:read'),

  /**
   * Persist a whole state.
   *
   * Sends the complete state rather than a patch: the page already holds it,
   * and the main process diffs it against what is on disk to decide whether a
   * restart is actually needed. A patch would lose that comparison.
   */
  save: (state: unknown): Promise<{ ok: boolean; error?: string; restartRequired: boolean }> =>
    ipcRenderer.invoke('settings:save', state),

  /** Show the OS file picker for an editor executable. '' when cancelled. */
  browseEditor: (): Promise<string> => ipcRenderer.invoke('settings:browse-editor'),

  /**
   * Open a throwaway probe file with the given (unsaved) configuration.
   *
   * Takes the config as an argument so what gets tested is what is currently
   * in the form, not what happens to be on disk — "test" would otherwise be a
   * lie, and the user would have to save first to find out they typed the
   * wrong path.
   */
  testEditor: (config: unknown): Promise<{ ok: boolean; error?: string; usedSystemDefault?: boolean }> =>
    ipcRenderer.invoke('settings:test-editor', config),

  /** Reveal ~/.dsh/studio-prefs.json in the OS file manager. */
  revealPrefs: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:reveal-prefs'),

  /** Human-readable editor name for a config, computed in the main process. */
  describeEditor: (config: unknown): Promise<string> =>
    ipcRenderer.invoke('settings:describe-editor', config),

  /**
   * Restart the app, offered after a change that cannot be applied live.
   *
   * Goes through the main process rather than `app.relaunch()` in the page
   * (which the sandbox forbids anyway) so the relaunch and the save are
   * ordered by the same code that owns both.
   */
  relaunch: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:relaunch'),
})
