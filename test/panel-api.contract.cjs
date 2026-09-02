/**
 * Contract tests for the overlay panel API surface.
 *
 * These are STATIC checks (they read the sources rather than run them), and
 * they guard two failure modes that both actually bit during development:
 *
 *  1. assets/*.html calling `api.<method>()` that the preload never exposes.
 *     The panel and status bar are plain HTML files: no build step, no type
 *     checking, and no devtools in a packaged app. A typo is completely
 *     silent — the button just sits there and does nothing.
 *
 *  2. The preload invoking a `panel:*` channel that ipc-registry.ts never
 *     registered. That throws at call time, again only for the user.
 *
 * Neither is visible to tsc: the HTML is not part of the TS program, and the
 * channel names are string literals that TS cannot correlate across files.
 *
 * Run with: npm test
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

const preloadSrc = read(path.join('src', 'panel-preload.ts'))
const registrySrc = read(path.join('src', 'ipc-registry.ts'))
const HTML_ASSETS = [path.join('assets', 'panel.html'), path.join('assets', 'statusbar.html')]

/**
 * Every overlay bridge in the app.
 *
 * Added as a table rather than as a second copy of the checks below: the
 * sidebar has its own preload and its own page, and the failure modes it is
 * exposed to are identical (a typo'd method name is silent, an unregistered
 * channel throws only for the user). A hand-written second copy would
 * inevitably drift.
 */
/**
 * `minMethods` is per-bridge rather than one global floor.
 *
 * The floor exists to catch a preload whose shape changed so badly the brace
 * matcher found nothing. The diagnostics bridge sits BELOW the others on
 * purpose: it is three methods because it must require nothing but 'electron'
 * to stay sandboxed, and growing it back toward five would mean a local
 * require — which is the failure mode the diagnostics window exists to report.
 * A single global floor would either be wrong for it or useless for the others.
 */
const BRIDGES = [
  {
    name: 'panel',
    preload: 'panel-preload.ts',
    world: 'dshPanel',
    ns: 'panel:',
    html: HTML_ASSETS,
    minMethods: 5,
  },
  {
    name: 'sidebar',
    preload: 'sidebar-preload.ts',
    world: 'dshSidebar',
    ns: 'sidebar:',
    html: [path.join('assets', 'sidebar.html')],
    minMethods: 5,
  },
  // The self-check window gets the SAME treatment as the overlays, not an
  // exemption: it is the one surface a user opens when everything else looks
  // broken, so an unregistered channel here would fail silently at exactly the
  // wrong moment.
  {
    name: 'diagnostics',
    preload: 'diagnostics-preload.ts',
    world: 'dshDiag',
    ns: 'diag:',
    html: [path.join('assets', 'diagnostics.html')],
    minMethods: 3,
  },
  // The settings window, for the same reason as diagnostics: it is where a
  // user goes when something is misconfigured, so an unregistered channel
  // would fail silently at the one moment they have nowhere else to turn.
  // Its floor is the highest of the sandboxed pair simply because it has the
  // most surface — read, save, browse, test, reveal, describe, relaunch.
  {
    name: 'settings',
    preload: 'settings-preload.ts',
    world: 'dshSettings',
    ns: 'settings:',
    html: [path.join('assets', 'settings.html')],
    minMethods: 6,
  },
]

/**
 * Every page the app loads, deduped.
 *
 * The CSP check used to walk `HTML_ASSETS` alone, which was the panel/statusbar
 * pair from before the sidebar existed. The sidebar and diagnostics pages were
 * therefore never checked against their own policy: a page could ship with
 * `script-src 'self'` and an inline script and no test would notice, and the
 * symptom is a page that renders and does nothing.
 */
const ALL_PAGES = [...new Set(BRIDGES.flatMap((b) => b.html))]

let pass = 0
let fail = 0
function ok(label) {
  pass++
  console.log(`  PASS  ${label}`)
}
function bad(label, detail) {
  fail++
  console.log(`  FAIL  ${label}\n        ${detail}`)
}
function assert(cond, label, detail) {
  if (cond) ok(label)
  else bad(label, detail)
}

// ── 1. Bridge methods used by the HTML must exist ──

/**
 * Property names exposed on a bridge (`window.dshPanel`, `window.dshSidebar`).
 *
 * The object body is located by brace matching rather than by regexping the
 * whole file, so nested object literals cannot truncate it and comments
 * elsewhere in the file cannot contribute false keys.
 */
