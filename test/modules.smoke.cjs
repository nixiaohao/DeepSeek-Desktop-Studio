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
  'dsh-input.js',
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
 * Static guard for the overlay layout policy.
 *
 * The user reported "打开侧栏会严重挤压主窗体的内容" when the sidebar
 * added its 280px on top of the dsh file tree's 200px. The decision (see
 * window-manager.ts refreshAvoidance) is now: the sidebar OVERLAPS the dsh
 * file tree, so the chat column does not move. This is a static check on
 * the compiled lib-new/window-manager.js because the behaviour is a
 * function of the CSS string the function builds, not its public surface,
 * and any regression here is silent from the user's side — the chat
 * column just shrinks again.
 */
async function checkLayoutPolicy() {
  const wm = fs.readFileSync(path.join(LIB, 'window-manager.js'), 'utf-8')
  // Strip block + line comments. String literals and template strings stay
  // intact: the test wants to see the template-literal interpolation that
  // the function builds, not the runtime value, and stripping them would
  // destroy the very `${right}` we want to assert on.
  const code = wm
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  // The left padding must be a literal 0: a future regression that
  // re-introduces `const left = this.sidebarWidthNow()` would re-create
  // the squeeze the user reported (sidebar + injected padding = chat
  // column squeezed by 280px on top of the dsh file tree's 200px).
  assert(
    /const\s+left\s*=\s*0\s*[;,]/.test(code),
    'window-manager: refreshAvoidance pins `left` to a literal 0',
    'window-manager.js no longer pins padding-left to 0 — the sidebar may once again push the chat column rightward'
  )
  // And the CSS template must still be hooked up: `padding-right:${right}px`
  // remains so the right panel still pushes the chat column to keep it
  // visible. The template literal preserves the `${right}` interpolation.
  assert(
    /padding-right:\$\{right\}px/.test(code),
    'window-manager: refreshAvoidance still injects padding-right from the panel width',
    'window-manager.js no longer pads the right side for the panel — the panel would cover the chat column'
  )
}

function finalize() {
  // Belt and braces: even with the uncaughtException guard above, assert that the
  // whole file actually ran. An early abort used to be indistinguishable from a
  // clean pass because nothing checked how much of the suite executed.
  const MIN_ASSERTIONS = 78
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
  .then(finalize)

