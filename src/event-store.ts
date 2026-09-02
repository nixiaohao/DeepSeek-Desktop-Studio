/**
 * Reduction of the dsh mux event stream into the two things the panel shows:
 * pending file changes and pending approvals.
 *
 * Everything here is PURE — no I/O, no Electron, no timers. The SSE transport
 * lives in `dsh-stream.ts`; this module only consumes decoded frames. That split
 * is what makes the stream-reassembly and correlation rules unit-testable:
 * they are exactly the parts that silently produce a blank panel when wrong.
 *
 * Wire contract (verified against deepseek-harness rc.2,
 * packages/host/apiproxy/src/fetch/{handler,client}.ts):
 *
 *   GET /api/events.mux  →  SSE, `\n\n` framing, one JSON payload per frame
 *   frame = { type: 'server-request', rpcId, method, payload: <MuxFrame> }
 *   a `: connected\n\n` comment line is sent on open and carries no frame
 *
 * Two correlation rules matter and are easy to get wrong:
 *
 *  1. `approval/requested` does NOT carry a diff. It carries an optional
 *     `callId`, which is the only link back to the `tool/call` event that does
 *     carry the `DiffCallView`. Without that join the approval card can only
 *     say "write wants permission", never "here is what it will write".
 *  2. `tool/result` is what confirms a change actually landed, and its
 *     `DiffResultView` is the applied hunks (narrower than the call-time diff).
 *     A `tool/call` alone is only an INTENT — it may still be rejected.
 */

/** One file a tool call creates or modifies (`FileDiff` upstream). */
export interface FileDiff {
  path: string
  /** Prior content, or null for a create/overwrite (no before-image). */
  oldText: string | null
  newText: string
}

/** A call that is about to touch files, with the diff derived from its arguments. */
export interface ChangeEntry {
  /** Correlation key: the tool call id, stable across call → approval → result. */
  callId: string
  sessionId: string
  /** Card title from the view (e.g. "Write foo.txt"), else the tool name. */
  title: string
  toolName: string
  diffs: FileDiff[]
  /** When the call happened, from the event's own `time` — for display only. */
  ts: number
  /**
   * When THIS process last heard about the call. The eviction clock, kept
   * separate from `ts` on purpose: `ts` comes off the wire and a replayed or
   * clock-skewed event would otherwise look ancient and be dropped the moment
   * it arrived.
   */
  seenAt: number
  /**
   * Lifecycle: a call is `pending` until it is approved and executed; `applied`
   * means `tool/result` confirmed it; `rejected` means the user refused it.
   * A rejected call keeps its entry (greyed) so the list explains itself.
   */
  status: 'pending' | 'applied' | 'rejected'
}

/** A tool call waiting for the user to allow it (`approval/requested`). */
export interface PendingApproval {
  approvalId: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
  /**
   * The ServerRequest's rpcId. `POST /api/respond` is a client-RESPONSE, so it
   * must echo this exact id — it is not a unary method and mints no new id.
   * Losing it means the approval can never be answered.
   */
  rpcId: string
  ts: number
}

export interface SessionInfo {
  sessionId: string
  cwd?: string
  running: boolean
  updatedAt: number
  /**
   * Present ⇔ this session is a subagent of another one. Comes from
   * `session.list` (derived upstream from the session header's parent/origin
   * fields); the stats fold and the activity log use it to tell 主 from 子.
   */
  parentSessionId?: string
  origin?: string
}

/** The subset of MuxFrame this store understands; unknown types are ignored. */
export type KnownFrame =
  | { type: 'session/event'; sessionId: string; event: SessionEventLike; view?: { for: 'call' | 'result'; view: unknown } }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | { type: 'approval/requested'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: string; approvalId: string; outcome: string }
  /**
   * Per-session durable projections, broadcast to every mux consumer (upstream
   * api-proxy wires `sessionProjections.onChanged` → broadcast). Only two keys
   * are kept — the status bar's stats fold — so a chatty future projection
   * cannot grow the store.
   */
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: { code?: string; message?: string } }

/** `session/event.data` is a wide passthrough upstream; only these are read. */
export interface SessionEventLike {
  type: string
  seq?: number
  time?: number
  data?: Record<string, unknown> | null
}

/**
 * One thing an agent did, main or subagent — the logbar's Agent feed.
 *
 * Deliberately minimal: the role prefix (主/子) is resolved at read time from
 * the session table, so an entry recorded before the poll classified the
 * session still renders correctly afterwards.
 */
export interface ActivityEntry {
  sessionId: string
  kind: 'tool/call' | 'tool/result'
  /** Tool name for a call; the remembered call's name for a result. */
  name: string
  ts: number
}

