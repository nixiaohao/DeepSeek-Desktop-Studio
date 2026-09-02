/**
 * highlight.ts — minimal, dependency-free syntax highlighting.
 *
 * WHY NOT A LIBRARY
 * -----------------
 * shiki/prism/highlight.js would each add ~1MB to the asar and a new
 * dependency, which docs/ide-shell-spec-2026-09-01.md §8 rules out. What the
 * overlays actually need is far less than a real grammar: the change-review
 * cards and the sidebar diff viewer show a few hundred lines at most, and
 * "which of these words is a keyword" carries most of the readability benefit.
 *
 * So: a single-pass tokenizer that colours keywords, strings, comments and
 * numbers per language FAMILY, and gives up (returns escaped plain text) on
 * anything it does not recognise.
 *
 * HARD RULES (each one exists because violating it is visible to the user)
 * -----------------------------------------------------------------------
 *  1. It must never throw. It runs on arbitrary agent output.
 *  2. It must be bounded. Input above HIGHLIGHT_MAX_CHARS is escaped, not
 *     tokenized — a 20MB generated file must not hang the renderer.
 *  3. An unterminated string ends at end-of-line, not at end-of-input. The
 *     panel truncates its preview at 100 lines, so the LAST line of a card is
 *     very often mid-string; consuming to EOF would paint the tail of the
 *     preview as one long string literal.
 *     Block comments are the exception: they legitimately span lines, so an
 *     unterminated one runs to EOF.
 *  4. Output must be HTML-escaped. Every span is escaped as it is emitted, and
 *     the tokenizer runs over the RAW text so escapes cannot shift offsets.
 *
 * Zero runtime imports, so it is unit-testable in plain node (see
 * test/modules.smoke.cjs, which asserts the require() list stays empty).
 */

/** Token classes. Short on purpose: they appear once per token in the output. */
export type TokenKind =
  /** keyword */
  | 'k'
  /** string */
  | 's'
  /** comment */
  | 'c'
  /** number */
  | 'n'
  /** tag / attribute / key name */
  | 'a'

/** Input longer than this is escaped verbatim rather than tokenized. */
export const HIGHLIGHT_MAX_CHARS = 400_000

// ── language tables ────────────────────────────────────────────────────────

/**
 * Which state machine to run. Languages inside a family differ only in their
 * keyword set, which is why the families exist at all.
 */
export type Family = 'c' | 'hash' | 'html' | 'css' | 'json' | 'md' | 'sql' | 'text'

const FAMILY: Record<string, Family> = {
  ts: 'c', tsx: 'c', mts: 'c', cts: 'c',
  js: 'c', jsx: 'c', mjs: 'c', cjs: 'c',
  java: 'c', c: 'c', h: 'c', cpp: 'c', hpp: 'c', cc: 'c', cs: 'c',
  go: 'c', rs: 'c', php: 'c', kt: 'c', swift: 'c', scala: 'c',
  py: 'hash', pyi: 'hash', rb: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash',
  fish: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash', ini: 'hash',
  cfg: 'hash', conf: 'hash', env: 'hash', ps1: 'hash',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  json: 'json', jsonc: 'json', json5: 'json',
  md: 'md', markdown: 'md',
  sql: 'sql',
}

/** Keywords shared by the C-like family. Union, not per-language: cheap and good enough. */
const C_KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'base', 'bool', 'boolean', 'break', 'byte',
  'case', 'catch', 'char', 'checked', 'class', 'const', 'constexpr', 'continue',
  'debugger', 'declare', 'default', 'defer', 'delegate', 'delete', 'do', 'double',
  'elif', 'else', 'elseif', 'enum', 'event', 'except', 'explicit', 'export', 'extends',
  'extern', 'false', 'final', 'finally', 'fixed', 'float', 'fn', 'for', 'foreach',
  'from', 'func', 'function', 'get', 'global', 'go', 'goto', 'if', 'implements',
  'impl', 'import', 'in', 'include', 'inline', 'instanceof', 'int', 'interface',
  'internal', 'is', 'lambda', 'let', 'lock', 'long', 'match', 'mod', 'module',
  'mut', 'namespace', 'native', 'new', 'nil', 'none', 'nonlocal', 'not', 'null',
  'nullptr', 'object', 'operator', 'or', 'out', 'override', 'package', 'private',
  'protected', 'public', 'readonly', 'record', 'ref', 'register', 'require',
  'return', 'sbyte', 'sealed', 'set', 'short', 'sizeof', 'static', 'string',
  'struct', 'super', 'switch', 'synchronized', 'template', 'then', 'this', 'throw',
  'throws', 'trait', 'true', 'try', 'type', 'typedef', 'typeof', 'uint', 'ulong',
  'unchecked', 'union', 'unless', 'unsafe', 'unsigned', 'use', 'using', 'ushort',
  'val', 'var', 'virtual', 'void', 'volatile', 'when', 'where', 'while', 'with',
  'yield',
])

