/**
 * Theme engine — loads CSS theme files and injects them into BrowserWindow.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { loadPreferences } from './preferences.js'

interface ThemeEntry {
  id: string
  name: string
  description: string
  file: string
  colorScheme: 'light' | 'dark'
}

const THEMES_DIR = join(app.getAppPath(), 'themes')

function loadThemeRegistry(): ThemeEntry[] {
  try {
    const raw = readFileSync(join(THEMES_DIR, 'themes.json'), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return [{ id: 'default', name: 'DeepSeek Dark', description: '', file: 'default.css', colorScheme: 'dark' }]
  }
}

/** Load the CSS content for the currently selected theme */
export function loadCurrentThemeCSS(): string {
  const prefs = loadPreferences()
  const themes = loadThemeRegistry()
  const theme = themes.find(t => t.id === prefs.themeId) ?? themes[0]
  if (!theme) return ''

  try {
    return readFileSync(join(THEMES_DIR, theme.file), 'utf-8')
  } catch {
    return ''
  }
}

/** List available themes (for settings UI) */
export function listThemes(): ThemeEntry[] {
  return loadThemeRegistry()
}