export interface StoreSnapshot {
  changes: ChangeEntry[]
  approvals: PendingApproval[]
  sessions: SessionInfo[]
  /** Agent activity, oldest → newest (insertion order, capped). */
  activity: ActivityEntry[]
  /** Frames that could not be understood; a rising count means drift, not noise. */
  dropped: number
}

/** How many finished calls the panel keeps; older ones age out. */
const CHANGE_LIMIT = 200
/** Pending calls older than this are dropped — a stalled agent must not pin memory. */
const PENDING_TTL_MS = 30 * 60 * 1000
/** How many agent-activity entries the logbar feed keeps. */
const ACTIVITY_LIMIT = 300
/** The only projection keys kept; everything else is a no-op. */
const KEPT_PROJECTION_KEYS = new Set(['sessionStats', 'tokenUsage'])

/**
 * A frame plus the envelope's rpcId. The id rides OUTSIDE the frame (it is the
 * ServerRequest's, not the payload's), but `approval/requested` needs it: the
 * answer is a client-RESPONSE that must echo this exact id. Dropping it here
 * would make every approval unanswerable while still rendering its card.
 */
export interface DecodedFrame {
  rpcId: string
  frame: KnownFrame
}

export interface SseParseResult {
  frames: DecodedFrame[]
  /** Unparsed tail, to be prepended to the next chunk. */
  rest: string
  /** Chunks that were valid SSE but failed the frame shape check. */
  malformed: number
}

/**
 * Reassemble SSE bytes into frames.
 *
 * Pure and incremental: feed each network chunk, keep `rest` for the next call.
 * A frame's JSON is routinely split across TCP segments, so slicing on anything
 * other than the `\n\n` boundary silently loses every split frame.
 *
 * Follows upstream's own reader: lines are joined only from `data: ` prefixed
 * lines, a blank payload (the `: connected` comment) is skipped, and one
 * malformed frame is dropped without killing the stream.
 */
export function parseSseChunk(buffer: string): SseParseResult {
  const frames: DecodedFrame[] = []
  let malformed = 0
  let rest = buffer

  for (;;) {
    const boundary = rest.indexOf('\n\n')
    if (boundary === -1) break

    const chunk = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)

    const data = chunk
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('')
    if (data === '') continue // comment / keepalive line

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      malformed += 1
      continue
    }

    const decoded = decodeEnvelope(parsed)
    if (decoded === null) {
      malformed += 1
      continue
    }
    frames.push(decoded)
  }

  return { frames, rest, malformed }
}

/**
 * Narrow a decoded SSE payload to a frame plus its envelope rpcId.
 *
 * Returns null for anything else — an unknown frame type is normal forward
 * compatibility (upstream adds them freely), not an error worth surfacing.
 * Only the envelope shape is validated: the payload fields are read
 * defensively later, because a missing field degrades one card rather than
 * invalidating the whole frame.
 */
export function decodeEnvelope(value: unknown): DecodedFrame | null {
  if (typeof value !== 'object' || value === null) return null
  const envelope = value as Record<string, unknown>
  if (envelope.type !== 'server-request') return null
  const payload = envelope.payload
  if (typeof payload !== 'object' || payload === null) return null
  const frame = payload as Record<string, unknown>
  if (typeof frame.type !== 'string') return null
  return {
    rpcId: typeof envelope.rpcId === 'string' ? envelope.rpcId : '',
    frame: frame as unknown as KnownFrame,
  }
}

/** Narrow a decoded SSE payload to just the frame, dropping the rpcId. */
export function asKnownFrame(value: unknown): KnownFrame | null {
  return decodeEnvelope(value)?.frame ?? null
}

/** Read an optional trimmed string out of a wide frame field. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Extract the diffs a tool view declares, if it declares any.
 *
 * Both call-time and result-time diff cards use `card: 'diff'` with a
 * `diffs[]` array; anything else (terminal, search, read, generic) has no file
 * change to show. Every field is checked because these come off the wire.
 */
function readDiffs(view: unknown): FileDiff[] | null {
  if (typeof view !== 'object' || view === null) return null
  const card = view as Record<string, unknown>
  if (card.card !== 'diff' || !Array.isArray(card.diffs)) return null

  const out: FileDiff[] = []
  for (const raw of card.diffs) {
    if (typeof raw !== 'object' || raw === null) continue
    const d = raw as Record<string, unknown>
    if (typeof d.path !== 'string') continue
    out.push({
      path: d.path,
      oldText: typeof d.oldText === 'string' ? d.oldText : null,
      newText: typeof d.newText === 'string' ? d.newText : '',
    })
  }
  return out.length > 0 ? out : null
}

/**
 * Reduce mux frames into panel state.
 *
 * Deliberately tolerant: an unrecognised frame is a no-op, a missing `view`
 * means "render the generic card" (upstream's documented default) rather than
 * an error. The store is a cache of what the stream said, never the source of
 * truth — the session log is.
 */
