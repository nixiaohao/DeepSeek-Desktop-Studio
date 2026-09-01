/**
 * health-monitor.ts — backend (agent) health state machine.
 *
 * Answers the question "is the agent actually healthy right now?" by watching
 * the backend output feed in src/logging.ts.
 *
 * Deliberately PURE LOGIC: no Electron, no fs, no timers. Time is passed in,
 * so the whole state machine is unit-testable in isolation (test/health.unit.cjs).
 *
 * Design rules that matter (and why):
 *
 *  - Silence is NOT failure. An agent legitimately produces no output while it
 *    thinks, so long quiet periods are reported as `idle` (grey) and never as
 *    an error. Getting this wrong is worse than not monitoring at all: it
 *    would nag during perfectly normal runs.
 *  - Error counting uses a SLIDING WINDOW, not a lifetime counter. A cumulative
 *    counter would turn every long session yellow by morning.
 *  - This class NEVER restarts anything. It only reports. Restarting a backend
 *    that is mid-session destroys work; that decision stays with the user.
 */
// Type-only import: erased at compile time, so this module stays free of any
// runtime dependency (logging.ts pulls in Electron, which would make it
// untestable outside a running app).
import type { BackendLine } from './logging.js'

export type HealthPhase =
  /** Spawned, not yet confirmed ready. */
  | 'starting'
  /** Ready and producing output. */
  | 'ready'
  /** Ready but quiet for a long while — informational, not an error. */
  | 'idle'
  /** Error lines exceeded the threshold inside the sliding window. */
  | 'degraded'
  /** Process exited (crash or clean exit). */
  | 'exited'
  /** spawn() itself failed. */
  | 'error'

export interface HealthSnapshot {
  phase: HealthPhase
  /** Epoch ms of the last output line; 0 when nothing has been seen yet. */
  lastLineTs: number
  /** Process exit code; null while running. */
  exitCode: number | null
  /** Error lines still inside the sliding window. */
  recentErrors: number
  /** How many times the backend has been restarted this session. */
  restartCount: number
  /** Short, human-readable reason for the current phase. */
  detail: string
}

/** No output for this long while ready → `idle`. Generous on purpose. */
const IDLE_AFTER_MS = 120_000

/** Width of the sliding window used to count error lines. */
const ERROR_WINDOW_MS = 60_000

/** Error lines inside the window that trip `degraded`. */
const ERROR_THRESHOLD = 5

/** Chinese labels for the status bar / panel. */
export const PHASE_LABEL: Record<HealthPhase, string> = {
  starting: '启动中',
  ready: '正常',
  idle: '空闲',
  degraded: '异常',
  exited: '已停止',
  error: '错误',
}

export class HealthMonitor {
  private phase: HealthPhase = 'starting'
  private lastLineTs = 0
  private exitCode: number | null = null
  private restartCount = 0
  private errTimes: number[] = []
  private detail = '尚未启动'
  private listeners = new Set<(s: HealthSnapshot) => void>()

  /**
   * Feed one backend output line.
   *
   * The caller owns the subscription (src/main.ts wires subscribeBackend() →
   * feedLine), which keeps this class free of Electron and lets the tests drive
   * it directly. Callers MUST unsubscribe on teardown — the subscription holds
   * a closure for the lifetime of the process otherwise.
   */
  feedLine(line: BackendLine): void {
    this.lastLineTs = line.ts
    if (line.stream === 'err') this.errTimes.push(line.ts)
    this.emit()
  }

  /** Subscribe to health changes. Returns an unsubscribe function. */
  subscribe(cb: (s: HealthSnapshot) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** Backend confirmed ready by the launcher. */
  noteReady(): void {
    if (this.phase === 'exited' || this.phase === 'error') return
    this.phase = 'ready'
    this.detail = '服务已就绪'
    this.emit()
  }

  /** Backend process exited. */
  noteExit(code: number | null): void {
    this.exitCode = code
    this.phase = 'exited'
    this.detail = code === null ? '后端进程已退出' : `后端进程已退出（退出码 ${code}）`
    this.emit()
  }

  /** spawn() failed — the process never ran. */
  noteSpawnError(message: string): void {
    this.phase = 'error'
    this.detail = message
    this.emit()
  }

  /** A restart was requested: reset everything except the restart counter. */
  noteRestart(): void {
    this.restartCount += 1
    this.phase = 'starting'
    this.exitCode = null
    this.errTimes = []
    this.lastLineTs = 0
    this.detail = '正在重启…'
    this.emit()
  }

  /**
   * Current health, recomputed from `now`.
   *
   * Has one intentional side effect: it advances the cached phase so that
   * idle/degraded (which depend on elapsed time) are picked up by callers that
   * simply poll. Listeners are notified only on an actual phase change.
   */
  snapshot(now: number = Date.now()): HealthSnapshot {
    this.pruneErrors(now)

    if (this.phase === 'ready' || this.phase === 'idle' || this.phase === 'degraded') {
      let next: HealthPhase
      let detail: string
      if (this.errTimes.length >= ERROR_THRESHOLD) {
        next = 'degraded'
        detail = `最近 ${Math.round(ERROR_WINDOW_MS / 1000)} 秒内出现 ${this.errTimes.length} 条错误输出`
      } else if (this.lastLineTs > 0 && now - this.lastLineTs > IDLE_AFTER_MS) {
        const secs = Math.round((now - this.lastLineTs) / 1000)
        next = 'idle'
        detail = `已 ${secs} 秒无输出（agent 可能正在思考，不视为故障）`
      } else {
        next = 'ready'
        detail = '正常运行'
      }
      // Assign directly (NOT via setPhase) so the notify path can never
      // re-enter snapshot(): setPhase → emit → snapshot would recurse.
      const changed = next !== this.phase
      this.phase = next
      this.detail = detail
      if (changed) this.emit()
    }

    return this.current()
  }

  // ── internals ──

  /**
   * Snapshot WITHOUT recomputation. emit() must use this: calling snapshot()
   * from the notify path would recurse forever.
   */
  private current(): HealthSnapshot {
    return {
      phase: this.phase,
      lastLineTs: this.lastLineTs,
      exitCode: this.exitCode,
      recentErrors: this.errTimes.length,
      restartCount: this.restartCount,
      detail: this.detail,
    }
  }

  private pruneErrors(now: number): void {
    if (this.errTimes.length === 0) return
    const cutoff = now - ERROR_WINDOW_MS
    // errTimes is append-only and ordered, so drop the expired prefix.
    let drop = 0
    while (drop < this.errTimes.length && this.errTimes[drop] < cutoff) drop++
    if (drop > 0) this.errTimes.splice(0, drop)
  }

  private emit(): void {
    const snap = this.current()
    for (const cb of this.listeners) {
      try {
        cb(snap)
      } catch { /* a broken listener must not break monitoring */ }
    }
  }
}
