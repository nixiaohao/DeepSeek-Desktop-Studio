/**
 * logging.ts — Unified log system for the shell.
 *
 * Four log files under %APPDATA%\deepseek-studio\logs\:
 *   launcher.log — startup decisions, update checks, lifecycle
 *   wizard.log   — initialization wizard steps
 *   backend.log  — dsh web server stdout/stderr (raw chunks)
 *   fatal.log    — uncaught exceptions / unhandled rejections
 *
 * - 2MB rotation (older copy kept as <name>.log.1)
 * - in-memory ring buffer (last 300 lines) so the wizard / error panels
 *   can render recent output without re-reading files
 */
import { mkdirSync, appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export type LogName = 'launcher' | 'wizard' | 'backend' | 'fatal'

/** `--debug` / DSH_DEBUG=1 → child processes show real terminals. */
export function isDebug(): boolean {
  return process.argv.includes('--debug') || process.env.DSH_DEBUG === '1'
}

const MAX_BYTES = 2 * 1024 * 1024
const RING_LIMIT = 300

let logDir = ''
const ring: { name: LogName; ts: string; line: string }[] = []

function dir(): string {
  if (!logDir) {
    logDir = join(app.getPath('userData'), 'logs')
    try { mkdirSync(logDir, { recursive: true }) } catch { /* ignore */ }
  }
  return logDir
}

function rotateIfNeeded(file: string): void {
  try {
    const st = statSync(file)
    if (st.size > MAX_BYTES) renameSync(file, `${file}.1`)
  } catch { /* file missing or stat failed */ }
}

/** Timestamped structured log line (used by launcher / wizard / fatal). */
export function log(name: LogName, msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}`
  ring.push({ name, ts, line })
  if (ring.length > RING_LIMIT) ring.shift()
  try {
    const file = join(dir(), `${name}.log`)
    rotateIfNeeded(file)
    appendFileSync(file, `${line}\n`, 'utf-8')
  } catch { /* best-effort */ }
}

/** Raw child-process output chunk (no timestamp wrapping). */
export function appendChildOutput(name: LogName, chunk: string): void {
  try {
    const file = join(dir(), `${name}.log`)
    rotateIfNeeded(file)
    appendFileSync(file, chunk, 'utf-8')
  } catch { /* ignore */ }
}

/** Last N ring-buffer lines, prefixed with the source log name. */
export function getRecentLines(n = 50): string[] {
  return ring.slice(-n).map((r) => `[${r.name}] ${r.line}`)
}

/** Absolute path of the logs directory. */
export function getLogDir(): string {
  return dir()
}

/** Absolute path of a specific log file. */
export function getLogFile(name: LogName): string {
  return join(dir(), `${name}.log`)
}