const HASH_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'elif', 'except', 'exec', 'False', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'local',
  'None', 'nonlocal', 'not', 'or', 'pass', 'print', 'raise', 'return', 'self',
  'True', 'try', 'while', 'with', 'yield', 'function', 'fi', 'esac', 'do',
  'done', 'then', 'export', 'source', 'alias', 'set', 'unset', 'readonly',
  'declare', 'typeset', 'echo', 'cd', 'exit', 'eval', 'shift', 'trap',
])

const SQL_KEYWORDS = new Set([
  'add', 'all', 'alter', 'and', 'any', 'as', 'asc', 'between', 'by', 'case',
  'cast', 'check', 'column', 'constraint', 'create', 'cross', 'default',
  'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'exists', 'foreign',
  'from', 'full', 'group', 'having', 'in', 'index', 'inner', 'insert', 'into',
  'is', 'join', 'key', 'left', 'like', 'limit', 'not', 'null', 'offset', 'on',
  'or', 'order', 'outer', 'primary', 'references', 'right', 'select', 'set',
  'table', 'then', 'top', 'union', 'unique', 'update', 'values', 'view',
  'when', 'where', 'with',
])

// ── public API ─────────────────────────────────────────────────────────────

/** Map a path (or just a filename) to a language id. Unknown → 'text'. */
export function languageForPath(path: string): string {
  if (!path) return 'text'
  const raw = path.replace(/\\/g, '/')
  const name = raw.slice(raw.lastIndexOf('/') + 1)
  // Dotfiles are usually language-less config (`.gitignore`, `.env`) but there
  // are two common exceptions worth naming, and `.env` is shell-ish.
  if (name.startsWith('.')) {
    const bare = name.slice(1).toLowerCase()
    if (bare === 'env' || bare.endsWith('rc')) return 'sh'
  }
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    // No extension but a well-known name: these really do show up in diffs.
    const lower = name.toLowerCase()
    if (lower === 'dockerfile') return 'sh'
    if (lower === 'makefile') return 'sh'
    if (lower === 'cmakelists.txt') return 'sh'
    return 'text'
  }
  const ext = name.slice(dot + 1).toLowerCase()
  const lower = name.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'sh'
  if (lower === 'cmakelists.txt') return 'sh'
  return ext in FAMILY ? ext : 'text'
}

/** Which state machine a language id maps to. */
export function familyFor(lang: string): Family {
  return FAMILY[lang] ?? 'text'
}

/** Escape for HTML text AND attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Highlight `code` and return an HTML fragment.
 *
 * Emits `<span class="tok-k">…</span>` etc. — CLASSES, not inline styles,
 * because the overlay pages run under a CSP that permits `style-src
 * 'unsafe-inline'` for their own <style> block but is one edit away from
 * tightening. Each page defines the colours.
 *
 * Never throws: anything unexpected degrades to escaped plain text.
 */
export function highlightCode(code: string, lang: string): string {
  try {
    if (typeof code !== 'string' || code.length === 0) return ''
    if (code.length > HIGHLIGHT_MAX_CHARS) return escapeHtml(code)
    const family = familyFor(lang)
    if (family === 'text') return escapeHtml(code)

    const out: string[] = []
    const push = (kind: TokenKind | null, text: string): void => {
      if (!text) return
      out.push(kind === null ? escapeHtml(text) : `<span class="tok-${kind}">${escapeHtml(text)}</span>`)
    }

    switch (family) {
      case 'c': tokenizeC(code, C_KEYWORDS, push); break
      case 'hash': tokenizeHash(code, HASH_KEYWORDS, push); break
      case 'sql': tokenizeC(code, SQL_KEYWORDS, push, true); break
      case 'html': tokenizeHtml(code, push); break
      case 'css': tokenizeCss(code, push); break
      case 'json': tokenizeJson(code, push); break
      case 'md': tokenizeMarkdown(code, push); break
      default: return escapeHtml(code)
    }
    return out.join('')
  } catch {
    // Rule 1: a tokenizer bug must render as plain text, not as a dead panel.
    return escapeHtml(typeof code === 'string' ? code : '')
  }
}

