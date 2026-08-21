/**
 * workspace.ts — Workspace resolution for the packaged app.
 *
 * The harness source lives in a folder the USER controls, never inside the
 * asar and never in any hard-coded dev path:
 *
 *   1. source-dir.txt override   (%APPDATA%\deepseek-studio\source-dir.txt)
 *   2. <exe dir>\deepseek-harness   (default; portable exe dir via
 *                                    PORTABLE_EXECUTABLE_DIR)
 *   3. <userData>\workspace\deepseek-harness  (fallback when exe dir is
 *                                              not writable)
 *
 * Portable note: electron-builder's portable target sets
 * PORTABLE_EXECUTABLE_DIR to the ORIGINAL location of the exe (it actually
 * runs from a temp dir), so that env var is the correct anchor — using
 * app.getPath('exe') directly would point into the temp extraction dir.
 */
import { app } from 'electron'
import { resolve, dirname } from 'node:path'
import { existsSync, mkdirSync, accessSync, constants, readFileSync } from 'node:fs'

export const WORKSPACE_DIRNAME = 'deepseek-harness'

export interface WorkspaceInfo {
  /** Absolute path of the harness source directory */
  dir: string
  /** The directory already exists on disk */
  existed: boolean
  /** Looks like a harness checkout (root package.json + pnpm-workspace.yaml + packages/) */
  hasSource: boolean
  /** node_modules present (loose check: .pnpm or .bin exists) */
  depsInstalled: boolean
  /** Directory is creatable / writable */
  writable: boolean
  /** True when the initialization wizard must run (no source yet) */
  needsWizard: boolean
}

/** The directory the user placed the exe in (portable-aware). */
export function getExeDir(): string {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR
  return dirname(app.getPath('exe'))
}

/**
 * A dir counts as a harness source when the official repo markers exist:
 * root package.json + pnpm-workspace.yaml + packages/ (the harness core).
 * NOTE: the top-level shell/ dir is OUR Electron shell (a separate project),
 * NOT part of the official repo — it must not be required here.
 */
export function hasHarnessSource(dir: string): boolean {
  return (
    existsSync(resolve(dir, 'package.json')) &&
    existsSync(resolve(dir, 'pnpm-workspace.yaml')) &&
    existsSync(resolve(dir, 'packages'))
  )
}

function depsInstalled(dir: string): boolean {
  return existsSync(resolve(dir, 'node_modules', '.pnpm')) || existsSync(resolve(dir, 'node_modules', '.bin'))
}

function isWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function readSourceDirOverride(): string {
  try {
    const p = resolve(app.getPath('userData'), 'source-dir.txt')
    const saved = readFileSync(p, 'utf-8').trim()
    return saved || ''
  } catch {
    return ''
  }
}

function inspect(dir: string): WorkspaceInfo {
  const existed = existsSync(dir)
  const source = hasHarnessSource(dir)
  return {
    dir,
    existed,
    hasSource: source,
    depsInstalled: depsInstalled(dir),
    writable: isWritable(dir),
    needsWizard: !source,
  }
}

/**
 * Resolve the workspace directory following the priority chain above.
 * Also returns status flags used by the wizard / launcher.
 */
export function resolveWorkspace(): WorkspaceInfo {
  // 1. Explicit override
  const override = readSourceDirOverride()
  if (override) return inspect(resolve(override))

  // 2. exe-side default
  const exeSide = resolve(getExeDir(), WORKSPACE_DIRNAME)
  const primary = inspect(exeSide)
  if (primary.writable || primary.existed) return primary

  // 3. userData fallback (e.g. exe placed in Program Files)
  const fallback = resolve(app.getPath('userData'), 'workspace', WORKSPACE_DIRNAME)
  return inspect(fallback)
}