export class EventStore {
  private changes = new Map<string, ChangeEntry>()
  private approvals = new Map<string, PendingApproval>()
  private sessions = new Map<string, SessionInfo>()
  /** callId → approvalId, so a resolved approval can close out its call. */
  private callToApproval = new Map<string, string>()
  /** callId → tool name, so a bare `tool/result` can still say WHAT finished. */
  private callNames = new Map<string, string>()
  private activity: ActivityEntry[] = []
  /** sessionId → (projection key → { value, seq }); higher seq wins. */
  private projections = new Map<string, Map<string, { value: unknown; seq: number }>>()
  private dropped = 0
  private order: string[] = []

  /** Feed one decoded frame. Returns true if it changed visible state. */
  feed(frame: KnownFrame, rpcId = ''): boolean {
    switch (frame.type) {
      case 'session/event':
        return this.feedEvent(frame)
      case 'approval/requested':
        return this.feedApprovalRequested(frame, rpcId)
      case 'approval/resolved':
        return this.feedApprovalResolved(frame)
      case 'session/subscribed':
        this.touchSession(frame.sessionId)
        return true
      case 'session/projection':
        return this.feedProjection(frame)
      case 'stream/error':
        // Not a state change the panel renders, but worth counting: a stream
        // that errors is a stream the UI should be reconnecting.
        return false
      default:
        this.dropped += 1
        return false
    }
  }

  private feedProjection(
    frame: Extract<KnownFrame, { type: 'session/projection' }>,
  ): boolean {
    if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) return false
    if (!KEPT_PROJECTION_KEYS.has(frame.key)) return false
    if (typeof frame.seq !== 'number' || !Number.isFinite(frame.seq)) return false

