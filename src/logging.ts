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
 * - a SEPARATE ring buffer for backend output (last 500 lines) that the
 *   monitor panel streams from; see subscribeBackend()
 */
import { mkdirSync, appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { redactTokenInText } from './redact.js'

export type LogName = 'launcher' | 'wizard' | 'backend' | 'fatal'

/** `--debug` / DSH_DEBUG=1 → child processes show real terminals. */
export function isDebug(): boolean {
  return process.argv.includes('--debug') || process.env.DSH_DEBUG === '1'
}

/**
 * Re-exported so existing call sites keep working; the implementation lives in
 * src/redact.ts (zero dependencies, unit-tested).
 *
 * WHY IT IS APPLIED HERE rather than at call sites: a caller that forgets to
 * redact leaks silently. `appendChildOutput()` below applies it to every
 * backend chunk on BOTH stdout and stderr. The previous arrangement redacted
 * inline at the stdout call site in launcher.ts and left stderr raw.
 */
export { redactTokenInText } from './redact.js'

const MAX_BYTES = 2 * 1024 * 1024
const RING_LIMIT = 300

/** How many backend lines the monitor panel can scroll back through. */
const BACKEND_RING_LIMIT = 500

/** One line of backend (dsh web) output, already token-redacted. */
export interface BackendLine {
  /** Epoch ms when the chunk arrived. */
  ts: number
  /** `err` for chunks prefixed `[ERR]`, otherwise `out`. */
  stream: 'out' | 'err'
  /** The line text, without its trailing newline. */
  text: string
}

let logDir = ''
const ring: { name: LogName; ts: string; line: string }[] = []

// ── Backend output feed ──
//
// Deliberately separate from `ring` above: `log()` feeds the mixed ring used by
// the wizard/error dialogs, while this one carries ONLY backend output and
// supports live subscription so the monitor panel does not have to poll the
// log file.
const backendRing: BackendLine[] = []
const backendSubs = new Set<(line: BackendLine) => void>()

/**
 * Subscribe to backend output. Returns an unsubscribe function — callers MUST
 * invoke it when the panel closes, otherwise every chunk keeps invoking a
 * dead listener for the lifetime of the process.
 */
export function subscribeBackend(cb: (line: BackendLine) => void): () => void {
  backendSubs.add(cb)
  return () => {
    backendSubs.delete(cb)
  }
}

/** Snapshot of the last N backend lines (oldest first). */
export function getBackendLines(n = 200): BackendLine[] {
  if (n >= backendRing.length) return backendRing.slice()
  return backendRing.slice(backendRing.length - n)
}

/** Drop buffered backend state. Used when the backend is restarted. */
export function clearBackendLines(): void {
  backendRing.length = 0
}

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
  for (const cb of logSubs) {
    try {
      cb(name, ts, line)
    } catch { /* listener teardown races are expected; keep logging */ }
  }
  try {
    const file = join(dir(), `${name}.log`)
    rotateIfNeeded(file)
    appendFileSync(file, `${line}\n`, 'utf-8')
  } catch { /* best-effort */ }
}

/**
 * Raw child-process output chunk (no timestamp wrapping).
 *
 * For the `backend` stream this is also the single funnel for the monitor
 * panel: it redacts the token, appends to the line ring, and notifies live
 * subscribers. Keeping all three here means a new output source cannot forget
 * to redact.
 */
export function appendChildOutput(name: LogName, chunk: string): void {
  const safe = name === 'backend' ? redactTokenInText(chunk) : chunk

  try {
    const file = join(dir(), `${name}.log`)
    rotateIfNeeded(file)
    appendFileSync(file, safe, 'utf-8')
  } catch { /* ignore */ }

  if (name !== 'backend') return

  for (const raw of safe.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const line: BackendLine = {
      ts: Date.now(),
      stream: raw.startsWith('[ERR]') ? 'err' : 'out',
      text: raw,
    }
    backendRing.push(line)
    if (backendRing.length > BACKEND_RING_LIMIT) backendRing.shift()

    // One bad listener must not break the feed for everyone else.
    for (const cb of backendSubs) {
      try {
        cb(line)
      } catch { /* listener teardown races are expected; keep pushing */ }
    }
  }
}

/** Last N ring-buffer lines, prefixed with the source log name. */
export function getRecentLines(n = 50): string[] {
  return ring.slice(-n).map((r) => `[${r.name}] ${r.line}`)
}

// ── Mixed shell-log feed ──
//
// The `ring` above had no subscription path: only backend output supported
// live push (subscribeBackend). The bottom log panel merges both feeds, so
// shell lines (launcher / wizard / fatal) need the same push affordance.
const logSubs = new Set<(name: LogName, ts: string, line: string) => void>()

/**
 * Subscribe to shell log lines as they are written via log(). Returns an
 * unsubscribe function — the same teardown contract as subscribeBackend().
 * Lines arrive in the exact shape getRecentLines() produces so a subscriber
 * can replay a snapshot and then apply live lines without re-parsing.
 */
export function subscribeLog(cb: (name: LogName, ts: string, line: string) => void): () => void {
  logSubs.add(cb)
  return () => {
    logSubs.delete(cb)
  }
}

/** Absolute path of the logs directory. */
export function getLogDir(): string {
  return dir()
}

/** Absolute path of a specific log file. */
export function getLogFile(name: LogName): string {
  return join(dir(), `${name}.log`)
}
