/**
 * command-registry.ts — the command palette's data and dispatcher.
 *
 * ZERO RUNTIME DEPENDENCIES on purpose: the command list and the dispatch are
 * pure data + function calls over an injected `MenuActions` (imported as a
 * type only), so both are unit-testable in plain node with fake actions.
 *
 * WHY MENUACTIONS AND NOT ITS OWN ACTION OBJECT
 * ---------------------------------------------
 * Every command the palette offers is already a menu action built in main.ts's
 * buildMenuActions(). A second action object would drift: a menu item would
 * gain a behaviour the palette did not know about (or vice versa). Building
 * the list FROM MenuActions means the palette can never offer an action the
 * app cannot perform — the closures are literally the same ones.
 *
 * The renderer never sees any of this. It receives Command[] (id/title/hint)
 * over `palette:query` and sends an id back over `palette:run`; the sandboxed
 * preload cannot require this module, which is exactly the settings-window
 * pattern again.
 */
import type { Command } from './command-model.js'
import type { MenuActions } from './menu.js'
import type { UiScale } from './preferences.js'

/** The scale steps the palette lists, shipped in because preferences is main-process data. */
export interface ScaleChoice {
  value: UiScale
  label: string
}

/**
 * Everything buildCommandList/dispatchCommand need, in one parameter object so
 * main.ts can wire them from the same closures the menu uses.
 */
export interface CommandSource {
  actions: MenuActions
  scales: ScaleChoice[]
}

/** Id prefix for the font-scale commands; the value rides after the colon. */
const SCALE_PREFIX = 'ui-scale:'

/**
 * The palette's command list, in display order: views first (most used),
 * then backend/logs, then configuration, then app-level actions.
 */
export function buildCommandList(src: CommandSource): Command[] {
  const a = src.actions
  const list: Command[] = [
    { id: 'toggle-sidebar', title: '切换文件侧栏', hint: 'Ctrl+Alt+F' },
    { id: 'toggle-panel', title: '切换监控面板', hint: 'Ctrl+Alt+B' },
    { id: 'toggle-statusbar', title: '切换状态栏', hint: 'Ctrl+Alt+S' },
    { id: 'toggle-logbar', title: '切换日志面板', hint: 'Ctrl+Alt+L' },
    { id: 'layout-focus', title: '布局：专注（侧栏收起）', hint: '布局预设' },
    { id: 'layout-classic', title: '布局：经典', hint: '布局预设' },
    { id: 'layout-minimal', title: '布局：极简', hint: '布局预设' },
    {
      id: 'open-settings',
      title: '打开设置',
      hint: 'Ctrl+,',
    },
    { id: 'open-diagnostics', title: '诊断自检', hint: 'Ctrl+Alt+D' },
    { id: 'restart-backend', title: '重启后端服务' },
    { id: 'open-logs', title: '打开日志文件夹' },
    { id: 'choose-editor', title: '选择外部编辑器' },
    { id: 'reveal-prefs', title: '打开配置文件' },
    { id: 'check-update', title: '检查更新' },
    { id: 'about', title: '关于 DeepSeek Studio' },
  ]
  // Scales are listed individually (rather than one "字号…" command) so the
  // palette can apply a step in one keystroke: "130" narrows to one row.
  for (const s of src.scales) {
    list.push({ id: `${SCALE_PREFIX}${s.value}`, title: `面板字号 ${s.label}`, hint: '面板字号' })
  }
  return list
}

/**
 * Run one command by id. Returns false (and does nothing) for unknown ids,
 * non-string ids, or a source that was never wired — the palette treats a
 * falsy reply as "command unavailable" rather than crashing.
 *
 * Unknown-id dispatches are only possible from a stale page; a falsy reply is
 * the same graceful answer settings:save gives for malformed fields.
 */
export function dispatchCommand(src: CommandSource, id: unknown): boolean {
  if (typeof id !== 'string' || id.length === 0) return false
  const a = src.actions
  const known: Record<string, () => void> = {
    'toggle-sidebar': () => a.toggleSidebar(),
    'toggle-panel': () => a.togglePanel(),
    'toggle-statusbar': () => a.toggleStatusBar(),
    'toggle-logbar': () => a.toggleLogbar(),
    'layout-focus': () => a.setLayout('focus'),
    'layout-classic': () => a.setLayout('classic'),
    'layout-minimal': () => a.setLayout('minimal'),
    'open-settings': () => a.openSettings(),
    'open-diagnostics': () => a.openDiagnostics(),
    'restart-backend': () => a.restartBackend(),
    'open-logs': () => a.openLogs(),
    'choose-editor': () => a.chooseEditor(),
    'reveal-prefs': () => a.revealPrefs(),
    'check-update': () => a.onCheckUpdate(),
    'about': () => a.onShowAbout(),
  }
  const run = known[id]
  if (run) {
    run()
    return true
  }
  if (id.startsWith(SCALE_PREFIX)) {
    const raw = Number(id.slice(SCALE_PREFIX.length))
    const scale = src.scales.find((s) => s.value === raw)
    if (scale) {
      a.setUiScale(scale.value)
      return true
    }
  }
  return false
}