// ── shared scanners ────────────────────────────────────────────────────────

type Push = (kind: TokenKind | null, text: string) => void

/** Identifier: C-like languages are generous, SQL is not ($ is not an ident there). */
const RE_IDENT = /[A-Za-z_$@#][\w$@#]*/g
const RE_IDENT_PLAIN = /[A-Za-z_][\w]*/g

const RE_NUMBER =
  /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)[A-Za-z_]*/g

/**
 * Read a quoted run starting at the quote character.
 *
 * `allowTriple` handles Python's '''/""". Returns the index just past the
 * closing quote, or past the end-of-line when the string is never closed
 * (rule 3) — the caller must not let a truncated preview swallow the tail.
 */
function scanString(
  code: string,
  start: number,
  quote: string,
  allowTriple: boolean
): number {
  let i = start
  let width = quote.length
  if (allowTriple && code.startsWith(quote.repeat(3), start)) width = 3
  i += width
  while (i < code.length) {
    const ch = code[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '\n' && width !== 3) return i // unterminated → stop at EOL
    if (width === 3 && code.startsWith(quote.repeat(3), i)) return i + 3
    if (width !== 3 && ch === quote) return i + 1
    i += 1
  }
  return i
}

// ── C-like family ──────────────────────────────────────────────────────────

function tokenizeC(
  code: string,
  keywords: ReadonlySet<string>,
  push: Push,
  caseInsensitive = false
): void {
  const len = code.length
  let plain = ''
  let i = 0
  const flush = (): void => { if (plain) { push(null, plain); plain = '' } }

  while (i < len) {
    const ch = code[i]

    // Line comment — SQL spells it `--`.
    if ((ch === '/' && code[i + 1] === '/') || (caseInsensitive && ch === '-' && code[i + 1] === '-')) {
      let end = code.indexOf('\n', i)
      if (end < 0) end = len
      flush(); push('c', code.slice(i, end)); i = end; continue
    }

    // Block comment. Unterminated runs to EOF (legitimately multi-line).
    if (ch === '/' && code[i + 1] === '*') {
      let end = code.indexOf('*/', i + 2)
      if (end < 0) end = len
      else end += 2
      flush(); push('c', code.slice(i, end)); i = end; continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const end = scanString(code, i, ch, false)
      flush(); push('s', code.slice(i, end)); i = end; continue
    }

    if (ch >= '0' && ch <= '9') {
      RE_NUMBER.lastIndex = i
      const m = RE_NUMBER.exec(code)
      if (m && m.index === i) { flush(); push('n', m[0]); i += m[0].length; continue }
    }

    const re = caseInsensitive ? RE_IDENT_PLAIN : RE_IDENT
    if (/[A-Za-z_$@]/.test(ch)) {
      re.lastIndex = i
      const m = re.exec(code)
      if (m && m.index === i) {
        const word = m[0]
        const lookup = caseInsensitive ? word.toLowerCase() : word
        flush(); push(keywords.has(lookup) ? 'k' : null, word); i += word.length; continue
      }
    }

    plain += ch
    i += 1
  }
  flush()
}

// ── hash-comment family (python / shell / yaml / …) ────────────────────────

