/**
 * Import-time smoke test for the main-process modules.
 *
 * WHY THIS EXISTS
 * ---------------
 * tsc proves the code is well-typed; it says nothing about whether the modules
 * can actually be loaded. The failures this catches are all runtime-only:
 *
 *   - a `import type` that quietly became a value import, dragging Electron
 *     into a module that is supposed to be dependency-free and untestable;
 *   - a circular require that leaves a binding in TDZ (throws only at load);
 *   - an export that was renamed/removed while another module still imports it.
 *
 * The Electron API is stubbed. `app.whenReady()` deliberately returns a
 * PROMISE THAT NEVER SETTLES, so the launch sequence (workspace resolution,
 * network update check, spawning dsh) never runs — we only want to prove that
 * module evaluation itself is clean.
 *
 * Run with: npm test
 */
const Module = require('node:module')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const LIB = path.join(ROOT, 'lib-new')

let pass = 0
let fail = 0
/** Last text handed to the clipboard stub; see the electron mock below. */
let clipText = ''
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

// ── Fail loudly on a swallowed crash ──
//
// main.js installs an `uncaughtException` handler that only logs (correct for
// the app: a stray async error must not kill the shell). In THIS process that
// is a trap: a throw anywhere below aborts the rest of the file, gets
// swallowed, and Node still exits 0 — every remaining assertion vanishes with
// no red anywhere. That actually happened: adding the `getStream` dependency
// to registerIpc() silently dropped the last 25 assertions.
//
// Listeners run in registration order and this one is registered before
// main.js is required, so it wins and can force a non-zero exit.
process.on('uncaughtException', (err) => {
  bad('uncaught exception aborted the run', err && err.stack ? err.stack : String(err))
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  bad('unhandled rejection', String(reason))
  process.exit(1)
})

// ── Electron stub ──

/** Calls made on the stub, so the test can prove the wiring ran. */
const calls = []

function noop(name) {
  return (...args) => {
    calls.push(name)
    void args
    return undefined
  }
}

/** Channel names main.js / ipc-registry.js register, captured for assertions. */
const ipcChannels = { handle: new Set(), on: new Set(), handlers: new Map() }
/** The last template handed to Menu.buildFromTemplate. */
const menuTemplates = []
/** Flat list of every menu label + accelerator in the last template. */
function flattenLabels(items) {
  const out = []
  for (const it of items) {
    if (it.label) out.push(it.label)
    if (it.accelerator) out.push(it.accelerator)
    if (Array.isArray(it.submenu)) out.push(...flattenLabels(it.submenu))
  }
  return out
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'))

const app = {
  name: 'DeepSeek Studio',
  // Never settles → the launch flow never starts. Recorded so the test can
  // still prove main.js hooked the lifecycle.
  whenReady: () => {
    calls.push('whenReady')
    return new Promise(() => {})
  },
  on: noop('app.on'),
  quit: noop('app.quit'),
  exit: noop('app.exit'),
  getVersion: () => '0.0.0-smoke',
  getAppPath: () => ROOT,
  getPath: (key) => path.join(tmpDir, key),
  setAppUserModelId: noop('setAppUserModelId'),
  disableHardwareAcceleration: noop('disableHardwareAcceleration'),
  requestSingleInstanceLock: () => true,
  commandLine: { appendSwitch: noop('appendSwitch') },
}

class FakeWebContents {
  constructor() {
    this.id = 0
  }
  send = noop('wc.send')
  insertCSS = async () => 'stub-css-key'
  removeInsertedCSS = async () => {}
  loadFile = noop('wc.loadFile')
  loadURL = noop('wc.loadURL')
  on = noop('wc.on')
  once = noop('wc.once')
  isLoading = () => true
  reload = noop('wc.reload')
  openDevTools = noop('wc.openDevTools')
}

class FakeView {
  constructor() {
    this.webContents = new FakeWebContents()
  }
  setBounds = noop('view.setBounds')
  setVisible = noop('view.setVisible')
}

class FakeBrowserWindow extends FakeView {
  static getAllWindows = () => []
  static fromWebContents = () => null
  contentView = { addChildView: noop('addChildView'), removeChildView: noop('removeChildView'), children: [] }
  constructor() {
    super()
    this.id = 1
  }
  loadFile = noop('win.loadFile')
  loadURL = async () => {}
  show = noop('win.show')
  close = noop('win.close')
  on = noop('win.on')
  once = noop('win.once')
  getContentSize = () => [1280, 800]
  getBounds = () => ({ x: 0, y: 0, width: 1280, height: 800 })
  isMaximized = () => false
  setMenu = noop('win.setMenu')
}

const electronStub = {
  app,
  BrowserWindow: FakeBrowserWindow,
  BaseWindow: FakeBrowserWindow,
  WebContentsView: FakeView,
  Menu: {
    buildFromTemplate: (tpl) => {
      menuTemplates.push(tpl)
      return { popup: noop('popup') }
    },
    setApplicationMenu: noop('setApplicationMenu'),
  },
  MenuItem: class {},
  dialog: {
    showMessageBox: async () => ({ response: 0 }),
    showMessageBoxSync: () => 0,
    showErrorBox: noop('showErrorBox'),
    showOpenDialogSync: () => [],
  },
  shell: {
    openPath: async () => '',
    openExternal: async () => {},
    showItemInFolder: noop('showItemInFolder'),
    beep: noop('beep'),
  },
  ipcMain: {
    on: (ch) => {
      ipcChannels.on.add(ch)
    },
    // The handler FUNCTION is kept, not just the name: asserting that a channel
    // is registered says nothing about what it does, and the batch-approval
    // guard below is a safety rule that has to be exercised, not listed.
    handle: (ch, fn) => {
      ipcChannels.handle.add(ch)
      ipcChannels.handlers.set(ch, fn)
    },
    removeHandler: noop('removeHandler'),
  },
  ipcRenderer: { on: noop('ipcRenderer.on'), invoke: async () => null, send: noop('send'), removeListener: noop('removeListener') },
  contextBridge: { exposeInMainWorld: noop('exposeInMainWorld') },
  // Records what was written instead of discarding it, so diag:copy's redaction
  // can be asserted on the ACTUAL text that would reach the OS clipboard.
  clipboard: { writeText: (text) => { clipText = String(text) } },
  nativeImage: { createFromBuffer: () => ({}), createFromPath: () => ({}) },
  Tray: class {
    on = noop('tray.on')
    setToolTip = noop('setToolTip')
    setContextMenu = noop('setContextMenu')
    destroy = noop('tray.destroy')
  },
}

// Install the stub BEFORE anything requires 'electron'.
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.call(this, request, parent, isMain)
}

