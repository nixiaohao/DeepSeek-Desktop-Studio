/**
 * User preferences persistence.
 * Stores a small JSON file at ~/.dsh/studio-prefs.json.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { recoveryGuide, type ChannelId } from './channels.js'

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
