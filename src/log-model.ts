/**
 * log-model.ts — pure logic behind the bottom log panel.
 *
 * ZERO-DEPENDENCY ON PURPOSE (see layout-geometry.ts for the full argument):
 * the logbar is the surface the user opens when something looks wrong, so the
 * code that decides what it shows must be testable in plain node and must
 * never be the thing that breaks. All it does is shape data; the feeds live in
 * logging.ts and the push/pull wiring lives in ipc-registry.ts.
 *
 * There are three raw feeds with different shapes:
 *   - the shell ring (logging.getRecentLines): strings formatted
 *     `[<name>] [<ISO date>] <message>` — launcher / wizard / fatal
 *   - the backend ring (logging.getBackendLines): { ts, stream, text }
 *   - the agent activity ring (event-store, dsh mux stream): already-shaped
 *     entries for what the agents (main AND subagents) are doing
 *
 * The MAIN PROCESS merges them here (one implementation, unit-tested) and
 * hands the page an already-structured entry list. The page then only filters
 * by source and renders — it never parses log text, so a formatting change in
 * logging.ts cannot silently break the logbar's view.
 */

/** The five log streams the shell keeps (see logging.ts / event-store.ts). */
export type LogSource = 'launcher' | 'wizard' | 'backend' | 'fatal' | 'agent'

export const LOG_SOURCES: readonly LogSource[] = ['launcher', 'wizard', 'backend', 'fatal', 'agent']

/** Chinese labels for the filter chips, keyed by source id. */
export const LOG_SOURCE_LABELS: Record<LogSource, string> = {
  launcher: '启动',
  wizard: '向导',
  backend: '后端',
  fatal: '致命',
  agent: 'Agent',
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
  /**
   * Agent entries only: the session the activity belongs to.
   *
   * Shell/backend lines are per-process, not per-session, so they carry no id
   * and are therefore excluded by a session filter — which is the point: the
   * session navigator's "只看这个会话" is about what the AGENT did.
   */
  sessionId?: string
  /**
   * Top-level ancestor of `sessionId` (itself for a main session).
   *
   * Resolved where the session table lives (ipc-registry), because a subagent
   * appears in the table only after the poll classifies it — an entry recorded
   * before that still has to sort under the session the user clicked. Keeping
   * the root here (rather than a parent chain in the page) means the match
   * below is one comparison at any nesting depth.
   */
  rootSessionId?: string
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
 * Adapt one agent-activity record to the shared entry shape.
 *
 * `text` arrives already composed by the caller (role prefix + action), because
 * the 主/子 classification needs the session table, which is this module's
 * input here — not something it re-derives. The two session ids ride along the
 * same way, and are only SET when given: an entry without them stays a plain
 * four-field record, so the shape other feeds see never changes.
 */
export function entryFromAgent(line: {
  ts: number
  text: string
  sessionId?: string
  rootSessionId?: string
}): LogEntry {
  const entry: LogEntry = { source: 'agent', ts: line.ts, stream: 'out', text: line.text }
  if (line.sessionId) entry.sessionId = line.sessionId
  if (line.rootSessionId) entry.rootSessionId = line.rootSessionId
  return entry
}

/**
 * Does this entry belong to `sessionId`'s conversation?
 *
 * Own id OR root id: clicking a main session has to keep its subagents'
 * activity in view, since that work IS the session's work. Entries with no
 * session ids (shell, backend) never match — a session filter is deliberately
 * a filter down to the agent, not a tag on top of everything.
 */
export function matchesSession(entry: LogEntry, sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return entry.sessionId === sessionId || entry.rootSessionId === sessionId
}

/**
 * Merge all three feeds into the ordered, filtered, capped list the logbar
 * draws.
 *
 * - Sorted oldest → newest. `Array#sort` is stable in every runtime Electron
 *   ships, so lines with identical timestamps keep their arrival order.
 * - `active` is the page's current filter (null = show everything). Unknown
 *   ids simply never match — this is display state from our own page, not
 *   data to validate loudly.
 * - `sessionId` is the session navigator's "只看这个会话" filter (null = no
 *   filter). Applied together with `active`, so the two compose instead of
 *   fighting: narrowing to a session then hiding the Agent chip leaves
 *   nothing, exactly as it should.
 * - Capped to the LAST `limit` entries AFTER filtering, so switching to a
 *   quiet source still fills the view with that source's recent lines instead
 *   of showing an empty panel because a chatty one ate the budget.
 */
export function buildView(
  shell: readonly unknown[],
  backend: readonly { ts: number; stream: 'out' | 'err'; text: string }[],
  agent: readonly { ts: number; text: string }[],
  active: readonly LogSource[] | null,
  limit = 400,
  sessionId: string | null = null,
): LogEntry[] {
  const entries: LogEntry[] = []
  for (const line of shell) {
    const entry = parseShellLine(line)
    if (entry) entries.push(entry)
  }
  for (const line of backend) entries.push(entryFromBackend(line))
  for (const line of agent) entries.push(entryFromAgent(line))
  entries.sort((a, b) => a.ts - b.ts)
  const bySource = active ? entries.filter((e) => active.includes(e.source)) : entries
  const filtered = sessionId ? bySource.filter((e) => matchesSession(e, sessionId)) : bySource
  return filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered
}
