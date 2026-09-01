/**
 * external-editor.ts — hand a file to the user's own editor.
 *
 * The shell deliberately does NOT embed a code editor. Editing stays in the
 * user's real editor (VS Code / Cursor / Notepad++ / whatever they pick); we
 * only bridge the click. That keeps this project a *shell* rather than a
 * half-finished IDE.
 *
 * Two safety notes that drive the implementation:
 *
 *  - `shell: false` ALWAYS. Paths contain spaces and Chinese characters, and
 *    building a command string would be an injection vector.
 *  - The child is spawned detached and unref'd: an editor must outlive this
 *    app and must never keep the Electron main process alive at quit.
 */
import { spawn, execFileSync } from 'node:child_process'
import { dialog, shell, type BrowserWindow } from 'electron'
// A VALUE import, unlike the `import type` used elsewhere in this codebase.
// preferences.ts only type-imports EditorConfig, so there is no runtime cycle
// — and this module (which already depends on Electron) is the natural home
// for the picker that produces and persists the choice.
import { loadExternalEditor, saveExternalEditor } from './preferences.js'

export interface EditorConfig {
  /** Executable name (resolved via PATH) or an absolute path. */
  command: string
  /**
   * Argument template. Placeholders: {file} {line} {col}.
   * Defaults to `{file}` when empty. See EDITOR_PRESETS.
   */
  args?: string
}

export interface OpenResult {
  ok: boolean
  /** Present when ok === false. */
  error?: string
  /** True when no editor was configured and the OS association was used. */
  usedSystemDefault?: boolean
}

export interface EditorPreset {
  id: string
  label: string
  config: EditorConfig
}

/**
 * Presets offered in the menu. `command` is the PATH name so a portable
 * install works; users can also pick an arbitrary .exe via the file dialog.
 *
 * `--goto {file}:{line}` is VS Code / Cursor's jump-to-line form.
 */
export const EDITOR_PRESETS: EditorPreset[] = [
  {
    id: 'code',
    label: 'VS Code',
    config: { command: 'code', args: '--goto {file}:{line}' },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    config: { command: 'cursor', args: '--goto {file}:{line}' },
  },
  {
    id: 'notepadpp',
    label: 'Notepad++',
    config: { command: 'notepad++', args: '-n{line} {file}' },
  },
  {
    id: 'system',
    label: '系统默认程序',
    // Empty command → fall back to the OS file association.
    config: { command: '', args: '' },
  },
]

/**
 * Expand an argument template into a spawn-ready argv.
 *
 * Pure logic (unit tested). The file path stays ONE argv element even when it
 * contains spaces, because we never go through a shell.
 */
export function buildEditorArgs(
  argsTemplate: string | undefined,
  file: string,
  line?: number,
  col?: number
): string[] {
  const tpl = argsTemplate && argsTemplate.trim() ? argsTemplate.trim() : '{file}'
  const out = tpl
    .split(/\s+/)
    .map((tok) =>
      tok
        .replace(/\{file\}/g, file)
        .replace(/\{line\}/g, line && line > 0 ? String(line) : '1')
        .replace(/\{col\}/g, col && col > 0 ? String(col) : '1')
    )
    .filter((tok) => tok.length > 0)

  // Guarantee the file is actually passed, even if the template omitted it.
  //
  // Must be a SUBSTRING test: templates like `{file}:{line}` embed the path
  // inside a larger token (`/a/b.ts:42`), so an exact-match check would append
  // a duplicate path and the editor would open the file twice.
  if (!out.some((tok) => tok.includes(file))) out.push(file)
  return out
}

/** Whether a command resolves on PATH (uses `where` on Windows, `which` else). */
export function isCommandAvailable(command: string): boolean {
  if (!command) return false
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, [command], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Open `file` in the configured editor.
 *
 * Resolves when the editor process has spawned (or definitively failed to).
 * A spawn error (typically ENOENT for an editor that is not installed) is
 * reported so the caller can offer a fallback.
 */
export function openInEditor(
  config: EditorConfig | undefined,
  file: string,
  line?: number,
  col?: number
): Promise<OpenResult> {
  // No editor configured → OS file association.
  if (!config || !config.command.trim()) {
    return shell.openPath(file).then((err) =>
      err ? { ok: false, error: err, usedSystemDefault: true } : { ok: true, usedSystemDefault: true }
    )
  }

  const args = buildEditorArgs(config.args, file, line, col)

  return new Promise<OpenResult>((resolve) => {
    let settled = false
    const done = (r: OpenResult): void => {
      if (settled) return
      settled = true
      resolve(r)
    }

    let child
    try {
      child = spawn(config.command, args, {
        // Never shell:true — see the file header.
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (err) {
      done({ ok: false, error: (err as Error).message })
      return
    }

    child.on('error', (err: Error) => done({ ok: false, error: err.message }))
    // 'spawn' means the process actually started; anything after that is the
    // editor's own business.
    child.on('spawn', () => done({ ok: true }))
    child.unref()
  })
}

// ── Choosing the editor ──

/**
 * Human-readable name for the current configuration, for menu hints.
 *
 * Shows the preset label when it matches one, otherwise the raw command — a
 * custom-picked executable has no friendlier name than its own path.
 */
export function describeEditorConfig(config: EditorConfig | undefined): string {
  if (!config || !config.command.trim()) return '系统默认程序（未配置）'
  const preset = EDITOR_PRESETS.find((p) => p.config.command === config.command)
  return preset ? preset.label : config.command
}

/**
 * Ask the user which editor to use, and persist the answer.
 *
 * Presets are PATH names, so "not installed" is a normal outcome rather than
 * an error: the 浏览… branch exists for editors that are not on PATH (common
 * on Windows), and simply records the absolute path with the generic `{file}`
 * template.
 *
 * Does nothing when the user cancels. The caller is responsible for rebuilding
 * the menu afterwards so its hint line reflects the new choice.
 */
export function pickEditorInteractively(parent: BrowserWindow | null): void {
  const buttons = [...EDITOR_PRESETS.map((p) => p.label), '浏览…', '取消']
  const browseIndex = EDITOR_PRESETS.length
  const cancelIndex = EDITOR_PRESETS.length + 1

  const choice = dialog.showMessageBoxSync(parent ?? undefined!, {
    type: 'question',
    title: '外部编辑器',
    message: '选择用于打开文件的编辑器',
    detail:
      `当前：${describeEditorConfig(loadExternalEditor())}\n\n` +
      `预设会按 PATH 查找命令；如果编辑器不在 PATH 里，选「浏览…」指定可执行文件。`,
    buttons,
    defaultId: 0,
    cancelId: cancelIndex,
  })

  if (choice < 0 || choice >= cancelIndex) return

  if (choice < browseIndex) {
    const preset = EDITOR_PRESETS[choice]
    saveExternalEditor(preset.config)
    return
  }

  const picked = dialog.showOpenDialogSync(parent ?? undefined!, {
    title: '选择编辑器可执行文件',
    properties: ['openFile'],
    // Windows executables are not reliably marked executable, so the extension
    // filter is the only useful hint there.
    filters:
      process.platform === 'win32'
        ? [{ name: '可执行文件', extensions: ['exe', 'cmd', 'bat'] }]
        : [],
  })
  if (!picked || picked.length === 0) return
  saveExternalEditor({ command: picked[0], args: '{file}' })
}
