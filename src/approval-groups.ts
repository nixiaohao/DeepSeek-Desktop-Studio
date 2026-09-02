/**
 * approval-groups.ts — the batching rules for the approval inbox.
 *
 * Pure logic with zero runtime imports, so it can be driven from plain node
 * (see test/approval-groups.unit.cjs). Everything here answers one question the
 * UI cannot answer for itself: WHAT is safe to approve in one click.
 *
 * The rule the user chose: batch by TOOL, and allow only within one tool.
 * "Reject" is unrestricted — refusing work can never cause damage — but
 * "allow" is deliberately scoped, because the reason to batch an approval is
 * "I have seen what this tool does and I trust it here", and that reasoning is
 * per-tool. A single "allow everything" button would turn one click into
 * blanket consent across edits, shell commands and file deletions, which is
 * exactly the failure mode an approval step exists to prevent.
 *
 * There is therefore NO function here that produces a cross-tool allow set.
 * The invariant is enforced twice: the UI only ever offers per-group allow, and
 * ipc-registry.ts re-checks `commonTool()` before fanning out.
 */

/** The shape this module needs — a structural subset of PendingApproval. */
export interface ApprovalLike {
  approvalId: string
  toolName?: string
  ts?: number
}

/** One tool's pending approvals, as the UI renders them. */
export interface ApprovalGroup {
  toolName: string
  /** Oldest first — answer what has been waiting longest. */
  approvalIds: string[]
  /** Oldest `ts` in the group, so groups can be ordered the same way. */
  ts: number
}

/** Fallback label when a frame arrived without a tool name. */
export const UNKNOWN_TOOL = '未知工具'

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Group pending approvals by tool name.
 *
 * Ordering is deliberate and has to survive `Date.now()` collisions, which are
 * not hypothetical: an agent that queues six edits in the same millisecond
 * produces six identical timestamps, and an unstable sort would then shuffle
 * the buttons under the user's cursor between refreshes.
 *
 *   - groups: by oldest `ts` ascending, so the tool that has been blocked
 *     longest is the first button;
 *   - within a group: by `ts` ascending, ties broken by input order.
 */
export function groupApprovals(approvals: readonly ApprovalLike[]): ApprovalGroup[] {
  const order = new Map<string, number>()
  const groups = new Map<
    string,
    { toolName: string; items: { approvalId: string; ts: number; seq: number }[] }
  >()

  approvals.forEach((approval, seq) => {
    const id = typeof approval?.approvalId === 'string' ? approval.approvalId : ''
    if (!id) return // not answerable; the UI cannot do anything with it anyway
    const toolName =
      typeof approval.toolName === 'string' && approval.toolName.trim()
        ? approval.toolName
        : UNKNOWN_TOOL

    let group = groups.get(toolName)
    if (!group) {
      group = { toolName, items: [] }
      groups.set(toolName, group)
    }
    group.items.push({ approvalId: id, ts: num(approval.ts, Number.MAX_SAFE_INTEGER), seq })
    order.set(toolName, order.has(toolName) ? (order.get(toolName) as number) : seq)
  })

  const out: ApprovalGroup[] = []
  for (const group of groups.values()) {
    const items = group.items.slice().sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq))
    out.push({
      toolName: group.toolName,
      approvalIds: items.map((i) => i.approvalId),
      ts: items.length ? items[0].ts : Number.MAX_SAFE_INTEGER,
    })
  }
  // Group order: oldest first, ties broken by first appearance.
  out.sort((a, b) => (a.ts - b.ts) || ((order.get(a.toolName) ?? 0) - (order.get(b.toolName) ?? 0)))
  return out
}

/**
 * The one tool name shared by every id, or null when they disagree.
 *
 * Returns null rather than throwing or guessing, because every caller's
 * response to a disagreement is the same: refuse the batch. `null` also covers
 * "some id is no longer pending", which is not an error the user caused and
 * must not be reported as one — see `respondMany`'s skipped list.
 */
export function commonTool(
  approvals: readonly ApprovalLike[],
  ids: readonly string[],
): string | null {
  if (!ids.length) return null
  const byId = new Map<string, ApprovalLike>()
  for (const a of approvals) {
    if (a && typeof a.approvalId === 'string') byId.set(a.approvalId, a)
  }

  let tool: string | null = null
  for (const id of ids) {
    const approval = byId.get(id)
    if (!approval) return null
    const name =
      typeof approval.toolName === 'string' && approval.toolName.trim()
        ? approval.toolName
        : UNKNOWN_TOOL
    if (tool === null) tool = name
    else if (tool !== name) return null
  }
  return tool
}

/**
 * Coerce a renderer-supplied "list of ids" into a clean, de-duplicated array.
 *
 * Everything crossing an IPC boundary is untrusted, and the failure mode for a
 * sloppy id list is nasty rather than merely wrong: a duplicate would POST the
 * same approval twice, and a non-string would be serialised into a request the
 * host rejects with a reason the UI never surfaces.
 */
export function normalizeIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
