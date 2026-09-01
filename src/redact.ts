/**
 * redact.ts — scrubbing of the per-process web token from text.
 *
 * Zero dependencies on purpose: this is security-critical and must be unit
 * testable outside Electron (test/redact.unit.cjs).
 *
 * Background: `dsh web` mints a FRESH token on every launch using
 * crypto.randomBytes(32) and keeps it only in an in-memory WeakMap
 * (see packages/client/connection/src/browser-auth.ts upstream). It is
 * therefore not a durable secret embedded in the repo, but it IS a live
 * credential for the local web UI for as long as that process runs.
 *
 * Anything that can be read later by another process — backend.log, the
 * monitor panel, an error dialog a user screenshots for support — must never
 * contain it.
 */

/**
 * Mask the token in free-form text.
 *
 * Covers the two shapes that actually appear in harness output:
 *   - URL query form: `http://127.0.0.1:3080/?token=abc123`
 *   - JSON payloads:  `"token":"abc123"`
 *
 * Exported from logging.ts as well so existing call sites keep working; new
 * code should import it from here.
 */
export function redactTokenInText(text: string): string {
  return text
    .replace(/(token=)[A-Za-z0-9_-]+/gu, '$1***')
    .replace(/("token"\s*:\s*")[A-Za-z0-9_-]+(")/gu, '$1***$2')
}

/**
 * Mask the token inside a URL, keeping the rest readable for logs.
 * Invalid URLs are returned untouched (a malformed URL cannot leak a token
 * we understand).
 */
export function redactTokenInUrl(url: string): string {
  return url.replace(/(token=)[A-Za-z0-9_-]+/gu, '$1***')
}
