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
  /**
   * Inject padding CSS into the dsh page so its content reflows out from
   * under the overlay instead of being covered by it.
   *
   * The overlay views cannot shrink the page's own webContents (Electron keeps
   * it outside contentView.children), so CSS padding is the only way to avoid
   * covering content. If it ever causes layout trouble for a particular dsh
   * build, the user can switch it off from the menu and get plain overlay.
   */
  avoidCss: boolean
  /** Left file/git sidebar shown at all. */
  sidebarVisible: boolean
  /** Sidebar width in px. */
  sidebarWidth: number
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
  // Starts hidden: the user asked for the panel to be openable from the menu
  // rather than permanently docked, which also means it cannot occlude the dsh
  // UI before it is wanted.
  visible: false,
  width: 340,
  monitorHeight: 220,
  statusVisible: true,
  avoidCss: true,
  // Starts hidden, same reasoning as the panel: it is opened from the menu,
  // and must not cover the dsh UI before it is asked for.
  sidebarVisible: false,
  sidebarWidth: 280,
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
