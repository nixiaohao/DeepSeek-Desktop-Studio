/**
 * env-detector.ts — Cross-platform environment detection.
 *
 * Finds system Node.js / git / pnpm, parses versions, and kills port
 * listeners in a platform-agnostic way. Used by the runtime-source mode
 * so the packaged app no longer depends on hard-coded Windows paths.
 */
import { execFileSync, execSync } from 'node:child_process'
import { platform, homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

// ── Types ──

export interface ToolInfo {
  found: boolean
  /** Absolute path to the binary (or the bare command name if lookup failed) */
  path: string
  /** Raw version string, e.g. "v22.12.0" */
  version: string
  /** Parsed [major, minor, patch] */
  semver: [number, number, number] | null
}

/** Minimum Node version required by the official harness (see root package.json engines) */
export const MIN_NODE: [number, number, number] = [22, 19, 0]

// ── Version helpers ──

export function parseVersion(raw: string): [number, number, number] | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null
}

export function gte(v: [number, number, number], target: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] > target[i]) return true
    if (v[i] < target[i]) return false
  }
  return true
}

// ── Low-level lookup ──

function runVersion(cmd: string, args: string[]): string {
  try {
    const useShell = platform() === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return ''
  }
}

/** Every PATH match for a binary (`where`/`which` return multiple hits). */
function whichAll(bin: string): string[] {
  try {
    const out = execFileSync(platform() === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function which(bin: string): string {
  return whichAll(bin)[0] ?? ''
}

/**
 * Normalize a Windows pnpm lookup to an executable form.
 * `where pnpm` may return the extension-less shim (e.g. C:\npm\pnpm) that
 * execFileSync cannot spawn; prefer the .cmd / .exe sibling when present.
 */
function normalizePnpmShim(p: string): string {
  if (platform() !== 'win32' || /\.(cmd|bat|exe|ps1)$/i.test(p)) return p
  const cmdSibling = `${p}.cmd`
  if (existsSync(cmdSibling)) return cmdSibling
  const exeSibling = `${p}.exe`
  if (existsSync(exeSibling)) return exeSibling
  return p
}

/** Check a concrete absolute path: does the binary exist and answer a version query? */
function probePath(candidate: string, versionArgs: string[]): ToolInfo | null {
  if (!candidate || !existsSync(candidate)) return null
  const version = runVersion(candidate, versionArgs)
  if (!version) return null
  return { found: true, path: candidate, version, semver: parseVersion(version) }
}

/** Platform-specific candidate paths for node.exe / node */
const NODE_CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\nodejs\\node.exe',
    join(process.env.APPDATA ?? '', 'nvm', 'current', 'node.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
  ],
  darwin: [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/opt/local/bin/node',
    join(process.env.HOME ?? '', '.nvm', 'versions', 'node'),
  ],
  linux: [
    '/usr/bin/node',
    '/usr/local/bin/node',
    join(process.env.HOME ?? '', '.nvm', 'versions', 'node'),
    join(process.env.HOME ?? '', '.local', 'share', 'node'),
  ],
}

function findNodeCandidates(): string[] {
  const candidates: string[] = []
  for (const base of NODE_CANDIDATES[platform()] ?? []) {
    if (platform() !== 'win32') {
      // nvm version dirs contain node-<ver>/bin/node
      if (existsSync(base) && !base.endsWith('/node')) {
        try {
          const { readdirSync } = require('node:fs') as typeof import('node:fs')
          const subs = readdirSync(base, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name.startsWith('node-'))
            .map((d) => join(base, d.name, 'bin', 'node'))
          candidates.push(...subs)
        } catch { /* ignore */ }
      }
    }
    candidates.push(base)
  }
  return candidates
}

// ── Public detectors ──

export function detectNode(): ToolInfo {
  // 1. Registry (Windows): HKLM\SOFTWARE\Node.js\InstallPath
  if (platform() === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Node.js', '/v', 'InstallPath'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const m = out.match(/InstallPath\s+REG_SZ\s+(.+)/i)
      if (m) {
        const hit = probePath(join(m[1].trim(), 'node.exe'), ['--version'])
        if (hit) return hit
      }
    } catch { /* registry missing */ }
  }

  // 2. Known candidate paths
  for (const candidate of findNodeCandidates()) {
    const hit = probePath(candidate, ['--version'])
    if (hit) return hit
  }

  // 3. PATH lookup
  const path = which(platform() === 'win32' ? 'node.exe' : 'node')
  if (path) {
    const hit = probePath(path, ['--version'])
    if (hit) return hit
  }

  return { found: false, path: '', version: '', semver: null }
}

export function detectGit(): ToolInfo {
  const bin = platform() === 'win32' ? 'git.exe' : 'git'
  const path = which(bin)
  if (path) {
    const hit = probePath(path, ['--version'])
    if (hit) return hit
  }
  const fallbacks = platform() === 'win32'
    ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']
  for (const fb of fallbacks) {
    const hit = probePath(fb, ['--version'])
    if (hit) return hit
  }
  return { found: false, path: '', version: '', semver: null }
}

/** Read `prefix=` lines from npmrc files without invoking npm. */
function readNpmrcPrefixes(): string[] {
  const prefixes: string[] = []
  const files: string[] = []
  if (platform() === 'win32') {
    files.push(
      join(homedir(), '.npmrc'),
      join(process.env.ProgramData ?? 'C:\\ProgramData', 'npm', 'npmrc'),
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'npmrc')
    )
  } else {
    files.push(
      join(homedir(), '.npmrc'),
      '/etc/npmrc',
      '/usr/local/etc/npmrc'
    )
  }
  for (const file of files) {
    try {
      const raw = readFileSync(file, 'utf-8')
      const m = /^prefix\s*=\s*(.+)$/im.exec(raw)
      if (m) {
        const val = m[1].trim().replace(/^["']|["']$/g, '')
        if (val) prefixes.push(val)
      }
    } catch { /* missing or unreadable */ }
  }
  return prefixes
}

export function detectPnpm(): ToolInfo {
  const isWin = platform() === 'win32'

  // 1. PATH lookup — iterate EVERY match so a broken shim early on PATH does
  //    not shadow a working pnpm later in the list.
  for (const raw of whichAll(isWin ? 'pnpm' : 'pnpm')) {
    const hit = probePath(normalizePnpmShim(raw), ['--version'])
    if (hit) return hit
  }

  // 2. npm global prefix from running npm
  try {
    const npmBin = isWin ? 'npm.cmd' : 'npm'
    const prefix = execFileSync(npmBin, ['config', 'get', 'prefix'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      shell: isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (prefix) {
      const candidate = isWin ? join(prefix, 'pnpm.cmd') : join(prefix, 'bin', 'pnpm')
      const hit = probePath(candidate, ['--version'])
      if (hit) return hit
    }
  } catch { /* npm missing */ }

  // 3. npm prefix from .npmrc files (works even when npm is not on PATH)
  for (const prefix of readNpmrcPrefixes()) {
    const candidate = isWin ? join(prefix, 'pnpm.cmd') : join(prefix, 'bin', 'pnpm')
    const hit = probePath(candidate, ['--version'])
    if (hit) return hit
  }

  // 4. PNPM_HOME — set by the official standalone installer
  const pnpmHome = process.env.PNPM_HOME?.trim()
  if (pnpmHome) {
    const candidates = isWin
      ? [join(pnpmHome, 'pnpm.cmd'), join(pnpmHome, 'pnpm.exe')]
      : [join(pnpmHome, 'pnpm')]
    for (const candidate of candidates) {
      const hit = probePath(candidate, ['--version'])
      if (hit) return hit
    }
  }

  // 5. Common installation paths: npm global, corepack, standalone installer,
  //    version managers (nvm-windows / Volta / scoop / chocolatey / asdf / fnm)
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const common = isWin
    ? [
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'pnpm.cmd'),
        join(homedir(), 'AppData', 'Roaming', 'npm', 'pnpm.cmd'),
        // Official standalone installer (default: %LOCALAPPDATA%\pnpm)
        join(localAppData, 'pnpm', 'pnpm.cmd'),
        join(localAppData, 'pnpm', 'pnpm.exe'),
        // corepack shims live next to the nodejs install
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'corepack', 'pnpm.cmd'),
        join(localAppData, 'node', 'corepack', 'pnpm.cmd'),
        // Version managers
        join(process.env.APPDATA ?? '', 'nvm', 'current', 'pnpm.cmd'),
        join(localAppData, 'Volta', 'bin', 'pnpm.cmd'),
        join(homedir(), '.volta', 'bin', 'pnpm.cmd'),
        join(homedir(), 'scoop', 'apps', 'pnpm', 'current', 'pnpm.exe'),
        'C:\\ProgramData\\chocolatey\\bin\\pnpm.exe',
      ]
    : [
        '/usr/local/bin/pnpm',
        '/usr/bin/pnpm',
        '/opt/homebrew/bin/pnpm',
        join(homedir(), '.local', 'bin', 'pnpm'),
        // Official standalone installer on macOS/Linux
        join(homedir(), '.local', 'share', 'pnpm', 'pnpm'),
        join(homedir(), '.volta', 'bin', 'pnpm'),
        join(homedir(), '.asdf', 'shims', 'pnpm'),
        join(homedir(), '.fnm', 'aliases', 'default', 'bin', 'pnpm'),
      ]
  for (const candidate of common) {
    const hit = probePath(candidate, ['--version'])
    if (hit) return hit
  }

  // 6. nvm (Linux/macOS) managed installs: ~/.nvm/versions/node/<ver>/bin/pnpm
  if (!isWin) {
    const nvmBase = join(homedir(), '.nvm', 'versions', 'node')
    try {
      const { readdirSync } = require('node:fs') as typeof import('node:fs')
      const dirs = readdirSync(nvmBase, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('node-'))
        .sort()
        .reverse()
      for (const d of dirs) {
        const hit = probePath(join(nvmBase, d.name, 'bin', 'pnpm'), ['--version'])
        if (hit) return hit
      }
    } catch { /* no nvm installs */ }
  }

  return { found: false, path: '', version: '', semver: null }
}

/**
 * Choose the Node binary used to run the official harness source.
 * Prefers a system node >= 22.19; falls back to Electron's embedded Node
 * (which requires ELECTRON_RUN_AS_NODE=1 when spawned via process.execPath).
 */
export function resolveNodeBin(): { path: string; useElectron: boolean } {
  const sys = detectNode()
  if (sys.found && sys.semver && gte(sys.semver, MIN_NODE)) {
    return { path: sys.path, useElectron: false }
  }
  if (sys.found) {
    // System node exists but too old — still prefer it over Electron's embedded
    // node (Electron 33 ships Node 20.18, which is below the engines floor).
    return { path: sys.path, useElectron: false }
  }
  return { path: process.execPath, useElectron: true }
}

// ── Port killer (cross-platform) ──

/**
 * Kill any process listening on the given port.
 * Prevents "port already in use" on second launch.
 */
export function killPort(port: number): void {
  if (platform() === 'win32') {
    killPortWindows(port)
  } else {
    killPortUnix(port)
  }
}

function killPortWindows(port: number): void {
  try {
    const output = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
    }).trim()
    if (!output) return
    const pids = new Set<string>()
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/)
      const pid = parts[parts.length - 1]
      if (pid && /^\d+$/.test(pid)) pids.add(pid)
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F /T`, { windowsHide: true, timeout: 5000 })
      } catch { /* process may have already exited */ }
    }
  } catch { /* netstat/findstr may fail, ignore */ }
}

function killPortUnix(port: number): void {
  try {
    const output = execSync(`lsof -ti :${port}`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (!output) return
    for (const pid of output.split(/\s+/).filter(Boolean)) {
      try {
        execSync(`kill -9 ${pid}`, { timeout: 5000, stdio: 'ignore' })
      } catch { /* process may have already exited */ }
    }
  } catch { /* lsof missing or no listener, ignore */ }
}

/**
 * Force-kill a process and its ENTIRE descendant tree.
 *
 * A bare `child.kill()` on Windows only terminates the direct child — the
 * harness backend spawns grandchildren (web server, workers) that would
 * otherwise survive as orphans and keep file handles / the port busy.
 * Windows uses `taskkill /T` (tree kill); other platforms use SIGKILL.
 */
export function killProcessTree(pid: number): void {
  if (platform() === 'win32') {
    try {
      execSync(`taskkill /PID ${pid} /F /T`, {
        windowsHide: true,
        timeout: 8000,
        stdio: 'ignore',
      })
      return
    } catch { /* taskkill unavailable — fall through to direct kill */ }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* process already gone */ }
}

// ── PATH helpers ──

/** Join path entries using the platform delimiter and dedupe. */
export function buildPath(...segments: (string | undefined)[]): string {
  const parts = segments.filter((s): s is string => !!s)
  const existing = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const seen = new Set<string>()
  const merged: string[] = []
  for (const p of [...parts, ...existing]) {
    if (!seen.has(p)) {
      seen.add(p)
      merged.push(p)
    }
  }
  return merged.join(delimiter)
}
