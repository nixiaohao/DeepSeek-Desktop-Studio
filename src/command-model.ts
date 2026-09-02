/**
 * command-model.ts — pure filtering/ranking behind the command palette.
 *
 * ZERO DEPENDENCIES by the same argument as settings-model.ts and
 * diagnostics.ts: the palette is the thing a user reaches for when they have
 * lost track of the UI, so it must be the last thing to break. Everything it
 * does (subsequence matching, scoring, tie-breaking) is unit-testable in plain
 * node, and the sandboxed palette preload can never be asked to require more
 * than `electron` — the command list itself is main-process data, handed over
 * IPC already built (see command-registry.ts).
 *
 * Matching is a case-insensitive subsequence match against the command title:
 * "sd" matches "Show Status bar" — the `s` and `d` appear in order, with
 * skipped characters allowed. That is the VS Code-style behaviour users expect
 * from a Ctrl+K palette, and unlike substring matching it forgives skipped
 * characters while still rewarding tighter matches.
 */

/** One entry the palette can list. Built in the main process. */
export interface Command {
  /** Stable identifier the renderer sends back on `palette:run`. */
  id: string
  /** Human title shown in the palette; also the fuzzy-match target. */
  title: string
  /** Optional right-aligned hint (accelerator or category). Not matched. */
  hint?: string
}

/** A command that survived filtering, with its score and matched positions. */
export interface CommandMatch {
  command: Command
  score: number
  /** Ascending indices into `command.title` of the matched characters. */
  ranges: number[]
}

/**
 * Lower-cased, whitespace-collapsed query. Empty after normalisation means
 * "no query": the palette then lists every command in definition order.
 */
function normalizeQuery(query: string): string {
  return String(query ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** True when `ch` is the first character of a "word" inside `title`. */
function isWordStart(title: string, index: number): boolean {
  if (index === 0) return true
  const prev = title[index - 1]
  // Any non-alphanumeric boundary counts: spaces, punctuation, CJK handled
  // implicitly (CJK chars are "word starts" after any separator, which is the
  // behaviour Chinese titles want).
  return !/[a-z0-9]/i.test(prev)
}

/** Score one query against one title; null when the query is not a subsequence. */
function scoreTitle(query: string, title: string): number[] | null {
  const lowerTitle = title.toLowerCase()
  const ranges: number[] = []
  let searchFrom = 0
  for (const ch of query) {
    const found = lowerTitle.indexOf(ch, searchFrom)
    if (found < 0) return null
    ranges.push(found)
    searchFrom = found + 1
  }
  return ranges
}

/**
 * Filter and rank `commands` against `query`.
 *
 * Empty (or whitespace-only) query → every command, definition order, no
 * ranges. Non-empty query → only subsequence matches, best score first, ties
 * broken by definition order so the list is stable across keystrokes.
 */
export function filterCommands(commands: readonly Command[], query: string): CommandMatch[] {
  const normalized = normalizeQuery(query)
  if (normalized === '') {
    return commands
      .filter(
        (c): c is Command =>
          !!c && typeof (c as Command).id === 'string' && typeof (c as Command).title === 'string',
      )
      .map((command) => ({ command, score: 0, ranges: [] }))
  }

  const matches: Array<{ match: CommandMatch; order: number }> = []
  for (let order = 0; order < commands.length; order += 1) {
    const command = commands[order] as Command | null | undefined
    // Defensive: a registry entry shaped wrong (or junk injected by a future
    // caller) is skipped, never a crash in front of the user.
    if (!command || typeof command.id !== 'string' || typeof command.title !== 'string') continue
    const ranges = scoreTitle(normalized, command.title)
    if (ranges === null) continue

    let score = 0
    for (let i = 0; i < ranges.length; i += 1) {
      score += 10
      if (i > 0 && ranges[i] === ranges[i - 1] + 1) score += 10
      if (isWordStart(command.title, ranges[i])) score += 8
    }
    const lowerTitle = command.title.toLowerCase()
    if (lowerTitle === normalized) {
      score += 50
    } else if (lowerTitle.startsWith(normalized)) {
      score += 30
    }
    matches.push({ match: { command, score, ranges }, order })
  }

  matches.sort((a, b) => (b.match.score - a.match.score) || (a.order - b.order))
  return matches.map((entry) => entry.match)
}
