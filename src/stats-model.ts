/**
 * stats-model.ts — pure aggregation behind the status bar's stats segment.
 *
 * ZERO-DEPENDENCY ON PURPOSE (same argument as log-model.ts / event-store.ts):
 * the numbers it produces are the user's answer to "what is the agent actually
 * doing", so the fold must be testable in plain node and must never throw on
 * wire data. Everything is read defensively — a missing or wrong-typed field
 * contributes zero, never an exception.
 *
 * Data source (deepseek-harness rc.2, verified):
 *   - mux frame `session/projection`, keys `sessionStats`
 *     ({turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens},
 *     session-stats package) and `tokenUsage`
 *     ({uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens},
 *     llm/token-meter package) — one value per session, main AND subagents.
 *   - `session.list` rows carry `parentSessionId` / `origin: 'subagent'`,
 *     which is how a subagent is recognised here.
 *
 * dsh's own in-page StatsLine shows the CURRENT session only; this fold is the
 * shell's whole-window answer, subagents included.
 */

/** One `sessionStats` projection view (only the fields we read). */
export interface SessionStatsView {
  turns?: number
  steps?: number
  llmMs?: number
  toolMs?: number
  decodeTokens?: number
}

/** One `tokenUsage` projection view (provider-reported, whole durable log). */
export interface TokenUsageView {
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** What the aggregation needs per session — a pruned EventStore snapshot row. */
export interface StatsSessionRow {
  sessionId: string
  /** Present ⇒ subagent (from session.list's parentSessionId). */
  parentSessionId?: string
  running: boolean
  stats?: SessionStatsView
  usage?: TokenUsageView
}

/** The aggregate the status bar renders. */
export interface AggregatedStats {
  /** Summed model wall time over message-assembling steps, ms. */
  llmMs: number
  /** Summed matched tool call→result wall time, ms. */
  toolMs: number
  /** Closed steps across all sessions. */
  steps: number
  /** Prompt-side tokens: uncached input + cache read + cache write. */
  tokensIn: number
  /** Provider-reported output tokens. */
  tokensOut: number
  /** Sessions seen (main + subagents). */
  agentsTotal: number
  /** Sessions currently running a turn. */
  agentsRunning: number
  /** Sessions that are subagents (have a parentSessionId). */
  agentsSub: number
}

/** Defensive non-negative finite number read off the wire. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Fold every session — main and subagents alike — into one aggregate.
 *
 * Sessions without projections still count toward the agent tallies: a
 * subagent that has not emitted a projection yet is real work the user should
 * see counted, not invisible.
 */
export function aggregateStats(rows: readonly StatsSessionRow[]): AggregatedStats {
  const out: AggregatedStats = {
    llmMs: 0,
    toolMs: 0,
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    agentsTotal: 0,
    agentsRunning: 0,
    agentsSub: 0,
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    out.agentsTotal += 1
    if (row.running === true) out.agentsRunning += 1
    if (typeof row.parentSessionId === 'string' && row.parentSessionId.length > 0) out.agentsSub += 1

    const stats = (row.stats && typeof row.stats === 'object' ? row.stats : {}) as SessionStatsView
    out.llmMs += num(stats.llmMs)
    out.toolMs += num(stats.toolMs)
    out.steps += num(stats.steps)

    const usage = (row.usage && typeof row.usage === 'object' ? row.usage : {}) as TokenUsageView
    out.tokensIn +=
      num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
    out.tokensOut += num(usage.outputTokens)
  }
  return out
}

/** Format milliseconds as a compact duration: `45s`, `6m32s`, `2h03m`. */
export function formatDuration(ms: number): string {
  if (!(typeof ms === 'number') || !Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/** Format a token count compactly: `830`, `42.2k`, `656k`, `1.2M`. */
export function formatTokens(count: number): string {
  if (!(typeof count === 'number') || !Number.isFinite(count) || count <= 0) return '0'
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) {
    const k = count / 1000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`
  }
  return `${Math.round((count / 1_000_000) * 10) / 10}M`
}

/**
 * One-line status bar summary, or '' when there is nothing to show.
 *
 * Lives HERE and not in the page so the status bar, the logbar and any future
 * surface share one formatter — and so the unit tests pin exactly what the
 * user reads.
 */
export function formatStatsSummary(s: AggregatedStats | null | undefined): string {
  if (!s || typeof s !== 'object') return ''
  const parts: string[] = []
  if (s.llmMs > 0) parts.push(`LLM ${formatDuration(s.llmMs)}`)
  if (s.toolMs > 0) parts.push(`工具 ${formatDuration(s.toolMs)}`)
  if (s.tokensIn > 0 || s.tokensOut > 0) {
    parts.push(`↑${formatTokens(s.tokensIn)} ↓${formatTokens(s.tokensOut)} tok`)
  }
  if (s.agentsSub > 0) parts.push(`子agent ${s.agentsSub}`)
  if (s.agentsRunning > 0) parts.push(`运行中 ${s.agentsRunning}`)
  return parts.join(' · ')
}

// ── session overview (the panel's 会话概览 tab) ──
//
// Same defensive posture as aggregateStats: every field is read through num()
// and a malformed projection contributes zero, never a crash or a NaN.

/** Context-occupancy projection (token-meter's contextPressure wire view). */
export interface ContextPressureView {
  contextWindow?: number
  pressureTokens?: number
  surfaceTokens?: number
}

/** Context-composition projection (token-meter's contextBreakdown wire view). */
export interface ContextBreakdownView {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** One session's worth of overview inputs (all optional, all untrusted). */
export interface OverviewSessionRow {
  sessionId?: string
  parentSessionId?: string
  running?: boolean
  /** Preset name — the price table's match key for the cost estimate. */
  agentPreset?: string
  usage?: {
    uncachedInputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  contextPressure?: ContextPressureView
  contextBreakdown?: ContextBreakdownView
}

export interface AggregatedOverview {
  /** Context occupancy: tokens used against the model's window. */
  contextUsed: number
  contextWindow: number | null
  /** 0..100, or null when the window is unknown. */
  contextPercent: number | null
  /** Cache hit rate 0..100, or null when no input was seen at all. */
  hitRate: number | null
  tokens: {
    uncachedInput: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  /** Composition of the live context, or null when no breakdown arrived. */
  breakdown: { system: number; tools: number; messages: number } | null
}

/**
 * Aggregate the overview across sessions. Context occupancy takes the MAX
 * per-session pressure (the session closest to its limit is the one the user
 * must act on), tokens SUM (the bill is the sum), and the breakdown sums the
 * system/tools/messages composition.
 */
export function aggregateOverview(rows: readonly OverviewSessionRow[]): AggregatedOverview {
  const tokens = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let breakdown: { system: number; tools: number; messages: number } | null = null
  let contextUsed = 0
  let contextWindow: number | null = null

  for (const row of rows as readonly (OverviewSessionRow | null | undefined)[]) {
    if (!row || typeof row !== 'object') continue

    const u = row.usage
    if (u && typeof u === 'object') {
      tokens.uncachedInput += num(u.uncachedInputTokens)
      tokens.output += num(u.outputTokens)
      tokens.cacheRead += num(u.cacheReadTokens)
      tokens.cacheWrite += num(u.cacheWriteTokens)
    }

    const cp = row.contextPressure
    if (cp && typeof cp === 'object') {
      const window = num(cp.contextWindow)
      if (window > 0 && (contextWindow === null || window < contextWindow)) {
        // The SMALLEST window seen is the binding constraint once rows mix
        // models with different limits.
        contextWindow = window
      }
      const used = num(cp.pressureTokens) || num(cp.surfaceTokens)
      if (used > contextUsed) contextUsed = used
    }

    const cb = row.contextBreakdown
    if (cb && typeof cb === 'object') {
      const system = num(cb.systemTokens)
      const tools = num(cb.toolsTokens)
      const messages = num(cb.messageTokens)
      if (!breakdown) breakdown = { system: 0, tools: 0, messages: 0 }
      breakdown.system += system
      breakdown.tools += tools
      breakdown.messages += messages
    }
  }

  const inputTotal = tokens.cacheRead + tokens.uncachedInput
  const hitRate = inputTotal > 0
    ? Math.round((tokens.cacheRead / inputTotal) * 1000) / 10
    : null
  const contextPercent = contextWindow !== null && contextWindow > 0
    ? Math.round((contextUsed / contextWindow) * 1000) / 10
    : null

  return {
    contextUsed,
    contextWindow,
    contextPercent,
    hitRate,
    tokens,
    breakdown,
  }
}

// ── cost estimation (the status bar's cost segment) ──
//
// The harness meters TOKENS, never money — verified across rc.2: the usage
// projection is the four-bucket fold and nothing anywhere carries an amount.
// So the cost is a LOCAL ESTIMATE: a price table (元 / Mtok) × the token
// buckets. The table is user-editable so the mechanism is not locked to any
// one provider; entries that do not match a session's preset are skipped and
// reported, never silently guessed.

/** One price entry: 元 per million tokens. */
export interface ModelPrice {
  /** Match key against the session's agentPreset ('*' is the fallback). */
  model: string
  /** Cache-hit input. */
  cached: number
  /** Cache-miss input. */
  uncached: number
  /** Output. */
  output: number
  /**
   * Cache-write billing; providers that do not bill it separately (DeepSeek)
   * simply omit the field, which contributes zero.
   */
  cacheWrite?: number
}

/**
 * Built-in defaults from DeepSeek's published pricing (api-docs.deepseek.com,
 * 2026-09: V3.2 — 命中输入 ¥0.2/M、未命中输入 ¥2/M、输出 ¥3/M). The user
 * override file can replace or extend these; prices change over time.
 */
export const BUILTIN_PRICES: readonly ModelPrice[] = [
  { model: 'deepseek-chat', cached: 0.2, uncached: 2, output: 3 },
  { model: 'deepseek-reasoner', cached: 0.2, uncached: 2, output: 3 },
]

/**
 * Parse the user's model-prices.json (a JSON array of ModelPrice). Anything
 * malformed is dropped, not fatal — a broken override file degrades to fewer
 * price entries, never to a broken status bar.
 */
export function parsePriceOverrides(text: string): ModelPrice[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: ModelPrice[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const e = item as Record<string, unknown>
    const model = typeof e.model === 'string' ? e.model.trim() : ''
    if (!model) continue
    const cached = num(e.cached)
    const uncached = num(e.uncached)
    const output = num(e.output)
    if (cached <= 0 && uncached <= 0 && output <= 0) continue
    const entry: ModelPrice = { model, cached, uncached, output }
    const cacheWrite = num(e.cacheWrite)
    if (cacheWrite > 0) entry.cacheWrite = cacheWrite
    out.push(entry)
  }
  return out
}

/**
 * Match a session's preset to a price entry: exact (case-insensitive) first,
 * then the '*' fallback entry, then null — an unmatched session shows up in
 * the summary's unmatched count instead of being billed at a guessed price.
 */
export function pickPrice(
  entries: readonly ModelPrice[],
  modelKey: string | undefined,
): ModelPrice | null {
  if (!modelKey) return null
  const key = modelKey.toLowerCase()
  for (const e of entries) {
    if (e.model.toLowerCase() === key) return e
  }
  for (const e of entries) {
    if (e.model === '*') return e
  }
  return null
}

/** 元 for one session's token buckets at one price entry. */
export function estimateCost(
  tokens: { uncachedInput?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  price: ModelPrice,
): number {
  const cost =
    (num(tokens.uncachedInput) * price.uncached +
      num(tokens.cacheRead) * price.cached +
      num(tokens.output) * price.output +
      num(tokens.cacheWrite) * (price.cacheWrite ?? 0)) /
    1_000_000
  return Math.round(cost * 10000) / 10000
}

export interface CostSummary {
  /** Cache hit rate 0..100 over ALL matched sessions, or null. */
  hitRate: number | null
  /** Estimated total cost in 元, or null when no session matched a price. */
  cost: number | null
  /** The price entry the estimate used ('*' when the fallback matched). */
  matched: string | null
  /** Sessions whose preset matched no price entry (their tokens are NOT billed). */
  unmatched: number
}

/**
 * Format the status bar's cost segment, or '' when there is nothing to show.
 * The 估算 marker is part of the contract: the figure is a local estimate,
 * never a bill.
 */
export function formatCostSummary(s: CostSummary | null | undefined): string {
  if (!s || typeof s !== 'object') return ''
  const parts: string[] = []
  if (s.hitRate !== null && s.hitRate !== undefined) {
    parts.push(`命中率 ${s.hitRate}%`)
  }
  if (s.cost !== null && s.cost !== undefined) {
    const yuan = s.cost >= 100 ? Math.round(s.cost) : Math.round(s.cost * 100) / 100
    parts.push(`估算 ¥${yuan}`)
  }
  if (s.unmatched > 0) {
    parts.push(`未匹配 ${s.unmatched}`)
  }
  return parts.join(' · ')
}
