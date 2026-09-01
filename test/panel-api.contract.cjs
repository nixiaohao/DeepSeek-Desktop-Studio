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
 * Property names exposed on `window.dshPanel`.
 *
 * The object body is located by brace matching rather than by regexping the
 * whole file, so nested object literals cannot truncate it and comments
 * elsewhere in the file cannot contribute false keys.
 */
function exposedMethods(src) {
  const start = src.indexOf("exposeInMainWorld('dshPanel'")
  if (start < 0) throw new Error('dshPanel bridge not found in src/panel-preload.ts')
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
  if (end < 0) throw new Error('unbalanced braces inside the dshPanel bridge')

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

const exposed = exposedMethods(preloadSrc)

console.log('panel-api: bridge surface')
assert(exposed.size >= 10, `bridge exposes ${exposed.size} methods`, 'bridge looks empty — did the preload change shape?')

for (const asset of HTML_ASSETS) {
  const html = read(asset)
  const used = usedMethods(html)
  assert(used.size > 0, `${asset} calls the bridge (${used.size} methods)`, `${asset} never touches api.* — is the script tag gone?`)
  for (const name of used) {
    assert(exposed.has(name), `${asset} → api.${name}() is exposed`, `${asset} calls api.${name}() but panel-preload.ts never exposes it`)
  }
}

// ── 2. Every panel:* channel the preload uses must be registered ──

console.log('panel-api: channel registration')

function channelsInvoked(src) {
  return new Set([...src.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
}
function channelsListened(src) {
  return new Set([...src.matchAll(/ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
}
function channelsHandled(src) {
  return new Set([...src.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
}

const invoked = channelsInvoked(preloadSrc)
const handled = channelsHandled(registrySrc)

for (const ch of invoked) {
  assert(ch.startsWith('panel:'), `preload channel ${ch} is namespaced`, `${ch} must be prefixed panel:* so it cannot collide with the main preload`)
  assert(handled.has(ch), `ipcMain.handle('${ch}') is registered`, `panel-preload.ts invokes '${ch}' but ipc-registry.ts has no handler for it`)
}

// Main→renderer pushes have no ipcMain.handle(); they are sent from the
// broadcast helper, so all we can check is that the channel string exists in
// the registry at all (usually as a broadcast() argument).
for (const ch of channelsListened(preloadSrc)) {
  assert(registrySrc.includes(`'${ch}'`), `push channel ${ch} appears in the registry`, `panel-preload.ts listens on '${ch}' but ipc-registry.ts never sends it`)
}

// Guard against the reverse drift: a handler nobody calls is dead code, and
// it is usually the fingerprint of a rename that only half-landed.
for (const ch of handled) {
  if (!ch.startsWith('panel:')) continue
  assert(
    invoked.has(ch) || preloadSrc.includes(`'${ch}'`),
    `handler '${ch}' is reachable from the preload`,
    `ipc-registry.ts handles '${ch}' but panel-preload.ts never uses it`
  )
}

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
for (const asset of HTML_ASSETS) {
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

// ── 4. Every health phase must have a Chinese label ──

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