function exposedMethods(src, world) {
  const start = src.indexOf(`exposeInMainWorld('${world}'`)
  if (start < 0) throw new Error(`${world} bridge not found in the preload source`)
  const open = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error(`unbalanced braces inside the ${world} bridge`)

  const body = src.slice(open + 1, end)
  const methods = new Set()
  // Top-level keys only: they are the ones indented by exactly two spaces.
  const re = /^ {2}([A-Za-z_$][\w$]*)\s*:/gm
  let m
  while ((m = re.exec(body)) !== null) methods.add(m[1])
  return methods
}

/** `api.<name>(` call sites in a page. */
function usedMethods(html) {
  const used = new Set()
  const re = /\bapi\.([A-Za-z_$][\w$]*)\s*\(/g
  let m
  while ((m = re.exec(html)) !== null) used.add(m[1])
  return used
}

function channelsInvoked(src) {
  return new Set([...src.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
}
function channelsListened(src) {
  return new Set([...src.matchAll(/ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
}
/**
 * Fire-and-forget renderer→main sends.
 *
 * These used to be invisible to this contract, which is exactly how a new
 * channel (`panel:view-ready`) could be added with nothing checking that the
 * main process ever listens for it. A send with no `ipcMain.on` fails silently
 * and is the worst possible way for a diagnostics feature to break.
 */
function channelsSent(src) {
  return new Set([...src.matchAll(/ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
}
function channelsHandled(src) {
  return new Set([...src.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
}
function channelsOnRegistered(src) {
  return new Set([...src.matchAll(/ipcMain\.on\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
}

const handled = channelsHandled(registrySrc)
const listening = channelsOnRegistered(registrySrc)
/** Every `*:` channel the registry registers, grouped by namespace. */
const handledByNs = new Map()
for (const ch of handled) {
  const ns = ch.slice(0, ch.indexOf(':') + 1)
  if (!handledByNs.has(ns)) handledByNs.set(ns, new Set())
  handledByNs.get(ns).add(ch)
}
/** Same grouping for `ipcMain.on`, so sends can be checked the same way. */
const listeningByNs = new Map()
for (const ch of listening) {
  const ns = ch.slice(0, ch.indexOf(':') + 1)
  if (!listeningByNs.has(ns)) listeningByNs.set(ns, new Set())
  listeningByNs.get(ns).add(ch)
}

console.log('panel-api: bridge surface')

for (const bridge of BRIDGES) {
  const src = read(path.join('src', bridge.preload))
  const exposed = exposedMethods(src, bridge.world)

  assert(
    exposed.size >= bridge.minMethods,
    `${bridge.name}: bridge exposes ${exposed.size} methods`,
    `${bridge.name} bridge exposes only ${exposed.size}, expected at least ${bridge.minMethods} — did ${bridge.preload} change shape?`
  )

  for (const asset of bridge.html) {
    const html = read(asset)
    const used = usedMethods(html)
    assert(
      used.size > 0,
      `${asset} calls the bridge (${used.size} methods)`,
      `${asset} never touches api.* — is the script tag gone?`
    )
    // The page and the preload must also agree on the NAME the bridge is
    // reached through. `usedMethods()` only reads `api.<fn>()` call sites, so a
    // page that read `window.dshSettingsX` — a typo, or a rename that missed
    // one file — still looks perfectly healthy above and fails only at
    // runtime: the page renders, and every control in it does nothing at all.
    //
    // This matches the ASSIGNMENT, not merely the name: these pages quote the
    // bridge name inside their own "preload did not run" error message (see
    // settings.html), so a plain `window.dshSettings\b` test passes on a page
    // whose only remaining mention of the name is a string it prints to the
    // user. Requiring `= window.<name>` is what makes it a binding check.
    assert(
      new RegExp(`=\\s*window\\.${bridge.world}\\s*[;,)]`).test(html),
      `${asset} binds window.${bridge.world}`,
      `${asset} never assigns window.${bridge.world} — that is the name ${bridge.preload} exposes, so every api.* call in the page would hit undefined`
    )

    for (const name of used) {
      assert(
        exposed.has(name),
        `${asset} → api.${name}() is exposed`,
        `${asset} calls api.${name}() but ${bridge.preload} never exposes it`
      )
    }
  }

  // ── 2. Every <ns>:* channel the preload uses must be registered ──

  console.log(`panel-api: channel registration (${bridge.name})`)

  const invoked = channelsInvoked(src)

  for (const ch of invoked) {
    assert(
      ch.startsWith(bridge.ns),
      `${bridge.name}: channel ${ch} is namespaced ${bridge.ns}*`,
      `${ch} must be prefixed ${bridge.ns}* so it cannot collide with another overlay's channels`
    )
    assert(
      handled.has(ch),
      `ipcMain.handle('${ch}') is registered`,
      `${bridge.preload} invokes '${ch}' but ipc-registry.ts has no handler for it`
    )
  }

  // Main→renderer pushes have no ipcMain.handle(); they are sent from
  // broadcast() or a dedicated sender, so all we can check is that the channel
  // string exists in the registry at all.
  for (const ch of channelsListened(src)) {
    assert(
      registrySrc.includes(`'${ch}'`),
      `${bridge.name}: push channel ${ch} appears in the registry`,
      `${bridge.preload} listens on '${ch}' but ipc-registry.ts never sends it`
    )
  }

  // ── 2b. Fire-and-forget sends must have an ipcMain.on ──

  const sent = channelsSent(src)

  for (const ch of sent) {
    assert(
      ch.startsWith(bridge.ns),
      `${bridge.name}: send channel ${ch} is namespaced ${bridge.ns}*`,
      `${ch} must be prefixed ${bridge.ns}* so it cannot collide with another overlay's channels`
    )
    assert(
      listening.has(ch),
      `ipcMain.on('${ch}') is registered`,
      `${bridge.preload} sends '${ch}' but ipc-registry.ts never listens for it — a send with no listener fails silently`
    )
  }

  for (const ch of listeningByNs.get(bridge.ns) ?? []) {
    assert(
      sent.has(ch) || src.includes(`'${ch}'`),
      `${bridge.name}: listener '${ch}' is reachable from the preload`,
      `ipc-registry.ts listens on '${ch}' but ${bridge.preload} never sends it`
    )
  }

  // Guard against the reverse drift: a handler nobody calls is dead code, and
  // it is usually the fingerprint of a rename that only half-landed.
  for (const ch of handledByNs.get(bridge.ns) ?? []) {
    assert(
      invoked.has(ch) || src.includes(`'${ch}'`),
      `${bridge.name}: handler '${ch}' is reachable from the preload`,
      `ipc-registry.ts handles '${ch}' but ${bridge.preload} never uses it`
    )
  }
}

// A channel reaching ACROSS namespaces is the drift the whole scheme exists to
// prevent: the sidebar would break the moment the panel's prefs blob changed.
console.log('panel-api: namespace isolation')
for (const bridge of BRIDGES) {
  const src = read(path.join('src', bridge.preload))
  for (const ch of [...channelsInvoked(src), ...channelsListened(src), ...channelsSent(src)]) {
    if (ch.startsWith(bridge.ns) || !ch.includes(':')) continue
    bad(
      `${bridge.name}: ${ch} stays inside its own namespace`,
      `${bridge.preload} touches '${ch}', which belongs to another overlay — give it a ${bridge.ns}* channel of its own`
    )
  }
}

/** Every channel the preloads touch, so nothing above can be silently skipped. */
const allTouched = new Set()
for (const bridge of BRIDGES) {
  const src = read(path.join('src', bridge.preload))
  for (const ch of channelsInvoked(src)) allTouched.add(ch)
  for (const ch of channelsListened(src)) allTouched.add(ch)
  for (const ch of channelsSent(src)) allTouched.add(ch)
}
assert(allTouched.size >= 15, `contract covers ${allTouched.size} channels`, `only ${allTouched.size} channels were checked — did a preload stop parsing?`)

// ── 3. The CSP must actually permit the inline scripts ──

console.log('panel-api: CSP vs inline scripts')

/**
 * An inline <script> under `script-src 'self'` is dropped by Chromium with no
 * user-visible error: the page renders, the buttons look fine, and nothing
 * works. That was the state of both overlays when this check was written.
 *
 * External .js files were considered instead of 'unsafe-inline', but 'self'
 * matching for sibling file:// URLs is not dependable, and a script that fails
 * to load fails identically silently. `default-src 'none'` still blocks every
 * remote load, so the exposure here is limited to code that ships with the app.
 */
for (const asset of ALL_PAGES) {
  const html = read(asset)
  // Two passes, not one character class: the content itself contains single
  // quotes ('none'), so a ["']-delimited capture stops at the first directive.
  const csp =
    /<meta[^>]+Content-Security-Policy[^>]+content="([^"]*)"/i.exec(html) ||
    /<meta[^>]+Content-Security-Policy[^>]+content='([^']*)'/i.exec(html)
  if (!csp) {
    bad(`${asset} declares a CSP`, 'no Content-Security-Policy meta tag found')
    continue
  }
  const directives = csp[1]
  const inlineScript = /<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/i.test(html)
  const scriptSrc = /script-src\s+([^;]+)/.exec(directives)

  if (inlineScript) {
    assert(
      scriptSrc !== null && /'unsafe-inline'|'nonce-|'sha256-|'sha384-|'sha512-/.test(scriptSrc[1]),
      `${asset}: CSP allows its inline script`,
      `${asset} has an inline <script> but script-src is "${scriptSrc ? scriptSrc[1].trim() : 'absent'}" — Chromium will drop the script and the page will be inert`
    )
  } else {
    ok(`${asset} has no inline script (CSP need not allow one)`)
  }

  // The point of the policy: nothing may be fetched from anywhere.
  assert(
    /default-src\s+'none'/.test(directives),
    `${asset}: default-src is 'none'`,
    `${asset} should default-deny every remote load; got "${directives}"`
  )
}

// ── 3b. Resizer visibility (panel + sidebar) ──────────────────────────

/**
 * The drag handle between an overlay and the dsh page is a 6px strip, and
 * most of that is invisible — it is the 2px on the seam side that has to be
 * visible enough for the user to register "there is a boundary here, and it
 * is draggable". A 1px var(--border) line is 24/255 brighter than the
 * background (9% contrast) and the user reads it as a dead gap, not a
 * handle — the file panel then looks like it floats in space. Anything less
 * than 2px of a high-contrast colour, or no box-shadow, fails this contract.
 *
 * statusbar.html / diagnostics.html do not have a resizer and are skipped.
 */
console.log('panel-api: resizer visibility')

const RESIZER_PAGES = [path.join('assets', 'panel.html'), path.join('assets', 'sidebar.html')]

for (const asset of RESIZER_PAGES) {
  const html = read(asset)
  // Match the #resizer { ... } block. `[\s\S]` instead of `.` so newlines match.
  const resizerBlock = /#resizer\s*\{([^}]*)\}/m.exec(html)
  assert(
    resizerBlock !== null,
    `${asset}: declares a #resizer block`,
    `${asset} must define a #resizer; without it the user cannot tell the overlay is draggable`
  )
  if (!resizerBlock) continue
  const body = resizerBlock[1]
  // The seam colour: must be a high-contrast token (fg-dim / fg / accent) and
  // not the low-contrast border token alone.
  const usesHighContrast = /var\(--fg-dim\)|var\(--fg\)|var\(--accent\)|#[89a-f0-9]{3,8}/i.test(body)
  assert(
    usesHighContrast,
    `${asset}: #resizer uses a high-contrast colour`,
    `${asset} #resizer only references low-contrast tokens — the seam will be invisible on the dsh dark background`
  )
  // A 1px line on a dark background disappears; 2px is the floor.
  // Rather than parse the linear-gradient (whose stops contain var(...) calls
  // with their own commas, making a naive split unsafe), assert the contract
  // by shape: the background must be a linear-gradient with a stop pair that
  // leaves ≥2px of solid colour at the seam. A solid background also
  // satisfies the contract (all of it is visible) but is rejected below for
  // the hover/fill reason — a solid background cannot also be var(--accent)
  // on hover without an extra declaration, and the seam must read as
  // "boundary, not block".
  const isGradient = /background\s*:\s*linear-gradient\(/i.test(body)
  const isSolid = /background\s*:\s*var\(--fg-dim\)|var\(--accent\)|var\(--fg\)|background-color\s*:/i.test(body)
  // For gradients: walk the text and find the LAST transparent boundary and
  // the LAST opaque boundary. The visible strip is the gap between them.
  // "transparent 0" is valid CSS (unit defaults to px), so the unit is
  // optional; opaque stops are always written with px in this codebase.
  let widthOk = false
  if (isGradient) {
    const transparentStops = [...body.matchAll(/transparent\s+(\d+(?:\.\d+)?)(?:px)?/gi)].map((mm) => Number(mm[1]))
    const opaqueStops = [...body.matchAll(/(?:var\(--fg-dim\)|var\(--accent\)|var\(--fg\))\s+(\d+(?:\.\d+)?)px/gi)].map((mm) => Number(mm[1]))
    if (transparentStops.length > 0 && opaqueStops.length > 0) {
      // The opaque strip starts at max(transparentStops) and ends at
      // max(opaqueStops). For a left-to-right seam the visible width is the
      // distance from the last transparent boundary to the LAST opaque stop
      // (the resizer's right edge in the current CSS).
      const lastTransparent = transparentStops[transparentStops.length - 1]
      const lastOpaque = opaqueStops[opaqueStops.length - 1]
      const visible = lastOpaque - lastTransparent
      widthOk = visible >= 2
    }
  } else if (isSolid) {
    widthOk = true
  }
  assert(
    widthOk,
    `${asset}: #resizer draws ≥2px of visible colour at the seam`,
    `${asset} #resizer draws <2px at the seam — too thin to read on the dsh dark background (1px var(--border) was the original bug)`
  )
  // Hover/drag: must upgrade to accent, not stay at the seam colour.
  const hoverBlock = /#resizer:hover[^{]*\{([^}]*)\}/i.exec(html)
  const hoverUsesAccent = hoverBlock && /var\(--accent\)/.test(hoverBlock[1])
  assert(
    hoverUsesAccent,
    `${asset}: #resizer hover/drag fills with var(--accent)`,
    `${asset} #resizer hover/drag block is missing or does not use var(--accent); the user gets no feedback on grab`
  )
}

// ── 3c. Panel type scale ──

/**
 * The user reported the shell's own surfaces as too small to read (10–11px
 * body text). Every one of these pages now derives its font sizes from four
 * `--fs-*` tokens, so the size can be changed globally by overriding a single
 * variable (`--fs-scale`) from the main process — see src/ui-scale.ts.
 *
 * A hard-coded px font-size in any of them is a REGRESSION, not a style
 * choice: it silently drops out of the global scaling, so the user's menu
 * selection would resize most of the text while that one rule stays put.
 *
 * This page list is explicit rather than derived from BRIDGES: diagnostics.html
 * has its own preload and no dshPanel bridge, so it is not in ALL_PAGES, but it
 * shares the type scale and must obey the same rule.
 */
/**
 * Flat `{ selector { body } }` pairs from a stylesheet.
 *
 * Nested at-rules (@media, @keyframes) would need a real parser; none of the
 * pages under test use one, and the flat scan is what keeps the check below
 * readable. If a page ever grows an @media block, extend this rather than
 * weakening the assertion.
 */
function cssRules(css) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css)) !== null) out.push({ selector: m[1], body: m[2] })
  return out
}

console.log('panel-api: panel type scale')

const TYPE_SCALE_PAGES = [
  path.join('assets', 'panel.html'),
  path.join('assets', 'sidebar.html'),
  path.join('assets', 'statusbar.html'),
  path.join('assets', 'diagnostics.html'),
  path.join('assets', 'settings.html'),
]

for (const asset of TYPE_SCALE_PAGES) {
  const html = read(asset)
  // Strip comments first: these files carry long prose that quotes the very
  // declarations under test (e.g. "the old 11px"), which would otherwise read
  // as a hard-coded font size.
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)
  assert(style !== null, `${asset} has a <style> block`, `${asset} has no inline <style> — the type scale cannot live anywhere else`)
  if (!style) continue
  const css = style[1].replace(/\/\*[\s\S]*?\*\//g, '')

  assert(
    /--fs-scale:\s*1\s*;/.test(css),
    `${asset}: :root declares the --fs-scale default`,
    `${asset} does not declare --fs-scale: 1 — the main process's override (ui-scale.ts) would be the only declaration, and a page without a fallback renders unscaled`
  )
  // The scale is only useful if the tokens are actually expressed in terms of
  // it; a plain `--fs-md: 13px` would look identical and be unscalable.
  for (const token of ['--fs-base', '--fs-md']) {
    const decl = new RegExp(`${token}:\\s*calc\\(([0-9.]+)px\\s*\\*\\s*var\\(--fs-scale\\)\\)`).exec(css)
    assert(
      decl !== null,
      `${asset}: ${token} is a calc() multiple of --fs-scale`,
      `${asset} defines ${token} without var(--fs-scale) — the font-size menu would not affect it`
    )
    if (!decl) continue
    assert(
      Number(decl[1]) >= 12,
      `${asset}: ${token} baseline is at least 12px`,
      `${asset} ${token} baseline is ${decl[1]}px — the reported problem was 10–11px text; do not go back below 12`
    )
  }

  // No hard-coded font sizes anywhere in the stylesheet.
  const hardCoded = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[1])
  assert(
    hardCoded.length === 0,
    `${asset}: no hard-coded px font-size`,
    `${asset} has hard-coded font-size ${hardCoded.join(', ')}px — it would ignore the 面板字号 setting`
  )
  // The `font:` shorthand bakes a size in too, and it was how the old 12px
  // body text was written before this change.
  const shorthand = [...css.matchAll(/font:\s*(?:[0-9.]+px|var\(--font\))/g)].map((m) => m[0])
  assert(
    shorthand.length === 0,
    `${asset}: no px-bearing font shorthand`,
    `${asset} uses the font shorthand (${shorthand.join(', ')}) — split into font-family/font-size/line-height so it scales`
  )

  // ── Form controls need the token spelled out for them ──
  //
  // Chromium does not inherit font-family/font-size from <body> into
  // <button>/<input>/<select>/<textarea>: an unstyled control falls back to the
  // browser default (~11px), which is the very "too small to read" report the
  // type scale exists to fix. Declaring the tokens on body is not enough —
  // every control has to restate them.
  //
  // Presence is detected through createElement()/el() as well as through
  // literal markup, because the settings page builds its whole form in script.
  const markup = html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  for (const tag of ['button', 'select', 'textarea', 'input']) {
    const built = new RegExp(`createElement\\(\\s*['"]${tag}['"]|el\\(\\s*['"]${tag}['"]`, 'i')
    let needed = built.test(markup) || new RegExp(`<${tag}\\b`, 'i').test(markup)
    if (tag === 'input' && needed && !built.test(markup)) {
      // A bare checkbox/radio paints no text, so it does not need a size.
      // Inputs the script builds are of unknown type, so they stay required.
      const inputs = [...markup.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0])
      needed = inputs.some((t) => !/type\s*=\s*["']?(checkbox|radio)/i.test(t))
    }
    if (!needed) continue
    const covered = cssRules(css).some(
      (r) => new RegExp(`\\b${tag}\\b`).test(r.selector) && /font-size:\s*var\(--fs-/.test(r.body)
    )
    assert(
      covered,
      `${asset}: <${tag}> takes its font-size from an --fs-* token`,
      `${asset} builds <${tag}> but no rule gives it a font-size from the type scale — Chromium form controls do not inherit body font, so it renders at the browser default (~11px)`
    )
  }
}

// ── 4. Every inline script must actually parse ──

console.log('panel-api: inline script syntax')

/**
 * The overlay pages are hand-written HTML with inline <script> blocks: no build
 * step, no tsc, no lint, and no devtools in a packaged app. A stray brace means
 * Chromium drops the whole block and the page renders as an inert shell —
 * indistinguishable, from the user's side, from the preload failing.
 *
 * Comments are stripped first: these files carry long explanatory comments that
 * quote the words `<script` and `unsafe-inline`, and matching those would both
 * parse prose as JavaScript and swallow the real script tag.
 */
const vm = require('node:vm')

for (const asset of ALL_PAGES) {
  const stripped = read(asset).replace(/<!--[\s\S]*?-->/g, '')
  const blocks = [...stripped.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  assert(blocks.length > 0, `${asset} has an inline script to check`, `${asset} has no inline <script> — did a refactor move the code out and leave the page dead?`)
  blocks.forEach((block, i) => {
    try {
      new vm.Script(block[1], { filename: `${asset}#${i}` })
      ok(`${asset} script #${i} parses`)
    } catch (err) {
      bad(`${asset} script #${i} parses`, `${err.name}: ${err.message}`)
    }
  })
}

// ── 5. Every health phase must have a Chinese label ──

console.log('panel-api: health phase labels')

// The status bar renders PHASE_LABEL[phase] ?? phase, so a missing label
// silently degrades to showing a raw English id in the UI.
const { PHASE_LABEL } = require(path.join(ROOT, 'lib-new', 'health-monitor.js'))

// Kept in sync with the HealthPhase union in src/health-monitor.ts. Adding a
// phase without adding it here is exactly the drift this catches.
const PHASES = ['starting', 'ready', 'idle', 'degraded', 'exited', 'error']
for (const phase of PHASES) {
  const label = PHASE_LABEL[phase]
  assert(typeof label === 'string' && label.length > 0, `phase '${phase}' has a label`, `PHASE_LABEL['${phase}'] is missing — the status bar would show the raw id`)
}

const extra = Object.keys(PHASE_LABEL).filter((k) => !PHASES.includes(k))
assert(extra.length === 0, 'no stale labels', `PHASE_LABEL has labels for unknown phases: ${extra.join(', ')}`)

console.log(`\npanel-api: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