function tokenizeHash(code: string, keywords: ReadonlySet<string>, push: Push): void {
  const len = code.length
  let plain = ''
  let i = 0
  const flush = (): void => { if (plain) { push(null, plain); plain = '' } }
  // Line-start matters: in YAML/make, `#` only starts a comment when it is not
  // inside a token, and in shell a `#` glued to a word is part of the word.
  // Treating line-start specially is enough for both.
  let atLineStart = true

  while (i < len) {
    const ch = code[i]

    if (ch === '\n') { plain += ch; i += 1; atLineStart = true; continue }

    // ORDER MATTERS: `atLineStart` describes the character at `i`, so it has to
    // be read before it is cleared. Clearing first (and `#` is not whitespace,
    // so it always clears) meant the only line-start comment ever recognised was
    // one indented by at least one space — a `#` in column 0 fell through as
    // plain text, which is where a shell shebang and most Python comments live.
    if (ch === '#' && (atLineStart || code[i - 1] === ' ' || code[i - 1] === '\t')) {
      let end = code.indexOf('\n', i)
      if (end < 0) end = len
      flush(); push('c', code.slice(i, end)); i = end; continue
    }

    if (ch !== ' ' && ch !== '\t') atLineStart = false

    if (ch === '"' || ch === "'") {
      const end = scanString(code, i, ch, true)
      flush(); push('s', code.slice(i, end)); i = end; continue
    }

    if (ch >= '0' && ch <= '9') {
      RE_NUMBER.lastIndex = i
      const m = RE_NUMBER.exec(code)
      if (m && m.index === i) { flush(); push('n', m[0]); i += m[0].length; continue }
    }

    if (/[A-Za-z_$@]/.test(ch)) {
      RE_IDENT.lastIndex = i
      const m = RE_IDENT.exec(code)
      if (m && m.index === i) {
        const word = m[0]
        flush(); push(keywords.has(word) ? 'k' : null, word); i += word.length; continue
      }
    }

    plain += ch
    i += 1
  }
  flush()
}

// ── HTML / XML ─────────────────────────────────────────────────────────────

/**
 * Tags, attributes and attribute values only. Text between tags stays plain —
 * colouring every word of a paragraph would be noise, and this runs on files
 * the user is skimming, not editing.
 *
 * `<script>` / `<style>` bodies are emitted verbatim: highlighting them
 * properly needs the CSS/JS machines plus the closing-tag search, and a
 * half-coloured script body looks worse than a plain one.
 */
function tokenizeHtml(code: string, push: Push): void {
  const len = code.length
  let i = 0

  while (i < len) {
    // Comment.
    if (code.startsWith('<!--', i)) {
      let end = code.indexOf('-->', i + 4)
      end = end < 0 ? len : end + 3
      push('c', code.slice(i, end)); i = end; continue
    }

    if (code[i] === '<' && /[A-Za-z!/]/.test(code[i + 1] ?? '')) {
      // Emit the tag, then decide what to do with the body.
      let end = code.indexOf('>', i)
      if (end < 0) end = len
      else end += 1
      const tagText = code.slice(i, end)
      pushTag(tagText, push)

      const bare = tagText.replace(/^<\/?\s*/, '').replace(/\s*>$/, '').toLowerCase()
      const rawBody = bare === 'script' || bare === 'style'
      if (rawBody) {
        const closeAt = code.toLowerCase().indexOf('</' + bare, end)
        const stop = closeAt < 0 ? len : closeAt
        push(null, code.slice(end, stop))
        i = stop
      } else {
        i = end
      }
      continue
    }

    // Plain text up to the next tag or comment.
    let next = i
    while (next < len && code[next] !== '<') next += 1
    if (next === i) next = i + 1
    push(null, code.slice(i, next))
    i = next
  }
}

