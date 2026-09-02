/**
 * The one place that talks to dsh's HTTP API from the main process.
 *
 * This is the ONLY module that knows the wire: SSE framing and the RPC envelope
 * live here and in `event-store.ts` (pure), so an upstream contract change has
 * exactly two files to touch. Everything else consumes `EventStore` snapshots.
 *
 * Verified against deepseek-harness rc.2:
 *   GET  /api/events.mux                     SSE, `data: <ServerRequest>\n\n`
 *   POST /api/<method>                       `{type:'client-request', rpcId, method, payload}`
 *   POST /api/respond                        `{type:'client-response', rpcId, result:{ok,value}}`
 *
 * `/api/*` carries NO version promise (upstream calls it a semi-public
 * contract), so every call here fails soft: a broken stream costs the panel its
 * change list, never the app its window.
 */

import { randomUUID } from 'node:crypto'
import {
  EventStore,
  parseSseChunk,
  type ChangeEntry,
  type PendingApproval,
  type SessionInfo,
  type StoreSnapshot,
} from './event-store.js'
import { redactTokenInUrl } from './redact.js'
import { normalizeIds } from './approval-groups.js'
// approval-groups.ts carries no runtime imports, so this stays testable in
// plain node — see test/modules.smoke.cjs, which pins that fact.

/** The only two answers a client may give; the rest are host-side outcomes. */
export type ApprovalOutcome = 'allowed-once' | 'rejected'

export interface SplitUrl {
  /** Scheme + host + port, no trailing slash. */
  origin: string
  /** Per-process launch token, '' when this harness does not mint one. */
  token: string
}

/**
 * Split a `dsh web` URL into origin and token.
 *
 * rc.2 prints a bare `http://127.0.0.1:3080/` with no auth at all; newer
 * versions append `/?token=<64 hex>`. Both must work, so the token is optional
 * and simply omitted when absent rather than treated as an error.
 */
export function splitUrl(raw: string): SplitUrl {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return { origin: '', token: '' }
  try {
    const url = new URL(trimmed)
    return { origin: url.origin, token: url.searchParams.get('token') ?? '' }
  } catch {
    // Not a parseable absolute URL (older harnesses print a bare host:port).
    const bare = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    try {
      return { origin: new URL(bare).origin, token: '' }
    } catch {
      return { origin: trimmed, token: '' }
    }
  }
}

/** Build the mux SSE URL, attaching the token only when there is one. */
export function muxUrl(origin: string, token: string): string {
  const base = `${origin.replace(/\/+$/, '')}/api/events.mux`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

/**
 * Body of `POST /api/respond` for an approval.
 *
 * It is a CLIENT-RESPONSE, not a unary call: the rpcId is echoed verbatim from
 * the `approval/requested` ServerRequest and no new id is minted. Getting this
 * wrong is silent — the host answers `{accepted:false,reason:'not-pending'}`
 * and the approval just hangs.
 */
export function respondBody(args: {
  rpcId: string
  sessionId: string
  approvalId: string
  outcome: ApprovalOutcome
}): unknown {
  return {
    type: 'client-response',
    rpcId: args.rpcId,
    result: {
      ok: true,
      value: {
        sessionId: args.sessionId,
        approvalId: args.approvalId,
        outcome: args.outcome,
      },
    },
  }
}

/** Body of a unary RPC call; `method` must equal the URL endpoint. */
export function unaryBody(method: string, payload: unknown = {}): unknown {
  return { type: 'client-request', rpcId: randomUUID(), method, payload }
}

/** Exponential backoff, capped. `attempt` is the number of failures so far. */
export function backoffDelay(attempt: number): number {
  const RECONNECT_MIN_MS = 1_000
  const RECONNECT_MAX_MS = 30_000
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, attempt))
}

/** How often `session.list` is re-read for cwd / running state. */
const SESSION_POLL_MS = 5_000
/** Unary calls are local loopback; a long timeout only delays a dead backend. */
const REQUEST_TIMEOUT_MS = 5_000

export interface DshStreamOptions {
  /** Log sink. MUST be given already-redacted text — see redact.ts. */
  log?: (message: string) => void
  /** Called when panel-visible state changed and the UI should re-read it. */
  onChange?: () => void
}

export interface RespondResult {
  ok: boolean
  error?: string
}

/** Outcome of one batch. `skipped` is not a failure — see respondMany(). */
export interface RespondManyResult {
  /** True when nothing FAILED. Skipped entries do not make this false. */
  ok: boolean
  answered: number
  failed: { approvalId: string; error: string }[]
  /** Ids that were no longer pending — the agent resolved them on its own. */
  skipped: string[]
  total: number
}

/**
 * Keeps one mux SSE connection alive and lets the UI answer approvals.
 *
 * Deliberately never throws at its callers: the stream is an enhancement and a
 * backend that does not speak it must leave the rest of the shell untouched.
 */
