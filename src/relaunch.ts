/**
 * relaunch.ts — Cross-platform app restart.
 *
 * The portable build (electron-builder `portable` target) runs from a
 * temp-extracted copy: `process.execPath` points at
 * `%TEMP%\<uuid>\...\DeepSeek Studio.exe` and the outer stub deletes that
 * directory as soon as we exit. A bare `app.relaunch()` would relaunch that
 * temp path, which no longer exists → the app closes and never comes back.
 *
 * The portable stub exposes the original exe path via the
 * PORTABLE_EXECUTABLE_FILE environment variable, so we spawn that stub (a
 * fresh copy) and then exit. Non-portable installs keep using app.relaunch().
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export function relaunchApp(): void {
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE?.trim()
  if (portableExe && existsSync(portableExe)) {
    // Spawn the original portable stub; it unpacks a fresh temp copy and
    // starts the app again. Detached + unref so it survives our exit.
    spawn(portableExe, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
  } else {
    app.relaunch()
  }
  app.exit(0)
}
