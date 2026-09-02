/**
 * User preferences persistence.
 * Stores a small JSON file at ~/.dsh/studio-prefs.json.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { recoveryGuide, type ChannelId } from './channels.js'
// Type-only: external-editor.ts imports Electron, and preferences must stay
// loadable in pure-node contexts (tests).
import type { EditorConfig } from './external-editor.js'

/**
 * Panel font size steps, as multipliers on the `--fs-scale` CSS variable that
 * every shell page derives its type scale from (see panel.html).
 *
 * The shell does NOT use `setZoomFactor`: that scales the page's own layout
 * too, so a 1.3 zoom would push the resizer, the drag handles and the
 * fixed-height headers out of alignment with the window. Scaling only the
 * font variables leaves the geometry untouched.
 *
 * Ordered smallest → largest; `UI_SCALES[1]` (1) is the default.
 */
export const UI_SCALES = [0.85, 1, 1.15, 1.3] as const
export type UiScale = (typeof UI_SCALES)[number]

/** Menu labels for the steps above, same order. */
const UI_SCALE_LABELS: Record<UiScale, string> = {
  0.85: '更小',
  1: '标准',
  1.15: '较大',
  1.3: '特大',
}

/**
 * Coerce whatever is in the prefs file into a supported step.
 *
 * The file is hand-editable JSON, and an out-of-range value (or a string, or
 * `null`) would otherwise be interpolated straight into the injected CSS —
 * `--fs-scale: 0` renders every panel blank, which is indistinguishable from
 * a crash. Nearest legal step is used so an unusual hand-typed value still
 * lands on something readable.
 */
export function normalizeUiScale(value: unknown): UiScale {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1
  let best: UiScale = 1
  let bestDist = Infinity
  for (const s of UI_SCALES) {
    const d = Math.abs(s - n)
    if (d < bestDist) { bestDist = d; best = s }
  }
  return best
}

/** Human-readable label for a scale step, used by the 视图 menu. */
export function uiScaleLabel(scale: UiScale): string {
  return UI_SCALE_LABELS[scale] ?? '标准'
}

/** Geometry + visibility of the overlay panel and status bar. */
export interface PanelPrefs {
  /** Right-hand panel shown at all. */
  visible: boolean
  /** Panel width in px. */
  width: number
  /** Height of the monitor section inside the panel (splitter position). */
  monitorHeight: number
  /** Bottom status bar shown. */
  statusVisible: boolean
  /** Bottom log bar shown (off by default — the right panel already streams backend output). */
  logbarVisible: boolean
  /** Height of the bottom log bar in px. */
  logbarHeight: number
  /** Left file/git sidebar shown at all. */
  sidebarVisible: boolean
  /** Sidebar width in px. */
  sidebarWidth: number
  /**
   * Multiplier on the shell's font size (one of UI_SCALES). Applied by
   * injecting `--fs-scale` into every shell page, not by zooming the views.
   */
  uiScale: UiScale
}

interface Preferences {
  themeId: string
  skipUpdateOnNetworkError: boolean
  lastUpdateCheck: number
  windowBounds: { x?: number; y?: number; width: number; height: number }
  /**
   * Upstream release channel to follow: 'stable' | 'next' | 'canary' | 'alpha'.
   * The DSH_CHANNEL environment variable overrides this (see channels.ts).
   */
  channel?: string
  /**
   * Channels whose risk warning the user has already acknowledged, keyed by
   * channel id with the version acknowledged. Re-acknowledged when the
   * channel resolves to a different version.
   */
  channelRiskAck?: Record<string, string>
  /**
   * Plugin-market decision, persisted so the ask is shown only once:
   *  - unset        → never asked; prompt after the main window loads
   *  - choice=skip  → user chose not to install; never ask again
   *  - choice=yes   → user wants it; install now (or retry after a failure)
   *  - choice=done  → verified installed
   */
  pluginMarket?: {
    choice?: 'skip' | 'yes' | 'done'
    installedAt?: string
    lastError?: string
  }
  /** Right panel + status bar geometry. */
  panel?: PanelPrefs
  /**
   * Editor used when the user clicks a file path. Empty `command` means "use
   * the OS file association".
   */
  externalEditor?: EditorConfig
}

/** Sensible starting geometry for the panel. */
export const DEFAULT_PANEL_PREFS: PanelPrefs = {
  // The panel starts visible. It is a first-class piece of the IDE shell,
  // not a popup the user has to remember exists. Still toggleable from the
  // menu — the default is "on", not "pinned".
  visible: true,
  // Slightly narrower than the prior 340: it had been squeezing the chat
  // column on 1280-wide windows. 320 leaves ~960px for the dsh webview
  // (sidebar 240 + panel 320 + chat ~720).
  width: 320,
  monitorHeight: 220,
  statusVisible: true,
  // The log bar starts hidden: the right panel already streams backend output,
  // so a permanent bottom strip would be duplicate pixels for most users. It
  // is one menu click away (视图 → 日志面板) and the choice persists.
  logbarVisible: false,
  // Fits a header row plus ~7 log lines at the 13px type scale without
  // demanding it — LOGBAR_MIN/MAX_HEIGHT clamp the drawn value either way.
  logbarHeight: 180,
  // The page, sidebar and panel are three real columns (see
  // layout-geometry.ts): the page is bounded to whatever space the overlays
  // leave, so opening the sidebar narrows the page instead of covering it.
  // 240px is the VS Code-ish default — enough for a path column plus a git
  // status badge without dominating a 1280-wide window.
  sidebarVisible: true,
  sidebarWidth: 240,
  // Baseline for the enlarged type scale (13px body, was 11px). The 0.85/1.15/
  // 1.3 steps let the user tune it without a rebuild — the previous fixed
  // 10–11px was reported as too small to read, and "how small is too small" is
  // exactly the kind of thing worth leaving to the person looking at it.
  uiScale: 1,
}