export class DshStream {
  readonly store = new EventStore()

  private origin = ''
  private token = ''
  private controller: AbortController | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private attempt = 0
  private running = false
  private reading = false
  /** Consecutive malformed frames; surfaced so drift is visible, not silent. */
  private malformed = 0

  constructor(private readonly options: DshStreamOptions = {}) {}

  get connected(): boolean {
    return this.reading
  }

  get malformedCount(): number {
    return this.malformed
  }

  /**
   * Install the change-notification callback.
   *
   * Set by the IPC layer (which owns the broadcast to the panel views) rather
   * than passed in the constructor, because the stream is created before the
   * window manager exists. The callback receives no payload on purpose: it only
   * says "re-read the snapshot", so nothing is serialized per frame and the
   * panel keeps its own throttling in one place.
   */
  setOnChange(cb: (() => void) | undefined): void {
    this.options.onChange = cb
  }

  /**
   * Open the stream against `rawUrl`.
   *
   * Safe to call repeatedly; a changed URL (backend restart mints a new token)
   * tears the old connection down first.
   */
  start(rawUrl: string): void {
    const { origin, token } = splitUrl(rawUrl)
    if (origin.length === 0) return

    const changed = origin !== this.origin || token !== this.token
    if (changed) {
      this.teardown()
      this.origin = origin
      this.token = token
      // A new backend process means every session, call and approval we knew
      // about is gone — keeping them would show stale approvals as live.
      this.store.reset()
    }
    if (this.running) return

    this.running = true
    this.attempt = 0
    void this.open()
    this.startPolling()
  }

  stop(): void {
    this.teardown()
  }

  /**
   * Drop the connection and every timer.
   *
   * Clears `running` itself rather than leaving it to the caller: start() with
   * a CHANGED url tears down and then reopens, and a stale `true` here would
   * make it take the early-return branch and never reconnect — the exact path a
   * backend restart takes, since a restart means a new token and therefore a
   * new URL.
   */
  private teardown(): void {
    this.running = false
    this.controller?.abort()
    this.controller = null
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reading = false
  }

  private async open(): Promise<void> {
    if (!this.running) return

    const controller = new AbortController()
    this.controller = controller

    try {
      const response = await fetch(muxUrl(this.origin, this.token), {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      })
      if (!response.ok || response.body === null) {
        throw new Error(`HTTP ${response.status}`)
      }

      this.attempt = 0
      this.reading = true
      this.options.log?.(`mux stream connected to ${this.origin}/api/events.mux`)
      this.options.onChange?.()

      await this.readLoop(response, controller)
    } catch (error) {
      if (this.running && !isAbort(error)) {
        this.options.log?.(`mux stream error: ${(error as Error).message}`)
      }
    } finally {
      this.reading = false
      if (this.controller === controller) this.controller = null
      this.options.onChange?.()
      if (this.running) this.scheduleReconnect()
    }
  }