// ── 1. Every module loads ──

const MODULES = [
  'redact.js',
  'path-links.js',
  'health-monitor.js',
  'highlight.js',
  'approval-groups.js',
  'diagnostics.js',
  'diagnostics-host.js',
  'diagnostics-preload.js',
  'diagnostics-window.js',
  'settings-model.js',
  'settings-preload.js',
  'settings-window.js',
  'dsh-input.js',
  'stats-model.js',
  'layout-geometry.js',
  'ui-scale.js',
  'external-editor.js',
  'preferences.js',
  'logging.js',
  'window-manager.js',
  'panel-preload.js',
  'ipc-registry.js',
  'menu.js',
  'main.js',
]

console.log('modules: import-time smoke')

for (const rel of MODULES) {
  const abs = path.join(LIB, rel)
  if (!fs.existsSync(abs)) {
    bad(`${rel} exists`, `${abs} missing — did tsc run?`)
    continue
  }
  try {
    require(abs)
    ok(`${rel} loads`)
  } catch (err) {
    bad(`${rel} loads`, `${err.message}\n${String(err.stack).split('\n').slice(1, 4).join('\n')}`)
  }
}

// ── 2. The pure modules stay dependency-free ──

console.log('modules: pure modules carry no runtime dependencies')

/**
 * health-monitor.ts documents (and the whole test suite depends on) that it
 * imports logging only as a type, so it can be driven from plain node. If
 * someone drops the `type`, this fails immediately instead of the unit tests
 * mysteriously breaking.
 */
/**
 * Real `require("x")` calls in CODE, ignoring strings and comments.
 *
 * The previous implementation was a plain text scan
 * (`/require\("([^"]+)"\)/g`) and produced a false positive the moment a
 * module grew a user-facing hint that literally contains `require("electron")`
 * inside a template literal — diagnostics.ts does exactly that. A text scan
 * cannot tell a require from a sentence about require, so comments and
 * string/template literals are blanked out before the scan.
 *
 * Template literal substitutions (`${...}`) are blanked along with the rest of
 * the literal. That can only ever hide a require, and a require inside an
 * interpolation is not a static dependency anyway.
 */
function requiresIn(src) {
  const out = []
  const n = src.length
  let i = 0
  while (i < n) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i += 1
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === quote) { i += 1; break }
        i += 1
      }
      continue
    }
    if (src.startsWith('require("', i)) {
      const end = src.indexOf('")', i + 9)
      if (end > 0) { out.push(src.slice(i + 9, end)); i = end + 2; continue }
    }
    i += 1
  }
  return out
}

function requiresOf(rel) {
  return requiresIn(fs.readFileSync(path.join(LIB, rel), 'utf-8'))
}

// The scanner is hand-rolled, so it gets tested against itself. Without these
// cases a bug in it would read as "every module is dependency-free".
{
  assert(
    requiresIn('const a = require("node:fs")\n').join() === 'node:fs',
    'requiresIn finds a plain require',
    requiresIn('const a = require("node:fs")\n').join(),
  )
  const prose = 'toast(\'沙箱里只能 require("electron")，别的都不行\');\n'
  assert(
    requiresIn(prose).length === 0,
    'requiresIn ignores the word require inside a string',
    `it reported: ${requiresIn(prose).join(', ')}`,
  )
  assert(
    requiresIn('// require("node:fs")\n').length === 0,
    'requiresIn ignores a commented-out require',
    'a line comment was scanned as code',
  )
  assert(
    requiresIn('/* require("node:fs") */\n').length === 0,
    'requiresIn ignores a block-commented require',
    'a block comment was scanned as code',
  )
  const mixed = 'const a = require("node:fs")\nhint(`use require("electron") only`)\n'
  assert(
    requiresIn(mixed).join() === 'node:fs',
    'requiresIn finds the real require next to a prose one',
    requiresIn(mixed).join(),
  )
}

