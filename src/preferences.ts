/**
 * User preferences persistence.
 * Stores a small JSON file at ~/.dsh/studio-prefs.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

interface Preferences {
  themeId: string
  skipUpdateOnNetworkError: boolean
  lastUpdateCheck: number
  windowBounds: { x?: number; y?: number; width: number; height: number }
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