  private async readLoop(response: Response, controller: AbortController): Promise<void> {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseChunk(buffer)
      buffer = parsed.rest

      if (parsed.malformed > 0) {
        this.malformed += parsed.malformed
        this.options.log?.(`dropped ${parsed.malformed} malformed mux frame(s)`)
      }
      if (parsed.frames.length === 0) continue

      let dirty = false
      for (const { frame, rpcId } of parsed.frames) {
        if (this.store.feed(frame, rpcId)) dirty = true
      }
      if (dirty) this.options.onChange?.()
      if (controller.signal.aborted) break
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== null) return
    const delay = backoffDelay(this.attempt)
    this.attempt += 1
    this.options.log?.(`reconnecting mux stream in ${delay}ms (attempt ${this.attempt})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.open()
    }, delay)
    // Never hold the process open on a timer.
    this.reconnectTimer.unref?.()
  }

  /**
   * Re-read `session.list` and merge cwd / running into the store.
   *
   * The mux stream carries neither, and the host stream is a second connection
   * we do not need: one unary poll every few seconds is enough for a status
   * readout, and it degrades to "no sessions known" if the method ever changes.
   */
  private startPolling(): void {
    if (this.pollTimer !== null) return
    const tick = (): void => {
      void this.refreshSessions()
    }
    this.pollTimer = setInterval(tick, SESSION_POLL_MS)
    this.pollTimer.unref?.()
    tick()
  }

  private async refreshSessions(): Promise<void> {
    if (!this.running) return
    const result = await this.post('session.list', unaryBody('session.list'))
    if (result === null || !Array.isArray((result as { items?: unknown }).items)) return

    for (const raw of (result as { items: unknown[] }).items) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as Record<string, unknown>
      if (typeof item.sessionId !== 'string') continue
      this.store.noteSessionInfo({
        sessionId: item.sessionId,
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
        running: item.running === true,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
        // Present ⇔ subagent (upstream derives both from the session header).
        // Dropped before this edit, which is why the shell could not tell 主
        // from 子 — the wire carried them all along.
        parentSessionId:
          typeof item.parentSessionId === 'string' && item.parentSessionId.length > 0
            ? item.parentSessionId
            : undefined,
        origin: typeof item.origin === 'string' && item.origin.length > 0
          ? item.origin
          : undefined,
        agentPreset: typeof item.agentPreset === 'string' && item.agentPreset.length > 0
          ? item.agentPreset
          : undefined,
      })
    }
  }

  /** POST one unary RPC; returns the parsed `result.value`, or null on failure. */
  private async post(method: string, body: unknown): Promise<unknown | null> {
    const url = this.token
      ? `${this.origin}/api/${method}?token=${encodeURIComponent(this.token)}`
      : `${this.origin}/api/${method}`
    try {
      const response = await fetch(url, {
        method: 'POST',
        // Required: the host answers 415 without it.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return null
      const full = (await response.json()) as { result?: { ok?: boolean; value?: unknown } }
      if (full.result?.ok !== true) return null
      return full.result.value ?? null
    } catch {
      // Loopback RPC on a best-effort path: a dead backend just means no data.
      return null
    }
  }

  /**
   * Answer a pending approval.
   *
   * The rpcId is looked up from the store rather than passed in, because it is
   * the one value the UI has no business holding: it comes off the wire and
   * echoing a stale one silently fails.
   */
  async respond(approvalId: string, outcome: ApprovalOutcome): Promise<RespondResult> {
    const approval = this.store.getApproval(approvalId)
    if (!approval) return { ok: false, error: '该审批已失效' }
    if (!approval.rpcId) return { ok: false, error: '审批帧缺少 rpcId，无法回复' }

    const result = await this.post(
      'respond',
      respondBody({
        rpcId: approval.rpcId,
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        outcome,
      }),
    )

    if (result === null) return { ok: false, error: '后端未接受回复' }
    const receipt = result as { accepted?: boolean; reason?: string }
    if (receipt.accepted !== true) {
      return { ok: false, error: `后端未接受回复（${receipt.reason ?? '未知原因'}）` }
    }
    return { ok: true }
  }

  /**
   * Answer several approvals in one go.
   *
   * SEQUENTIAL, not `Promise.all`. The backend is a single agent turn deep when
   * a tool call is pending, and firing twenty approvals at it at once is how a
   * batch becomes a timeout — after which the UI cannot tell which of them
   * landed, which is precisely the ambiguity this function exists to avoid.
   *
   * Reporting is per-id and never collapses: a batch that half-succeeded must
   * say WHICH half, because "3 of 7 approved" without names leaves the user
   * unable to tell whether the shell command went through.
   *
   * `skipped` is deliberately separate from `failed`. An approval that left the
   * store between render and click was resolved by the agent itself — nothing
   * went wrong and the user is not to blame for it. Folding it into `failed`
   * would make every stale click look like an error.
   *
   * Ids are de-duplicated: a duplicate would POST the same approval twice, and
   * the second POST would come back `not-pending` and be reported as a failure
   * the user never caused.
   */
  async respondMany(
    approvalIds: readonly string[],
    outcome: ApprovalOutcome,
  ): Promise<RespondManyResult> {
    const ids = normalizeIds(approvalIds)
    const failed: { approvalId: string; error: string }[] = []
    const skipped: string[] = []
    let answered = 0

    for (const id of ids) {
      const approval = this.store.getApproval(id)
      if (!approval) {
        skipped.push(id)
        continue
      }
      const result = await this.respond(id, outcome)
      if (result.ok) answered += 1
      else failed.push({ approvalId: id, error: result.error ?? '未知错误' })
    }

    return { ok: failed.length === 0, answered, failed, skipped, total: ids.length }
  }

  snapshot(): StoreSnapshot {
    return this.store.snapshot()
  }

  /**
   * Everything the panel needs in one call. `connected` matters as much as the
   * data: an empty change list means "nothing has changed yet" when the stream
   * is up and "the panel is blind" when it is not, and those look identical
   * unless the UI can tell them apart.
   */
  panelSnapshot(): StoreSnapshot & { connected: boolean } {
    return { ...this.store.snapshot(), connected: this.reading }
  }

  changes(): ChangeEntry[] {
    return this.store.snapshot().changes
  }

  approvals(): PendingApproval[] {
    return this.store.snapshot().approvals
  }

  sessions(): SessionInfo[] {
    return this.store.snapshot().sessions
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** Re-exported for the log formatter; the raw URL must never reach disk. */
export { redactTokenInUrl }
