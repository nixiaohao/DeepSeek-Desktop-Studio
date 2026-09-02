/**
 * ui-scale.ts — the one piece of CSS that re-scales a shell page's type.
 *
 * Every shell page (panel / sidebar / statusbar / diagnostics) derives its font
 * sizes from `--fs-scale` (see the :root block in panel.html). Overriding that
 * single variable resizes the whole surface, which is why the scaling knob is a
 * CSS injection and NOT `WebContents.setZoomFactor`: zoom scales the page's own
 * layout, so at 1.3 the drag handles, the fixed-height headers and every px-typed
 * padding would grow too and stop matching the window geometry we compute in
 * layout-geometry.ts. Font-only scaling leaves the geometry alone.
 *
 * Deliberately dependency-free (no electron, no fs) so it can be unit-tested in
 * plain node — the string it produces is injected into four different pages and
 * a malformed value there is silently swallowed by Chromium.
 */
import { normalizeUiScale } from './preferences.js'

/**
 * The CSS injected into each shell page.
 *
 * `!important` is required: the pages define `--fs-scale: 1` in their own
 * `:root` block, and an injected rule without it loses the cascade to that
 * author-level declaration on some Chromium builds — the page then renders at
 * the default size while the menu shows the user's choice as active, which
 * looks like the setting is broken.
 *
 * The value is passed through normalizeUiScale rather than trusted: a
 * hand-edited prefs file could otherwise put `--fs-scale: 0` or `NaN` on the
 * page, and either renders every panel as blank text — indistinguishable from
 * a crash from where the user is sitting.
 */
export function uiScaleCss(scale: unknown): string {
  return `:root { --fs-scale: ${normalizeUiScale(scale)} !important; }`
}
