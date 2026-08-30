/**
 * icons.ts — load packaged icon assets reliably.
 *
 * `app.getAppPath()` resolves to `.../resources/app.asar`, and native code
 * (Chromium's image decoder, the Win32 tray/window icon loader) cannot read
 * through the asar archive. `nativeImage.createFromPath(<path inside asar>)`
 * therefore produces an EMPTY image instead of failing loudly, and the window
 * silently falls back to whatever icon the executable carries.
 *
 * Reading the bytes in Node — which IS asar-aware — and building the image
 * from a buffer works identically packaged and unpackaged, so this is the only
 * form used for window and tray icons.
 */
import { app, nativeImage, type NativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Asset file name that suits the current platform. */
export function iconFileName(): string {
  return process.platform === 'win32' ? 'icon.ico' : 'icon.png'
}

/**
 * Load `assets/<name>` from the packaged app (or the source tree in dev).
 * @returns the decoded image, or an empty image when the asset is missing or
 *   undecodable — callers must tolerate `isEmpty()`.
 */
export function loadPackagedIcon(name: string = iconFileName()): NativeImage {
  const candidates = [
    join(app.getAppPath(), 'assets', name),
    // Dev fallback: run from `shell/` with the compiled output in lib-new/.
    join(app.getAppPath(), '..', 'assets', name),
  ]
  for (const file of candidates) {
    try {
      const image = nativeImage.createFromBuffer(readFileSync(file))
      if (!image.isEmpty()) return image
    } catch { /* try the next candidate */ }
  }
  return nativeImage.createEmpty()
}
