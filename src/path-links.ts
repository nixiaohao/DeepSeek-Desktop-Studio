/**
 * path-links.ts — recognise file paths inside backend output.
 *
 * Lets the monitor panel turn paths the agent prints into clickable links
 * ("打开"/"在文件夹显示"/"外部编辑器打开").
 *
 * Pure logic, no Electron, no fs — unit tested in test/paths.unit.cjs.
 *
 * This is HEURISTIC by necessity: output is free-form text, so there is no
 * way to know for certain that `/api/events` is a URL route and not a file.
 * The rules below aim for "never miss a real path, occasionally surface
 * something that isn't one" — a false positive costs one click, a false
 * negative costs the whole feature.
 */

export interface PathHit {
  /** The matched path text, with sentence punctuation trimmed off. */
  text: string
  /** Index of the match within the source string. */
  index: number
  length: number
}

/** Punctuation that ends a sentence rather than belonging to the path. */
const TRAILING = /[.,;:!?)\]}'">]+$/

/** Below this length a match is noise (e.g. `C:\a`, `/tmp`). */
const MIN_LEN = 4

/**
 * Characters that may legally precede a path. Anything else (letters, digits)
 * means we are looking at the tail of a longer token — this is what stops the
 * `s:` in `https://host/a/b` from being read as a Windows drive letter.
 */
const PATH_PREFIX = /[\s'"(`[|]/

/**
 * Paths containing spaces are NOT matched. Agent output usually quotes or
 * escapes them, and allowing spaces makes every sentence-ending word look
 * like part of the path. Trade-off: `C:\Program Files\...` is missed.
 */
const WINDOWS_RE = /[A-Za-z]:[\\/][^\s:*?"<>|]+/g
const POSIX_RE = /\/[^\s:*?"<>|]+/g

function trimTail(s: string): string {
  return s.replace(TRAILING, '')
}

/**
 * Accept only matches that look like a file or a project directory, to keep
 * URL routes (`/api/events`) out.
 */
function looksLikePath(p: string): boolean {
  if (p.length < MIN_LEN) return false
  if (p.startsWith('//')) return false // protocol-relative URL
  const segments = p.split(/[\\/]/).filter(Boolean)
  if (segments.length === 0) return false
  const last = segments[segments.length - 1]
  // A dot in the final segment strongly suggests a filename.
  if (last.includes('.')) return segments.length >= 2 || p.startsWith('/')
  // Otherwise require enough depth to be a plausible directory.
  return segments.length >= 3
}

/**
 * Find every plausible file path in `text`, ordered by position.
 * Windows matches win over overlapping POSIX matches.
 */
export function findPaths(text: string): PathHit[] {
  const hits: PathHit[] = []
  const claimed: [number, number][] = []

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s)

  // ── Windows: `C:\dir\file.ts` or `D:/dir/file.ts` ──
  WINDOWS_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WINDOWS_RE.exec(text)) !== null) {
    const start = m.index
    // A drive letter must start the string or follow a separator/quote.
    // Without this, the `s:` in `https://host/a/b` matches as a drive.
    const prevWin = start > 0 ? text[start - 1] : ''
    if (prevWin && !PATH_PREFIX.test(prevWin)) continue
    const raw = trimTail(m[0])
    if (raw.length === 0) continue
    const end = start + raw.length
    if (!looksLikePath(raw)) continue
    claimed.push([start, end])
    hits.push({ text: raw, index: start, length: raw.length })
  }

  // ── POSIX: `/home/user/proj/file.ts` ──
  POSIX_RE.lastIndex = 0
  while ((m = POSIX_RE.exec(text)) !== null) {
    const start = m.index
    const prev = start > 0 ? text[start - 1] : ''
    // Must start the string or follow whitespace/quote/bracket — this is what
    // excludes the path portion of `https://host/a/b` and `foo:/bar`.
    if (prev && !PATH_PREFIX.test(prev)) continue
    const raw = trimTail(m[0])
    if (raw.length === 0) continue
    const end = start + raw.length
    if (overlaps(start, end)) continue
    if (!looksLikePath(raw)) continue
    claimed.push([start, end])
    hits.push({ text: raw, index: start, length: raw.length })
  }

  hits.sort((a, b) => a.index - b.index)
  return hits
}

/** Cheap check for "is this whole string a path?" (used on click targets). */
export function isLikelyPath(candidate: string): boolean {
  const t = candidate.trim()
  if (t.length === 0) return false
  const hits = findPaths(t)
  return hits.length === 1 && hits[0].text === t
}
