/**
 * settings-model.ts — the settings window's pure logic.
 *
 * ZERO DEPENDENCIES, and that is deliberate rather than incidental: the
 * settings window is where a user goes when something is misconfigured, so it
 * must be the *last* thing to break, not the first. Keeping this module free of
 * Electron, fs and preferences.ts means the whole of its behaviour (validation,
 * normalisation, change detection) is unit-testable in plain node and cannot
 * be taken down by an unrelated subsystem failing to load.
 *
 * The window's preload therefore stays sandboxed too (see settings-preload.ts):
 * every list it renders — themes, channels, font steps, editor presets — is
 * handed to it by the main process over IPC rather than required in the
 * renderer.
 */

/** One choice in a <select>. */
export interface Choice<T extends string | number> {
  value: T
  label: string
}

/** A choice with an extra warning flag (used by update channels). */
export interface RiskyChoice extends Choice<string> {
  risky: boolean
}

/**
 * An editor preset: a label, plus the config it stands for.
 *
 * The full config travels with the choice rather than being looked up in the
 * renderer because the presets are main-process data (EDITOR_PRESETS lives in
 * external-editor.ts, which the sandboxed preload cannot require). Selecting
 * one fills the two text fields — it does not write straight to the model, so
 * the user sees what the preset actually is before saving it.
 */
export interface EditorPresetChoice extends Choice<string> {
  command: string
  args: string
}

/**
 * Everything the page needs in order to render its controls.
 *
 * Built in the main process and shipped over IPC in one piece: the page has no
 * way to enumerate themes or channels on its own, and a dropdown that cannot
 * list its options is a dropdown the user cannot use.
 */
export interface SettingsOptions {
  themes: Choice<string>[]
  channels: RiskyChoice[]
  scales: Choice<number>[]
  /** Editor presets; a preset with `command: ''` is the OS-default entry. */
  editorPresets: EditorPresetChoice[]
}

/** The editable settings, flattened out of the three places they live. */
export interface SettingsState {
  themeId: string
  /** One of UI_SCALES. Normalised before it reaches here. */
  uiScale: number
  sidebarVisible: boolean
  panelVisible: boolean
  statusVisible: boolean
  /** External editor; empty `command` means "use the OS file association". */
  editor: { command: string; args: string }
  /** Upstream release channel id. Changing it requires an app restart. */
  channel: string
}

/** Read-only facts shown for orientation (the user may need to find the file). */
export interface SettingsInfo {
  /** Absolute path of ~/.dsh/studio-prefs.json. */
  prefsPath: string
  version: string
}

export interface SettingsModel {
  state: SettingsState
  options: SettingsOptions
  info: SettingsInfo
}

// ── Editor argument templates ──

/** Placeholders an argument template may use. Anything else is a typo. */
const KNOWN_PLACEHOLDERS = ['file', 'line', 'col'] as const

export interface TemplateCheck {
  level: 'ok' | 'warn'
  message: string
}

/**
 * Sanity-check an editor argument template.
 *
 * Two things are worth flagging, and neither is fatal — `buildEditorArgs()`
 * handles both, so the file still opens. That is exactly why they are WARNINGS
 * and not validation errors: refusing to save would be refusing a configuration
 * that works, and the message explains the behaviour instead.
 *
 *  1. No `{file}` placeholder. `buildEditorArgs` appends the path in that case,
 *     but it lands at the END of argv — so a template like `-n{line}` opens the
 *     file with no line number applied to it. The user wrote something that
 *     looks deliberate and gets a different result.
 *
 *  2. An unknown `{placeholder}`. It is passed through verbatim, which is
 *     virtually always a typo for `{line}`/`{col}` — and it is invisible until
 *     the user wonders why every file opens at the same spot.
 *
 * @param args    the template, before trimming
 * @param command the editor command; when empty the OS association is used and
 *                the template is irrelevant, so nothing is reported
 */
