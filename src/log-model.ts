/**
 * log-model.ts — pure logic behind the bottom log panel.
 *
 * ZERO-DEPENDENCY ON PURPOSE (see layout-geometry.ts for the full argument):
 * the logbar is the surface the user opens when something looks wrong, so the
 * code that decides what it shows must be testable in plain node and must
 * never be the thing that breaks. All it does is shape data; the feeds live in
 * logging.ts and the push/pull wiring lives in ipc-registry.ts.
 *
 * There are two raw feeds with different shapes:
 *   - the shell ring (logging.getRecentLines): strings formatted
 *     `[<name>] [<ISO date>] <message>` — launcher / wizard / fatal
 *   - the backend ring (logging.getBackendLines): { ts, stream, text }
 *
 * The MAIN PROCESS merges them here (one implementation, unit-tested) and
 * hands the page an already-structured entry list. The page then only filters
 * by source and renders — it never parses log text, so a formatting change in
 * logging.ts cannot silently break the logbar's view.
 */

/** The four log streams the shell keeps (see logging.ts). */
export type LogSource = 'launcher' | 'wizard' | 'backend' | 'fatal'

export const LOG_SOURCES: readonly LogSource[] = ['launcher', 'wizard', 'backend', 'fatal']

/** Chinese labels for the filter chips, keyed by source id. */
export const LOG_SOURCE_LABELS: Record<LogSource, string> = {
  launcher: '启动',
  wizard: '向导',
  backend: '后端',
  fatal: '致命',
}

/** One renderable log line. */
export interface LogEntry {
  source: LogSource
  /** Epoch ms; shell lines carry an ISO string that is parsed here. */
  ts: number
  /** `err` only ever comes from the backend's stderr side. */
  stream: 'out' | 'err'
  /** Display text, without the source prefix. */
  text: string
}

/**
 * Shape of a shell ring line.
 *
 * Anchored on both ends and tolerant of brackets INSIDE the message: the
 * message is everything after the second `] `, whatever it contains. The
 * source group is `[a-z]+` on purpose — a line that does not start with one
 * of the four source names is not a ring line and must be dropped, not
 * guessed (see the unknown-source test).
 */
const SHELL_LINE_RE = /^\[([a-z]+)\] \[([^\]]+)\] (.*)$/s

/**
 * Parse one `getRecentLines()` string into an entry, or null when the line is
 * not a shell ring line. Null — never a throw — because one malformed line
 * must not take down the snapshot the user is looking at while debugging.
 */
export function parseShellLine(line: unknown): LogEntry | null {
  if (typeof line !== 'string') return null
  const m = SHELL_LINE_RE.exec(line)
  if (!m) return null
  const source = m[1] as LogSource
  if (!LOG_SOURCES.includes(source)) return null
  const ts = Date.parse(m[2])
  if (!Number.isFinite(ts)) return null
  return { source, ts, stream: 'out', text: m[3] }
}

/** Adapt one backend ring record to the shared entry shape. */
export function entryFromBackend(line: { ts: number; stream: 'out' | 'err'; text: string }): LogEntry {
  return { source: 'backend', ts: line.ts, stream: line.stream, text: line.text }
}

/**
 * Merge both feeds into the ordered, filtered, capped list the logbar draws.
 *
 * - Sorted oldest → newest. `Array#sort` is stable in every runtime Electron
 *   ships, so lines with identical timestamps keep their arrival order.
 * - `active` is the page's current filter (null = show everything). Unknown
 *   ids simply never match — this is display state from our own page, not
 *   data to validate loudly.
 * - Capped to the LAST `limit` entries AFTER filtering, so switching to a
 *   quiet source still fills the view with that source's recent lines instead
 *   of showing an empty panel because a chatty one ate the budget.
 */
export function buildView(
  shell: readonly unknown[],
  backend: readonly { ts: number; stream: 'out' | 'err'; text: string }[],
  active: readonly LogSource[] | null,
  limit = 400,
): LogEntry[] {
  const entries: LogEntry[] = []
  for (const line of shell) {
    const entry = parseShellLine(line)
    if (entry) entries.push(entry)
  }
  for (const line of backend) entries.push(entryFromBackend(line))
  entries.sort((a, b) => a.ts - b.ts)
  const filtered = active ? entries.filter((e) => active.includes(e.source)) : entries
  return filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered
}