{
  const deps = requiresOf('health-monitor.js')
  assert(deps.length === 0, 'health-monitor.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  const deps = requiresOf('path-links.js')
  assert(deps.length === 0, 'path-links.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  const deps = requiresOf('redact.js')
  assert(deps.length === 0, 'redact.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  // The whole point of highlight.ts is that it adds NO dependency to the
  // asar — pulling in shiki/prism would violate the spec's zero-new-deps rule,
  // and a stray `import` (as opposed to `import type`) would break the unit
  // test that drives it from plain node.
  const deps = requiresOf('highlight.js')
  assert(deps.length === 0, 'highlight.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  // dsh-stream requires this one at runtime (it needs the same de-dup rules),
  // so it is on the pure list for a different reason: it must not pull in
  // electron or anything else, or the stream stops being testable in node.
  const deps = requiresOf('approval-groups.js')
  assert(deps.length === 0, 'approval-groups.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  // Same reason as health-monitor, plus a sharper one: the diagnostics report
  // has to be assemblable from a window that cannot be shown, a preload that
  // never loaded, and a backend that never started. Anything it imports at
  // runtime is a thing that can fail before the report exists.
  const deps = requiresOf('diagnostics.js')
  assert(deps.length === 0, 'diagnostics.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  // dsh-input.ts builds a script string that is shipped to dsh's renderer
  // via executeJavaScript. Pulling in `electron` would mean the unit test
  // cannot load it in plain node, and the smoke harness that exercises every
  // module in this list before any UI is wired up.
  const deps = requiresOf('dsh-input.js')
  assert(deps.length === 0, 'dsh-input.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  // The settings window is where a user goes when something is misconfigured,
  // so its logic must be among the last things that can break. A runtime
  // import here is a module that has to load successfully before the window
  // can validate or normalise anything — i.e. before the user can fix it.
  const deps = requiresOf('settings-model.js')
  assert(deps.length === 0, 'settings-model.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  // The logbar's merge/sort/filter logic. It is what decides what the user
  // sees when they are looking for the cause of a failure, so it must load
  // and run in plain node — a runtime import here would put a broken Electron
  // module between the user and the logs.
  const deps = requiresOf('log-model.js')
  assert(deps.length === 0, 'log-model.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  // The status bar's stats fold. It decides what the user reads as "what is
  // the agent doing", so it must load and run in plain node like the other
  // pure models — a runtime import here would put a broken Electron module
  // between the user and the numbers.
  const deps = requiresOf('stats-model.js')
  assert(deps.length === 0, 'stats-model.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  // The palette model is matched against what the user types at Ctrl+K —
  // it must be loadable (and unit-testable) even when everything else is broken.
  const deps = requiresOf('command-model.js')
  assert(deps.length === 0, 'command-model.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  // Same for the registry: it only calls the injected MenuActions closures.
  // A runtime import here would drag Electron into the unit test.
  const deps = requiresOf('command-registry.js')
  assert(deps.length === 0, 'command-registry.js requires nothing at runtime', `it now requires: ${deps.join(', ')}`)
}
{
  // The three sandboxed bridges must require NOTHING but 'electron'.
  //
  // A local require inside a sandboxed preload throws before
  // exposeInMainWorld runs, so the page comes up with no bridge at all. For
  // these windows that is the worst possible outcome: diagnostics is what
  // the user opens when everything looks broken, settings is what they open
  // to fix a configuration, and the logbar is where they read the logs to
  // find out why — a window whose own startup depends on the thing that is
  // broken defeats its purpose.
  for (const rel of ['diagnostics-preload.js', 'settings-preload.js', 'logbar-preload.js', 'command-preload.js']) {
    const deps = requiresOf(rel)
    assert(
      deps.length === 1 && deps[0] === 'electron',
      `${rel} requires only 'electron'`,
      `${rel} requires [${deps.join(', ')}] — a local require in a sandboxed preload throws before exposeInMainWorld, leaving the page with no bridge at all`
    )
  }
}

// ── 3. Exported symbols other code depends on ──

console.log('modules: expected exports')

function hasExport(rel, name) {
  const mod = require(path.join(LIB, rel))
  return mod && Object.prototype.hasOwnProperty.call(mod, name)
}

const EXPECTED = [
  ['health-monitor.js', 'HealthMonitor'],
  ['health-monitor.js', 'PHASE_LABEL'],
  ['window-manager.js', 'WindowManager'],
  ['window-manager.js', 'STATUS_BAR_HEIGHT'],
  ['window-manager.js', 'SIDEBAR_MIN_WIDTH'],
  ['layout-geometry.js', 'computeLayout'],
  ['layout-geometry.js', 'CONTENT_MIN_WIDTH'],
  ['layout-geometry.js', 'CONTENT_MIN_HEIGHT'],
  ['layout-geometry.js', 'LOGBAR_MIN_HEIGHT'],
  ['layout-geometry.js', 'LOGBAR_MAX_HEIGHT'],
  ['log-model.js', 'parseShellLine'],
  ['log-model.js', 'entryFromBackend'],
  ['log-model.js', 'entryFromAgent'],
  ['log-model.js', 'buildView'],
  ['log-model.js', 'LOG_SOURCES'],
  ['log-model.js', 'LOG_SOURCE_LABELS'],
  ['stats-model.js', 'aggregateStats'],
  ['stats-model.js', 'aggregateOverview'],
  ['stats-model.js', 'formatDuration'],
  ['stats-model.js', 'formatTokens'],
  ['stats-model.js', 'formatStatsSummary'],
  ['ipc-registry.js', 'registerIpc'],
  ['external-editor.js', 'openInEditor'],
  ['external-editor.js', 'EDITOR_PRESETS'],
  ['external-editor.js', 'buildEditorArgs'],
  ['path-links.js', 'findPaths'],
  ['redact.js', 'redactTokenInText'],
  ['logging.js', 'subscribeBackend'],
  ['logging.js', 'getBackendLines'],
  ['preferences.js', 'loadPanelPrefs'],
  ['preferences.js', 'saveExternalEditor'],
  ['highlight.js', 'highlightCode'],
  ['highlight.js', 'languageForPath'],
  ['highlight.js', 'escapeHtml'],
  ['highlight.js', 'HIGHLIGHT_MAX_CHARS'],
  ['approval-groups.js', 'groupApprovals'],
  ['approval-groups.js', 'commonTool'],
  ['approval-groups.js', 'normalizeIds'],
  ['diagnostics.js', 'buildReport'],
  ['diagnostics.js', 'formatReport'],
  ['diagnostics.js', 'tailLines'],
  ['diagnostics-host.js', 'collectDiagnostics'],
  ['diagnostics-host.js', 'LOG_NAMES'],
  ['diagnostics-window.js', 'openDiagnosticsWindow'],
  ['diagnostics-window.js', 'closeDiagnosticsWindow'],
  ['dsh-input.js', 'buildChatInsert'],
  ['dsh-input.js', 'buildInsertScript'],
  ['menu.js', 'setupMenu'],
  ['settings-model.js', 'checkEditorTemplate'],
  ['settings-model.js', 'normalizeTextField'],
  ['settings-model.js', 'changedFields'],
  ['settings-model.js', 'needsRestart'],
  ['settings-model.js', 'RESTART_REQUIRED_FIELDS'],
  ['settings-window.js', 'openSettingsWindow'],
  ['settings-window.js', 'closeSettingsWindow'],
  ['settings-window.js', 'notifySettingsSaved'],
  ['command-model.js', 'filterCommands'],
  ['command-registry.js', 'buildCommandList'],
  ['command-registry.js', 'dispatchCommand'],
  ['command-palette-window.js', 'openCommandPalette'],
  ['command-palette-window.js', 'closeCommandPalette'],
]

for (const [rel, name] of EXPECTED) {
  assert(hasExport(rel, name), `${rel} exports ${name}`, `${name} is missing from ${rel}`)
}

// ── 4. Lifecycle hook + startup hardening ──

console.log('modules: main.js startup wiring')

assert(
  calls.includes('whenReady'),
  'main.js hooked app.whenReady()',
  'main.js loaded without registering a startup entry point'
)
assert(
  calls.includes('disableHardwareAcceleration'),
  'main.js disabled GPU acceleration',
  'the startup-hardening block in main.ts no longer runs'
)
assert(
  process.listenerCount('uncaughtException') > 0,
  'main.js installed the fatal error handler',
  'no uncaughtException handler — failures would die silently'
)

// ── 5. registerIpc really registers every panel channel ──

// main.js only calls registerIpc() from inside whenReady(), which this test
// never resolves. Calling it directly proves the registry itself is wired, and
// the channel list is cross-checked against what the preload invokes so the
// two can never drift apart.
console.log('modules: registerIpc channel coverage')

const { registerIpc } = require(path.join(LIB, 'ipc-registry.js'))

/** Records what registerIpc did to the mux stream, so the wiring is asserted. */
const streamCalls = { onChange: 'never-called', responded: [] }
const fakeStream = {
  setOnChange: (fn) => {
    streamCalls.onChange = fn
  },
  panelSnapshot: () => ({ changes: [], approvals: [], sessions: [], dropped: 0, connected: true }),
  respond: async (id, outcome) => {
    streamCalls.responded.push([id, outcome])
    return { ok: true }
  },
}

const teardown = registerIpc({
  getWindowManager: () => null,
  getHealthMonitor: () => null,
  getStream: () => fakeStream,
  getAppVersion: () => '0.0.0-smoke',
  restartBackend: async () => ({ ok: true }),
  getStatusInfo: () => ({ version: 'x', port: null, channel: 'next' }),
  quitApp: () => {},
})

// registerIpc must hook the mux stream for the change-review feed, and must
// NOT hard-require it: `getStream` is genuinely absent before the first
// successful launch, and a missing optional collaborator must not be able to
// take down IPC registration (it used to: `deps.getStream()` threw).
assert(
  typeof streamCalls.onChange === 'function',
  'registerIpc hooked the mux stream change feed',
  `setOnChange received ${JSON.stringify(String(streamCalls.onChange))}`
)

assert(typeof teardown === 'function', 'registerIpc returns a teardown function', 'callers cannot unsubscribe the live feeds')

// Same source of truth as test/panel-api.contract.cjs.
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'panel-preload.ts'), 'utf-8')
const invoked = [...preloadSrc.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])

for (const ch of invoked) {
  assert(ipcChannels.handle.has(ch), `registerIpc handles '${ch}'`, `'${ch}' is invoked by the preload but never registered`)
}
for (const ch of ['switch-theme', 'window-minimize', 'window-maximize', 'window-close']) {
  assert(ipcChannels.on.has(ch), `legacy channel '${ch}' still registered`, `the legacy '${ch}' handler was lost in the move to ipc-registry.ts`)
}

// The logbar bridge gets the same producer/consumer cross-check, against its
// OWN preload: an invoke the page makes that no handler answers shows up in
// the packaged app as a console error in a panel the user just opened.
const logbarPreloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'logbar-preload.ts'), 'utf-8')
const logbarInvoked = [...logbarPreloadSrc.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
for (const ch of logbarInvoked) {
  assert(ipcChannels.handle.has(ch), `registerIpc handles '${ch}' (logbar)`, `'${ch}' is invoked by logbar-preload but never registered`)
}
assert(
  ipcChannels.on.has('logs:view-ready'),
  "registerIpc listens on 'logs:view-ready'",
  "logbar-preload sends 'logs:view-ready' but nothing listens — the diagnostics report would show the logbar as never-ready"
)

// Teardown must be safe to call and must not leak the 5s health ticker.
let teardownError = null
try {
  teardown()
} catch (err) {
  teardownError = err
}
assert(teardownError === null, 'teardown() runs cleanly', `teardown threw: ${teardownError && teardownError.message}`)
assert(
  !streamCalls.onChange,
  'teardown() unhooks the mux stream change feed',
  `setOnChange left as ${JSON.stringify(String(streamCalls.onChange))} — the stream would keep pushing into dead views`
)

// A caller that has no stream yet must still be able to register IPC. This is
// the exact shape of the bug above: `deps.getStream()` was called
// unconditionally and threw when the key was absent, killing the rest of this
// file (and, in the app, every handler registered after it).
let noStreamError = null
let noStreamTeardown = null
try {
  noStreamTeardown = registerIpc({
    getWindowManager: () => null,
    getHealthMonitor: () => null,
    getAppVersion: () => '0.0.0-smoke',
    restartBackend: async () => ({ ok: true }),
    getStatusInfo: () => ({ version: 'x', port: null, channel: 'next' }),
    quitApp: () => {},
  })
  noStreamTeardown()
} catch (err) {
  noStreamError = err
}
assert(
  noStreamError === null,
  'registerIpc tolerates a caller with no mux stream',
  `threw: ${noStreamError && noStreamError.message}`
)

// ── 6. setupMenu builds the new entries ──

console.log('modules: setupMenu content')

const { setupMenu } = require(path.join(LIB, 'menu.js'))

setupMenu({
  onCheckUpdate: () => {},
  onInstallPluginMarket: () => {},
  onShowAbout: () => {},
  onSelectChannel: () => {},
  onShowRecovery: () => {},
  getPanelState: () => ({ panel: true, statusBar: true, avoidCss: true }),
  togglePanel: () => {},
  toggleStatusBar: () => {},
  toggleAvoidCss: () => {},
  restartBackend: () => {},
  openLogs: () => {},
  describeEditor: () => 'VS Code',
  chooseEditor: () => {},
})

assert(menuTemplates.length === 1, 'setupMenu built one template', `built ${menuTemplates.length}`)
const labels = flattenLabels(menuTemplates[0] ?? [])
const required = ['监控面板', '状态栏', '重启后端服务', '打开日志文件夹', '外部编辑器：VS Code', '选择外部编辑器…']
for (const label of required) {
  assert(labels.includes(label), `menu contains 「${label}」`, `menu is missing 「${label}」 — got: ${labels.join(' | ')}`)
}
assert(labels.includes('Ctrl+Alt+B'), 'menu binds the panel shortcut', 'the Ctrl+Alt+B accelerator is gone')
assert(calls.includes('setApplicationMenu'), 'setupMenu installed the menu', 'Menu.setApplicationMenu() was never called')

try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch { /* best effort */ }

/**
 * panel:respond-many must refuse an allow that spans two tools.
 *
 * The rule lives in the main process on purpose: a page bug must not be able to
 * turn one click into consent across every tool at once. That only holds if the
 * guard is exercised HERE — the page cannot be the thing checking it.
 *
 * Async, so it runs last: this file is CommonJS with no top-level await, and the
 * summary below has to wait for these assertions or they would not be counted.
 */
async function checkBatchGuard() {
  console.log('modules: batch approval allow-guard')

  const canned = [
    { approvalId: 'a1', toolName: 'edit', ts: 1 },
    { approvalId: 'a2', toolName: 'edit', ts: 2 },
    { approvalId: 'b1', toolName: 'bash', ts: 3 },
  ]
  const sent = []
  const guardStream = {
    setOnChange: () => {},
    panelSnapshot: () => ({ changes: [], approvals: canned, sessions: [], dropped: 0, connected: true }),
    respond: async () => ({ ok: true }),
    approvals: () => canned,
    respondMany: async (ids, outcome) => {
      sent.push({ ids, outcome })
      return { ok: true, answered: ids.length, failed: [], skipped: [], total: ids.length }
    },
  }

  const guardTeardown = registerIpc({
    getWindowManager: () => null,
    getHealthMonitor: () => null,
    getStream: () => guardStream,
    getAppVersion: () => '0.0.0-smoke',
    restartBackend: async () => ({ ok: true }),
    getStatusInfo: () => ({ version: 'x', port: null, channel: 'next' }),
    quitApp: () => {},
  })

  try {
    const respondMany = ipcChannels.handlers.get('panel:respond-many')
    assert(typeof respondMany === 'function', 'panel:respond-many has a handler we can drive', 'no handler captured')
    if (typeof respondMany !== 'function') return
    const call = (ids, outcome) => respondMany(null, ids, outcome)

    const crossTool = await call(['a1', 'b1'], 'allowed-once')
    assert(crossTool.ok === false, 'an allow spanning two tools is refused', 'it went through')
    assert(sent.length === 0, 'and nothing reaches the stream', `${sent.length} call(s) escaped the guard`)

    const sameTool = await call(['a1', 'a2'], 'allowed-once')
    assert(sameTool.ok === true, 'an allow within one tool goes through', JSON.stringify(sameTool))
    assert(sent.length === 1, 'and reaches the stream exactly once')
    assert(sent[0].outcome === 'allowed-once', 'with the requested outcome')

    // Refusing work cannot cause damage, so it is deliberately not scoped.
    const crossToolReject = await call(['a1', 'b1'], 'rejected')
    assert(crossToolReject.ok === true, 'a reject across tools is allowed', JSON.stringify(crossToolReject))

    const stale = await call(['a1', 'gone'], 'allowed-once')
    assert(stale.ok === false, 'an allow containing a resolved approval is refused', 'the guard must not half-apply')

    const badOutcome = await call(['a1'], 'allow-all')
    assert(badOutcome.ok === false, 'an unknown outcome is refused', JSON.stringify(badOutcome))

    const junk = await call([null, 42, '  '], 'rejected')
    assert(junk.ok === false, 'an empty batch is refused', JSON.stringify(junk))

    const notArray = await call('a1', 'rejected')
    assert(notArray.ok === false, 'a non-array id list is refused', JSON.stringify(notArray))
  } finally {
    guardTeardown()
  }
}

/**
 * The diagnostics channels, driven through the captured handlers.
 *
 * `diag:report` is the surface a user sees when the app looks broken, so two
 * properties matter more than the shape of the payload: it must never reject
 * (a rejected promise renders an empty window), and it must never carry the dsh
 * launch token out of the process through `diag:copy`.
 */
async function checkDiagnosticsIpc() {
  console.log('modules: diagnostics channels')

  const fakeReports = []
  const clip = []

  const hostDeps = {
    version: () => '0.0.0-smoke',
    dsh: () => ({ version: 'dsh-test', port: 8321, channel: 'next' }),
    workspace: () => 'D:/workspace',
    health: () => ({
      phase: 'ready',
      lastLineTs: Date.now(),
      exitCode: null,
      recentErrors: 0,
      restartCount: 0,
      detail: '后端运行中',
    }),
    healthPhaseLabel: (p) => (p === 'ready' ? '就绪' : p),
    window: () => ({ width: 1440, height: 900, visible: true }),
    views: () => ({
      panel: { readyAt: Date.now(), errors: [] },
      statusbar: { readyAt: 0, errors: ['Error: module not found ./x.js'] },
    }),
    // Injected so this never touches the real log directory — and so the
    // "unreadable log" path can be exercised on purpose.
    readFile: (abs) => {
      if (abs.includes('fatal')) throw new Error('ENOENT: no such file')
      return Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    },
    canWrite: () => true,
  }

  const teardown = registerIpc({
    getWindowManager: () => null,
    getHealthMonitor: () => null,
    getAppVersion: () => '0.0.0-smoke',
    restartBackend: async () => ({ ok: true }),
    getStatusInfo: () => ({ version: 'x', port: null, channel: 'next' }),
    quitApp: () => {},
    getDiagnosticsHost: () => hostDeps,
  })

  try {
    const report = ipcChannels.handlers.get('diag:report')
    const copy = ipcChannels.handlers.get('diag:copy')

    assert(typeof report === 'function', 'diag:report is registered', 'no handler captured')
    assert(typeof copy === 'function', 'diag:copy is registered', 'no handler captured')
    if (typeof report !== 'function' || typeof copy !== 'function') return

    const payload = await report(null)

    assert(
      !payload.error,
      'diag:report produces a report when the host is wired up',
      `it failed: ${payload.error}`,
    )
    const checks = payload?.report?.checks ?? []
    assert(checks.length > 0, 'the report carries checks', `got ${checks.length}`)
    fakeReports.push(payload)

    // The whole point of the ping: a view that never reported ready has to come
    // back red, with the captured reason attached.
    const statusbar = checks.find((c) => c.id === 'view-statusbar')
    assert(statusbar?.level === 'fail', 'a view that never reported ready is a failure', JSON.stringify(statusbar))
    assert(
      String(statusbar?.detail).includes('module not found'),
      'and the failure carries the captured preload error',
      String(statusbar?.detail),
    )
    const panelCheck = checks.find((c) => c.id === 'view-panel')
    assert(panelCheck?.level === 'ok', 'a view that reported ready passes', JSON.stringify(panelCheck))

    assert(payload.logs?.length === 4, 'all four logs are attempted', `got ${payload.logs?.length}`)
    const fatal = payload.logs.find((l) => l.name === 'fatal')
    assert(!!fatal?.error, 'a log that cannot be read says so', 'the read error was swallowed')
    const launcher = payload.logs.find((l) => l.name === 'launcher')
    assert(
      launcher?.lines?.length === 120,
      'a readable log is truncated to the tail limit',
      `got ${launcher?.lines?.length} lines`,
    )
    assert(
      launcher.lines[launcher.lines.length - 1] === 'line 499',
      'the tail ends at the last line, oldest first',
      JSON.stringify(launcher.lines.slice(-2)),
    )

    // ── the safety property ──
    const TOKEN = 'a'.repeat(64)
    const leak = await copy(null, `report body token=${TOKEN} end`)
    assert(leak.ok === true, 'diag:copy accepts a string')
    clip.push(leak)
    assert(
      !String(clipText).includes(TOKEN),
      'diag:copy redacts a token before it reaches the clipboard',
      'a 64-hex token survived the copy — the launch token outlives the process once pasted',
    )

    assert((await copy(null, '')).ok === false, 'diag:copy refuses an empty string')
    assert((await copy(null, null)).ok === false, 'diag:copy refuses a non-string')
    assert((await copy(null, { a: 1 })).ok === false, 'diag:copy refuses an object')
  } finally {
    teardown()
  }
}

/**
 * Static guard for the three-column layout policy.
 *
 * Two user reports are pinned down here:
 *
 *   1. "打开侧栏会严重挤压主窗体的内容" — while the dsh page lived in the
 *      BrowserWindow's own (unmovable) webContents, the only way to keep it
 *      clear of the overlays was to inject CSS padding, which squeezed the
 *      chat column.
 *   2. "右侧监控面板打开后与中间的 dsh 主窗口中间有一大段的空白" — injected
 *      padding shrinks the page's content box but does NOT move the viewport
 *      the page lays itself out in, so the page kept its own margins and a
 *      dead strip appeared before the panel.
 *
 * Both are cured structurally by giving the page its own WebContentsView and
 * bounding it to the space between the overlays (see layout-geometry.ts).
 * These checks are static because the policy lives in how the compiled
 * window-manager wires the rectangles together, and both regressions are
 * silent from the code's side — only visible on screen.
 */
async function checkLayoutPolicy() {
  const wm = fs.readFileSync(path.join(LIB, 'window-manager.js'), 'utf-8')
  const mainJs = fs.readFileSync(path.join(LIB, 'main.js'), 'utf-8')
  // Comments are stripped so a comment that merely MENTIONS the old padding
  // trick cannot satisfy (or fail) these assertions.
  const code = wm
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  const mainCode = mainJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  // 1. Every rectangle comes from the pure geometry module. Two independent
  //    computations of "how wide is the sidebar" is exactly how the page and
  //    the overlays used to disagree.
  // tsc emits imported calls as `(0, mod.fn)(...)`, so tolerate the closing
  // paren between the identifier and the call.
  assert(
    /computeLayout[\s)]{0,2}\(/.test(code),
    'window-manager: layout() delegates the rectangles to computeLayout()',
    'window-manager.js no longer calls computeLayout — page and overlay geometry can drift apart again'
  )
  for (const slot of ['content', 'sidebar', 'panel']) {
    assert(
      new RegExp(`setBounds\\(rects\\.${slot}\\)`).test(code),
      `window-manager: ${slot} is bounded by its computed rect`,
      `window-manager.js no longer applies rects.${slot} — the ${slot} view keeps its stale bounds`
    )
  }

  // 2. The padding workaround is gone. If it comes back, so do both reports.
  assert(
    !/padding-(left|right)/.test(code),
    'window-manager: no CSS padding is injected into the dsh page',
    'window-manager.js injects CSS padding again — padding does not move the page viewport, which is what caused the blank strip'
  )
  // 2b. Nothing is injected into the dsh page specifically.
  //
  // The ban is on the PAGE, not on insertCSS as a word: the shell legitimately
  // injects `--fs-scale` into its OWN overlay views (bindUiScale / applyUiScale,
  // see ui-scale.ts) and that must not trip this. What must never come back is
  // styling a page we do not own — padding injection is exactly the bug this
  // three-column layout replaced.
  for (const target of ['pageContents', 'contentView', 'this.win.webContents']) {
    const re = new RegExp(`${target.replace('.', '\\.')}[\\s\\S]{0,40}insertCSS`)
    assert(
      !re.test(code),
      `window-manager: nothing is injected into ${target}`,
      `window-manager.js injects CSS into ${target} — the dsh page is not ours to style`
    )
  }
  // 2c. …and the font scale IS applied to our own overlays. Without it the
  // 面板字号 menu does nothing, which is the failure the user would report next.
  assert(
    /insertCSS\(\s*\(0,\s*ui_scale_js_1\.uiScaleCss\)/.test(code) ||
      /insertCSS\(uiScaleCss\(/.test(code),
    'window-manager: the overlay views get the --fs-scale override',
    'window-manager.js no longer injects uiScaleCss into its views — the 面板字号 menu would silently do nothing'
  )

  // 3. Z-order: contentView children paint in insertion order, so the page
  //    must be added BEFORE the overlays or it covers them.
  const iContent = code.indexOf('addChildView(view)')
  const iPanel = code.indexOf('addChildView(this.panelView)')
  assert(
    iContent > 0 && iPanel > 0 && iContent < iPanel,
    'window-manager: the page view is added before the overlays',
    'the content view is added after the panel — it would paint over the sidebar and panel'
  )

  // 4. main.js has to load the page through the manager. Loading it into the
  //    BrowserWindow instead silently re-instates the unmovable webContents.
  assert(
    /createContentView\s*\(/.test(mainCode),
    'main.js creates the page through WindowManager.createContentView()',
    'main.js no longer calls createContentView — the dsh page would render in the unmovable built-in webContents'
  )
  assert(
    !/mainWindow\.loadURL\(/.test(mainCode),
    'main.js never loads the dsh page into the BrowserWindow itself',
    'main.js calls mainWindow.loadURL — the page would leave the content view and be covered by the overlays again'
  )
}

/**
 * Static guard for the settings window's correctness properties that are
 * invisible until something has already gone wrong.
 *
 * Both halves concern input that arrives from a renderer and lands somewhere
 * dangerous:
 *
 *  - the saved state is interpolated into CSS (a 0 blanks every panel), fed
 *    to setBounds (NaN is rejected), persisted as the update channel (an
 *    unknown id breaks the next launch) and passed to spawn();
 *  - the editor "test open" points an external program at a file path, and the
 *    prefs file is the one path it must never be.
 *
 * None of these fail loudly at the point of the mistake, which is why they are
 * asserted against the source rather than left to review.
 *
 * Read from src/, not lib-new/: tsc rewrites imported calls to
 * `(0, mod_1.fn)(...)`, so the anchors here have to match what is written.
 */
async function checkSettingsPolicy() {
  const ipc = fs.readFileSync(path.join(ROOT, 'src', 'ipc-registry.ts'), 'utf-8')
  // Comments stripped: this file quotes the very expressions under test.
  const code = ipc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  assert(
    /isChannelId\s*\(/.test(code),
    'settings:save validates the channel id',
    "ipc-registry no longer checks isChannelId — an arbitrary string would be persisted as the update channel and break the next launch"
  )
  // Counted, not merely matched: the scale is normalised twice — once when
  // the incoming state is coerced, and again at the point the value is handed
  // to setUiScale and persisted. A plain `/…/.test()` passed with either one
  // missing, which is exactly the mutation it is supposed to catch.
  const scaleGuards = (code.match(/normalizeUiScale\s*\(/g) || []).length
  assert(
    scaleGuards >= 2,
    'settings:save normalises the font scale on the way in and on the way out',
    `ipc-registry normalises the font scale ${scaleGuards} time(s), expected at least 2 — a value from the renderer would reach CSS, where 0 or NaN renders every panel blank`
  )
  assert(
    /normalizeTextField\s*\(/.test(code),
    'settings:save sanitises the editor command and template',
    'ipc-registry no longer calls normalizeTextField — raw renderer input would reach spawn() and the prefs file'
  )
  assert(
    /changedFields\s*\(/.test(code),
    'settings:save applies only what changed',
    'ipc-registry no longer diffs the state — every save would reload the dsh page even when the theme did not change'
  )

  // The editor probe file must live in the OS temp directory.
  assert(
    /join\(tmpdir\(\)/.test(code) && /EDITOR_TEST_FILE/.test(code),
    'settings:test-editor writes its probe into the OS temp directory',
    'the editor probe file is no longer built from tmpdir() — a test button that opens a real project file would open something the user did not point at'
  )
  assert(
    !/openInEditor\([^)]*prefsPath/.test(code),
    'settings:test-editor never opens the prefs file',
    'the editor probe opens the prefs file — one stray edit there is a corrupted configuration, reported much later as an unrelated failure'
  )

  // The settings window edits the configuration, so it must not depend on
  // loading the modules that a bad configuration could have broken.
  const sw = fs.readFileSync(path.join(ROOT, 'src', 'settings-window.ts'), 'utf-8')
  assert(
    /sandbox:\s*true/.test(sw),
    'settings-window keeps its preload sandboxed',
    'settings-window.ts no longer sets sandbox: true — the window a user opens to fix a broken configuration now depends on loading project modules'
  )
}

function finalize() {
  // Belt and braces: even with the uncaughtException guard above, assert that the
  // whole file actually ran. An early abort used to be indistinguishable from a
  // clean pass because nothing checked how much of the suite executed.
  const MIN_ASSERTIONS = 192
  assert(
    pass + fail >= MIN_ASSERTIONS,
    `the whole suite ran (at least ${MIN_ASSERTIONS} assertions)`,
    `only ${pass + fail} assertions ran — the file aborted early`
  )

  console.log(`\nmodules: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

checkBatchGuard()
  .catch((err) => {
    fail += 1
    console.error(`  FAIL batch guard threw: ${err && err.message}`)
  })
  .then(checkDiagnosticsIpc)
  .catch((err) => {
    fail += 1
    console.error(`  FAIL diagnostics ipc threw: ${err && err.message}`)
  })
  .then(checkLayoutPolicy)
  .catch((err) => {
    fail += 1
    console.error(`  FAIL layout policy threw: ${err && err.message}`)
  })
  .then(checkSettingsPolicy)
  .catch((err) => {
    fail += 1
    console.error(`  FAIL settings policy threw: ${err && err.message}`)
  })
  .then(finalize)