export function checkEditorTemplate(args: string, command: string): TemplateCheck {
  const cmd = typeof command === 'string' ? command.trim() : ''
  // No editor configured → shell.openPath() is used and args are ignored.
  if (!cmd) return { level: 'ok', message: '未配置编辑器，将使用系统默认程序打开。' }

  const tpl = typeof args === 'string' ? args.trim() : ''
  if (!tpl) return { level: 'ok', message: '留空等价于 {file}。' }

  const unknown = new Set<string>()
  // Match `{...}` but not the known placeholders. This is a scan for typos, so
  // `{file}` inside a larger token (`{file}:{line}`) must be recognised too —
  // hence per-placeholder matching rather than tokenising the whole template.
  const braceRe = /\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = braceRe.exec(tpl)) !== null) {
    const name = m[1].trim()
    if (!(KNOWN_PLACEHOLDERS as readonly string[]).includes(name)) unknown.add(name)
  }

  if (unknown.size > 0) {
    const list = [...unknown].map((p) => `{${p}}`).join('、')
    return {
      level: 'warn',
      message: `无法识别的占位符 ${list} 会原样传给编辑器（可用：{file}、{line}、{col}）。`,
    }
  }

  // Must be a SUBSTRING test: `{file}:{line}` embeds the path inside a larger
  // token, so an exact-match check would wrongly warn about the common
  // VS Code / Cursor form.
  if (!tpl.includes('{file}')) {
    return {
      level: 'warn',
      message: '模板里没有 {file}，文件路径会被自动追加到参数末尾。',
    }
  }

  return { level: 'ok', message: '模板可用。' }
}

/**
 * Trim and length-cap a text field coming from the page.
 *
 * The cap exists because these values end up in `spawn()` and in a JSON file
 * the user has to read when something goes wrong; a 4KB path pasted by
 * accident is never a real editor command, and truncating beats persisting
 * garbage that then fails at every file click for a reason that is hard to find.
 */
export function normalizeTextField(value: unknown, maxLen = 512): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLen)
}

// ── Change detection ──

/** Field names of SettingsState, for the change list. */
export type SettingsField = keyof SettingsState

/**
 * Fields whose new value only takes effect after the app restarts.
 *
 * Only the release channel, and for a structural reason: it is read once while
 * resolving the upstream runtime during boot, and switching it mid-session
 * would leave a running dsh on the old channel while the prefs claim the new
 * one — the two would disagree until restart, and the mismatch is invisible.
 *
 * Theme, font scale and panel visibility all apply live, so they are absent by
 * design. Adding a field here is a claim that it genuinely cannot be applied
 * at runtime; if it can, wire it up live instead.
 */
export const RESTART_REQUIRED_FIELDS: readonly SettingsField[] = ['channel']

/**
 * Which fields differ between two states.
 *
 * Compared field by field rather than by object identity: the page sends back a
 * whole state, most of which is unchanged, and "what actually changed" is what
 * decides whether the app has to restart — the single most disruptive thing a
 * settings window can ask for. Asking for a restart because a checkbox was
 * touched and put back would be infuriating.
 *
 * The editor is compared as its two scalars, not as an object reference, since
 * the page rebuilds that object on every edit.
 */
export function changedFields(before: SettingsState, after: SettingsState): SettingsField[] {
  const out: SettingsField[] = []
  const keys: SettingsField[] = [
    'themeId',
    'uiScale',
    'sidebarVisible',
    'panelVisible',
    'statusVisible',
    'editor',
    'channel',
  ]
  for (const k of keys) {
    if (k === 'editor') {
      if (before.editor.command !== after.editor.command) out.push('editor')
      else if (before.editor.args !== after.editor.args) out.push('editor')
      continue
    }
    if (before[k] !== after[k]) out.push(k)
  }
  return out
}

/**
 * Whether the given set of changes needs an app restart.
 *
 * Exposed separately from changedFields() so the caller can decide *when* to
 * ask: the window should prompt on save, not on every keystroke.
 */
export function needsRestart(changes: readonly SettingsField[]): boolean {
  return changes.some((f) => RESTART_REQUIRED_FIELDS.includes(f))
}