const DEFAULTS: Preferences = {
  themeId: 'default',
  skipUpdateOnNetworkError: false,
  lastUpdateCheck: 0,
  windowBounds: { width: 1280, height: 800 },
}

const PREFS_DIR = join(homedir(), '.dsh')
const PREFS_FILE = join(PREFS_DIR, 'studio-prefs.json')
/** Written next to the prefs so it stays findable when the app will not start. */
const RECOVERY_FILE = join(PREFS_DIR, 'RECOVERY.md')

/** Directory holding user-level shell state (~/.dsh). */
export function dshDir(): string {
  return PREFS_DIR
}

/** Absolute path of the preferences file (shown in recovery instructions). */
export function prefsPath(): string {
  return PREFS_FILE
}

function ensureDir() {
  try { mkdirSync(PREFS_DIR, { recursive: true }) } catch { /* exists */ }
}

export function loadPreferences(): Preferences {
  try {
    const raw = readFileSync(PREFS_FILE, 'utf-8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePreferences(prefs: Partial<Preferences>) {
  ensureDir()
  const current = loadPreferences()
  const merged = { ...current, ...prefs }
  writeFileSync(PREFS_FILE, JSON.stringify(merged, null, 2), 'utf-8')
}

/**
 * Panel geometry with defaults applied per field.
 *
 * Merged field-by-field rather than whole-object so that adding a new panel
 * setting later does not wipe out the geometry the user already saved.
 */
/**
 * Coerce a numeric pref, falling back to the default when it is missing or not
 * a finite number.
 *
 * The file is hand-editable JSON sitting next to the user's other dotfiles, and
 * a `null` or a string where a width is expected flows straight into
 * `WebContentsView.setBounds()`, which does not accept NaN. Sanitising at the
 * boundary is cheaper than a guard at every one of the call sites.
 */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function loadPanelPrefs(): PanelPrefs {
  const p = loadPreferences().panel
  const merged = { ...DEFAULT_PANEL_PREFS, ...(p ?? {}) }
  return {
    ...merged,
    width: num(merged.width, DEFAULT_PANEL_PREFS.width),
    monitorHeight: num(merged.monitorHeight, DEFAULT_PANEL_PREFS.monitorHeight),
    sidebarWidth: num(merged.sidebarWidth, DEFAULT_PANEL_PREFS.sidebarWidth),
    logbarHeight: num(merged.logbarHeight, DEFAULT_PANEL_PREFS.logbarHeight),
    uiScale: normalizeUiScale(merged.uiScale),
  }
}

/** Persist a partial change to the panel geometry. */
export function savePanelPrefs(patch: Partial<PanelPrefs>): void {
  savePreferences({ panel: { ...loadPanelPrefs(), ...patch } })
}

/** The configured external editor, or undefined to use the OS default. */
export function loadExternalEditor(): EditorConfig | undefined {
  return loadPreferences().externalEditor
}

/** Persist the external editor choice. */
export function saveExternalEditor(config: EditorConfig): void {
  savePreferences({ externalEditor: config })
}

/**
 * (Re)write ~/.dsh/RECOVERY.md with channel-specific recovery instructions.
 *
 * Only meaningful for the risky channels — for stable/next the file is
 * removed so a stale one cannot mislead. Purely best-effort: a failure to
 * write a help file must never block a channel switch.
 *
 * @returns the file path written, or '' when it was removed / not applicable.
 */
export function writeRecoveryGuide(
  channelId: ChannelId,
  opts: { logDir: string; risky: boolean }
): string {
  try {
    if (!opts.risky) {
      try { rmSync(RECOVERY_FILE, { force: true }) } catch { /* absent */ }
      return ''
    }
    ensureDir()
    const text = recoveryGuide(channelId, { prefsFile: PREFS_FILE, logDir: opts.logDir })
    writeFileSync(RECOVERY_FILE, text, 'utf-8')
    return RECOVERY_FILE
  } catch {
    return ''
  }
}

/** Absolute path of the recovery guide, whether or not it currently exists. */
export function recoveryGuidePath(): string {
  return RECOVERY_FILE
}

/**
 * Whether a recovery guide is on disk right now.
 * Only the risky channels keep one; its presence is a reliable signal that
 * the app is running a prerelease that may break plugins.
 */
export function hasRecoveryGuide(): boolean {
  return existsSync(RECOVERY_FILE)
}
