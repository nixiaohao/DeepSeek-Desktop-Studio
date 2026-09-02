/**
 * diagnostics-host.ts — Collects the REAL state behind a self-check report.
 *
 * The split from diagnostics.ts is deliberate:
 *
 *   diagnostics.ts       pure — turns data into a report
 *   diagnostics-host.ts  I/O  — goes and gets the data
 *
 * That boundary is what makes the report's wording unit-testable without an
 * Electron process, and it is also what keeps main.ts from growing another
 * hundred lines of gathering code (main.ts is already the file the project
 * rules say not to keep adding to).
 *
 * EVERYTHING HERE IS BEST-EFFORT. The diagnostics window is the thing you open
 * when the app is broken, so a collector that throws when a subsystem is
 * missing would fail precisely when it is needed. Each field degrades to an
 * empty value and the report flags it instead.
 */
import { accessSync, constants, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildReport, tailLines, type DiagnosticsInput, type DiagnosticsReport } from './diagnostics.js'
import { checkEnvironment } from './env-check.js'
// `LogName` is a TYPE in logging.ts, not a value — importing it as a value
// compiles to a runtime require of a non-existent binding.
import { getBackendLines, getLogDir, type LogName as LogNameT } from './logging.js'
import type { HealthSnapshot } from './health-monitor.js'
import type { ViewState } from './diagnostics.js'

/** Lines of each log file shown in the diagnostics window. */
export const LOG_TAIL_LINES = 120

/**
 * Bytes of each log file handed to `tailLines`, which reads from the END of the
 * string. The files are capped at 2 MB by rotation (see logging.ts), so this
 * never has to hold more than that per file for an action the user triggered
 * explicitly.
 */
const LOG_TAIL_BUDGET = 65_536

export type { LogNameT }

export interface LogTail {
  name: LogNameT
  /** Absolute path, so the user can open the file even when reading it failed. */
  path: string
  lines: string[]
  /** Why the file could not be read; absent on success. */
  error?: string
}

export interface DiagnosticsPayload {
  report: DiagnosticsReport
  logs: LogTail[]
  /** Absolute log directory, so the window can offer to open it. */
  logDir: string
}

/** Everything the collector needs that lives outside this module. */
export interface DiagnosticsHostDeps {
  version: () => string
  dsh: () => { version: string; port: number | null; channel: string }
  workspace: () => string
  health: () => HealthSnapshot | null
  healthPhaseLabel: (phase: string) => string
  window: () => { width: number; height: number; visible: boolean } | null
  views: () => Record<string, ViewState>
  /**
   * Injected so the collector can be exercised without a real log directory.
   * Defaults to `readFileSync`.
   */
  readFile?: (abs: string) => string
  /** Defaults to an `accessSync(dir, W_OK)` probe. */
  canWrite?: (dir: string) => boolean
}

function defaultCanWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Read one log file and return its last lines.
 *
 * Each file is independent: a missing or locked `wizard.log` must not stop the
 * other three from being shown, because the one that failed is often the one
 * that would explain the problem.
 */
function tailOf(
  name: LogNameT,
  dir: string,
  read: (abs: string) => string,
): LogTail {
  const abs = join(dir, `${name}.log`)
  try {
    return { name, path: abs, lines: tailLines(read(abs), LOG_TAIL_LINES, LOG_TAIL_BUDGET) }
  } catch (err) {
    return { name, path: abs, lines: [], error: (err as Error).message }
  }
}

export const LOG_NAMES: readonly LogNameT[] = ['launcher', 'wizard', 'backend', 'fatal']

/**
 * Gather everything and assemble the report.
 *
 * Never throws. `checkEnvironment()` spawns `node --version` / `git --version`
 * and is the slowest part, which is why this runs on demand from the
 * diagnostics window rather than on every report refresh.
 */
export function collectDiagnostics(deps: DiagnosticsHostDeps): DiagnosticsPayload {
  const read = deps.readFile ?? ((abs: string) => readFileSync(abs, 'utf-8'))
  const canWrite = deps.canWrite ?? defaultCanWrite

  let logDir = ''
  try {
    logDir = getLogDir()
  } catch {
    logDir = ''
  }

  const health = safe(() => deps.health(), null)
  const window = safe(() => deps.window(), null)
  const views = safe(() => deps.views(), {})
  const dsh = safe(() => deps.dsh(), { version: '', port: null, channel: '' })
  const env = safe(() => checkEnvironment(), [])

  const input: DiagnosticsInput = {
    version: safe(() => deps.version(), ''),
    dsh,
    workspace: safe(() => deps.workspace(), ''),
    logDir,
    logDirWritable: logDir ? safe(() => canWrite(logDir), false) : false,
    uptimeMs: Math.round(process.uptime() * 1000),
    views,
    window,
    health,
    healthPhaseLabel: health ? safe(() => deps.healthPhaseLabel(health.phase), health.phase) : '',
    backendLines: safe(() => getBackendLines().length, 0),
    env,
    now: Date.now(),
  }

  return {
    report: buildReport(input),
    logs: LOG_NAMES.map((name) => tailOf(name, logDir, read)),
    logDir,
  }
}

/**
 * Call a getter that may not be wired up yet and fall back.
 *
 * `registerIpc()` is callable before the app has a window, a workspace or a
 * stream, and the diagnostics window can be opened at any of those points —
 * so most of these genuinely can be missing rather than merely broken.
 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    const value = fn()
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}