    let byKey = this.projections.get(frame.sessionId)
    if (byKey === undefined) {
      byKey = new Map()
      this.projections.set(frame.sessionId, byKey)
    }
    const existing = byKey.get(frame.key)
    // Higher-seq-wins, mirroring upstream's reconnect rule: a replayed older
    // value must not roll the fold backwards.
    if (existing && existing.seq > frame.seq) return false
    byKey.set(frame.key, { value: frame.value, seq: frame.seq })
    return true
  }

  private feedEvent(
    frame: Extract<KnownFrame, { type: 'session/event' }>,
  ): boolean {
    this.touchSession(frame.sessionId)

    const event = frame.event
    if (!event || typeof event !== 'object') return false
    const data = (event.data ?? {}) as Record<string, unknown>
    const callId = str(data.callId)
    if (!callId) return false

    // Agent activity ring — recorded for EVERY tool call/result, not just the
    // file-mutating ones the change list tracks. This is the logbar's "what
    // are the agents doing" feed; subagents' calls land here exactly like the
    // main agent's, because the mux carries every session's events.
    if (event.type === 'tool/call') {
      const toolName = str(data.name) ?? 'tool'
      this.rememberCallName(callId, toolName)
      this.pushActivity({
        sessionId: frame.sessionId,
        kind: 'tool/call',
        name: toolName,
        ts: typeof event.time === 'number' ? event.time : Date.now(),
      })
    } else if (event.type === 'tool/result') {
      this.pushActivity({
        sessionId: frame.sessionId,
        kind: 'tool/result',
        name: this.callNames.get(callId) ?? '工具',
        ts: typeof event.time === 'number' ? event.time : Date.now(),
      })
    }

    if (event.type === 'tool/call') {
      const toolName = str(data.name) ?? 'tool'
      const diffs = readDiffs(frame.view?.view)
      if (diffs === null) return false // not a file mutation — nothing to review

      const title =
        (typeof frame.view?.view === 'object' && frame.view.view !== null
          ? str((frame.view.view as Record<string, unknown>).title)
          : undefined) ?? toolName

      this.upsertChange({
        callId,
        sessionId: frame.sessionId,
        title,
        toolName,
        diffs,
        ts: typeof event.time === 'number' ? event.time : Date.now(),
        seenAt: Date.now(),
        status: 'pending',
      })
      return true
    }

    if (event.type === 'tool/result') {
      const existing = this.changes.get(callId)
      if (!existing) return false // a result for a call we never saw is not a change
      const diffs = readDiffs(frame.view?.view)
      this.upsertChange({ ...existing, diffs: diffs ?? existing.diffs, status: 'applied' })
      return true
    }

    return false
  }

  private feedApprovalRequested(
    frame: Extract<KnownFrame, { type: 'approval/requested' }>,
    rpcId: string,
  ): boolean {
    const approvalId = str(frame.approvalId)
    if (!approvalId) return false

    const approval: PendingApproval = {
      approvalId,
      sessionId: frame.sessionId,
      toolName: str(frame.toolName) ?? 'tool',
      callId: str(frame.callId),
      reason: str(frame.reason),
      rpcId,
      ts: Date.now(),
    }
    this.approvals.set(approvalId, approval)
    if (approval.callId) this.callToApproval.set(approval.callId, approvalId)
    return true
  }

  private feedApprovalResolved(
    frame: Extract<KnownFrame, { type: 'approval/resolved' }>,
  ): boolean {
    const approvalId = str(frame.approvalId)
    if (!approvalId) return false
    const approval = this.approvals.get(approvalId)
    this.approvals.delete(approvalId)

    if (approval?.callId) {
      this.callToApproval.delete(approval.callId)
      // `rejected` is the only outcome that must change the call's state;
      // allowed-once leaves it pending until `tool/result` confirms it landed.
      if (frame.outcome === 'rejected') {
        const existing = this.changes.get(approval.callId)
        if (existing) this.upsertChange({ ...existing, status: 'rejected' })
      }
    }
    return true
  }

  private pushActivity(entry: ActivityEntry): void {
    this.activity.push(entry)
    // Insertion order is oldest-first; trim from the front once over the cap.
    while (this.activity.length > ACTIVITY_LIMIT) this.activity.shift()
  }

  /** Remember a call's tool name, bounded the same way as the activity ring. */
  private rememberCallName(callId: string, name: string): void {
    this.callNames.set(callId, name)
    while (this.callNames.size > ACTIVITY_LIMIT) {
      const oldest = this.callNames.keys().next().value
      if (oldest === undefined) break
      this.callNames.delete(oldest)
    }
  }

  /**
   * Kept projection values, flattened for the stats fold. Order is
   * session-insertion; the consumer re-groups by sessionId as it needs.
   */
  projectionEntries(): { sessionId: string; key: string; value: unknown }[] {
    const out: { sessionId: string; key: string; value: unknown }[] = []
    for (const [sessionId, byKey] of this.projections) {
      for (const [key, { value }] of byKey) out.push({ sessionId, key, value })
    }
    return out
  }

  private upsertChange(entry: ChangeEntry): void {
    if (!this.changes.has(entry.callId)) {
      this.order.push(entry.callId)
      // Insertion order is oldest-first; trim from the front once over the cap.
      while (this.order.length > CHANGE_LIMIT) {
        const oldest = this.order.shift()
        if (oldest !== undefined) this.changes.delete(oldest)
      }
    } else {
      // Already known: keep the ORIGINAL seenAt. Refreshing it here would let a
      // stalled call renew itself every time the same frame is replayed.
      entry = { ...entry, seenAt: this.changes.get(entry.callId)!.seenAt }
    }
    this.changes.set(entry.callId, entry)
  }

  private touchSession(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.updatedAt = Date.now()
      return
    }
    this.sessions.set(sessionId, {
      sessionId,
      running: false,
      updatedAt: Date.now(),
    })
  }

  /** Merge a `session.list` row's authoritative cwd/running into the cache. */
  noteSessionInfo(info: SessionInfo): void {
    this.sessions.set(info.sessionId, { ...info })
  }

  noteSessionRunning(sessionId: string, running: boolean): void {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.running = running
      existing.updatedAt = Date.now()
      return
    }
    this.sessions.set(sessionId, { sessionId, running, updatedAt: Date.now() })
  }

  /** The approval a call is waiting on, if any. */
  approvalForCall(callId: string): PendingApproval | undefined {
    const approvalId = this.callToApproval.get(callId)
    return approvalId === undefined ? undefined : this.approvals.get(approvalId)
  }

  getApproval(approvalId: string): PendingApproval | undefined {
    return this.approvals.get(approvalId)
  }

  /**
   * Newest first — the panel reads top-down and the freshest change matters most.
   * `now` is injectable so the pending-call TTL can be tested without sleeping.
   */
  snapshot(now = Date.now()): StoreSnapshot {
    const changes = this.order
      .map((id) => this.changes.get(id))
      .filter((c): c is ChangeEntry => c !== undefined)
      .filter((c) => c.status !== 'pending' || now - c.seenAt < PENDING_TTL_MS)
      .reverse()

    const sessions = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      changes,
      approvals: [...this.approvals.values()].sort((a, b) => a.ts - b.ts),
      sessions,
      activity: [...this.activity],
      dropped: this.dropped,
    }
  }

  /** Forget everything — used when the backend restarts and the stream reopens. */
  reset(): void {
    this.changes.clear()
    this.approvals.clear()
    this.sessions.clear()
    this.callToApproval.clear()
    this.callNames.clear()
    this.activity = []
    this.projections.clear()
    this.order = []
    this.dropped = 0
  }
}