/** One `<tag attr="v">` — plus doctype/CDATA/PI, which are punctuation only. */
function pushTag(tag: string, push: Push): void {
  // Not a real tag: <!DOCTYPE …>, <?xml …?>, <![CDATA[ … ]]>.
  if (tag.startsWith('<!') || tag.startsWith('<?')) { push('c', tag); return }

  let i = 0
  push(null, tag[i] ?? '')
  i += 1
  if (tag[i] === '/') { push(null, '/'); i += 1 }

  const m = /^[^\s/>]*/.exec(tag.slice(i))
  if (m && m[0]) { push('a', m[0]); i += m[0].length }

  while (i < tag.length) {
    const ch = tag[i]
    if (ch === '"' || ch === "'") {
      const end = scanString(tag, i, ch, false)
      push('s', tag.slice(i, end)); i = end; continue
    }
    if (/[A-Za-z_:@.$#-]/.test(ch)) {
      const am = /^[^\s=/>]*/.exec(tag.slice(i))
      const word = am ? am[0] : ch
      // An attribute name directly followed by `=`; a bare word is a value.
      const after = tag.slice(i + word.length)
      push(/^\s*=/.test(after) ? 'a' : null, word)
      i += word.length
      continue
    }
    push(null, ch)
    i += 1
  }
}

// ── CSS ────────────────────────────────────────────────────────────────────

function tokenizeCss(code: string, push: Push): void {
  const len = code.length
  let plain = ''
  let i = 0
  const flush = (): void => { if (plain) { push(null, plain); plain = '' } }

  while (i < len) {
    const ch = code[i]

    if (ch === '/' && code[i + 1] === '*') {
      let end = code.indexOf('*/', i + 2)
      end = end < 0 ? len : end + 2
      flush(); push('c', code.slice(i, end)); i = end; continue
    }

    if (ch === '"' || ch === "'") {
      const end = scanString(code, i, ch, false)
      flush(); push('s', code.slice(i, end)); i = end; continue
    }

    // @media / @import / …
    if (ch === '@') {
      const m = /^@[\w-]*/.exec(code.slice(i))
      if (m) { flush(); push('k', m[0]); i += m[0].length; continue }
    }

    if (ch >= '0' && ch <= '9') {
      const m = /^(?:\d*\.\d+|\d+)(?:[a-zA-Z%]*)/.exec(code.slice(i))
      if (m) { flush(); push('n', m[0]); i += m[0].length; continue }
    }

    if (/[A-Za-z_-]/.test(ch)) {
      const m = /^[\w-]*/.exec(code.slice(i))
      const word = m ? m[0] : ch
      // A property is a word followed by `:`; a bare word is a selector.
      const after = code.slice(i + word.length)
      flush(); push(/^\s*:/.test(after) ? 'a' : null, word); i += word.length; continue
    }

    plain += ch
    i += 1
  }
  flush()
}

// ── JSON ───────────────────────────────────────────────────────────────────

/**
 * Keys are distinguished from values by the `:` that follows. That one rule is
 * the whole reason JSON gets its own machine instead of riding the C one — it
 * is also the only thing that makes a 300-line config skimmable.
 */
function tokenizeJson(code: string, push: Push): void {
  const len = code.length
  let i = 0
  const literals = new Set(['true', 'false', 'null'])

  while (i < len) {
    const ch = code[i]

    if (ch === '"') {
      let end = scanString(code, i, '"', false)
      // A string unterminated at EOL: in JSON that is invalid input, but we
      // still must not swallow the rest of the file.
      if (end === i + 1 && code[end - 1] !== '"') end = Math.max(end, i + 1)
      const text = code.slice(i, end)
      const after = code.slice(end)
      push(/^\s*:/.test(after) ? 'a' : 's', text)
      i = end
      continue
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(code.slice(i))
      if (m) { push('n', m[0]); i += m[0].length; continue }
    }

    if (/[A-Za-z]/.test(ch)) {
      const m = /^[A-Za-z]+/.exec(code.slice(i))
      const word = m ? m[0] : ch
      push(literals.has(word) ? 'k' : null, word)
      i += word.length
      continue
    }

    push(null, ch)
    i += 1
  }
}

// ── Markdown ───────────────────────────────────────────────────────────────

/**
 * Headings, fenced blocks and inline code. Deliberately not more: a markdown
 * "grammar" that colours half the document is harder to read than none.
 */
function tokenizeMarkdown(code: string, push: Push): void {
  const lines = code.split('\n')
  let inFence = false

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    const isLast = n === lines.length - 1

    const fence = /^\s*(```|~~~)/.test(line)
    if (fence) { push('c', line); inFence = !inFence; if (!isLast) push(null, '\n'); continue }
    if (inFence) { push(null, line); if (!isLast) push(null, '\n'); continue }

    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      push('k', line)
    } else if (/^\s{0,3}>/.test(line) || /^\s*([-*_]\s*){3,}$/.test(line)) {
      push('c', line)
    } else {
      // Inline code spans, kept as strings; everything else plain.
      let i = 0
      while (i < line.length) {
        if (line[i] === '`') {
          let end = line.indexOf('`', i + 1)
          if (end < 0) end = line.length
          else end += 1
          push('s', line.slice(i, end))
          i = end
          continue
        }
        let next = line.indexOf('`', i)
        if (next < 0) next = line.length
        push(null, line.slice(i, next))
        i = next
      }
    }
    if (!isLast) push(null, '\n')
  }
}
