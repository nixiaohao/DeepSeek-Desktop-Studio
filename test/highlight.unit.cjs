/**
 * Unit tests for src/highlight.ts.
 *
 * The interesting cases are the ones that only happen with REAL agent output:
 * truncated previews that cut a string in half, unterminated block comments,
 * paths with no extension, and input big enough to matter. Round-tripping
 * "hello world" through the tokenizer proves nothing.
 *
 * Run with: npm test
 */
const fs = require('node:fs')
const path = require('node:path')

const {
  languageForPath,
  familyFor,
  escapeHtml,
  highlightCode,
  HIGHLIGHT_MAX_CHARS,
} = require('../lib-new/highlight.js')

const ROOT = path.join(__dirname, '..')

let pass = 0
let fail = 0
function ok(label) {
  pass++
  console.log(`  PASS  ${label}`)
}
function bad(label, detail) {
  fail++
  console.log(`  FAIL  ${label}\n        ${detail}`)
}
function check(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) ok(label)
  else bad(label, `got ${a}\n        want ${e}`)
}
function section(name, fn) {
  console.log(`highlight: ${name}`)
  return fn()
}

/** Strip the markup back to plain text — the invariant that must always hold. */
function plainOf(html) {
  return html
    .replace(/<span class="tok-[a-z]">/g, '')
    .replace(/<\/span>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Build the expected span for one token.
 *
 * The escaping is applied by the same `escapeHtml` the module uses, which is
 * NOT circular: `escapeHtml` is tested directly above, and what these
 * assertions are actually pinning down is the token BOUNDARIES and the KIND —
 * i.e. that `"hi"` is one string token and not `"` + `hi` + `"`.
 *
 * It exists because the module escapes quotes (`"` → `&quot;`), so a regex
 * written with a literal `"` silently never matches, and the failure looks like
 * "the tokenizer produced no string" rather than "my expectation was wrong".
 */
function tok(kind, text) {
  return `<span class="tok-${kind}">${escapeHtml(text)}</span>`
}

main()
function main() {
  section('language detection', () => {
    check(languageForPath('src/main.ts'), 'ts', '.ts → ts')
    check(languageForPath('C:\\work\\a\\b.tsx'), 'tsx', 'backslash path still resolves')
    check(languageForPath('script.py'), 'py', '.py → py')
    check(languageForPath('Dockerfile'), 'sh', 'extensionless Dockerfile → sh')
    check(languageForPath('Makefile'), 'sh', 'extensionless Makefile → sh')
    check(languageForPath('CMakeLists.txt'), 'sh', 'CMakeLists.txt → sh, not text')
    check(languageForPath('.env'), 'sh', 'dotfile .env → sh')
    check(languageForPath('.bashrc'), 'sh', 'dotfile .bashrc → sh')
    check(languageForPath('README'), 'text', 'no extension, unknown name → text')
    check(languageForPath(''), 'text', 'empty path → text')
    check(languageForPath('a.weirdext'), 'text', 'unknown extension → text')
    check(languageForPath('pkg/lib/index.d.ts'), 'ts', 'dots earlier in the name are not the extension')
    check(familyFor('ts'), 'c', 'ts is in the C family')
    check(familyFor('py'), 'hash', 'py is in the hash family')
    check(familyFor('nonsense'), 'text', 'unknown language → text family')
  })

  section('escaping', () => {
    check(escapeHtml('<script>&"'), '&lt;script&gt;&amp;&quot;', 'escapes the four that matter')
    // The overlay pages put highlighted output inside elements, so a `"` or `'`
    // leaking into an attribute would break the page, not just misrender it.
    const html = highlightCode('const a = "<b>\'x\'";', 'ts')
    check(/&lt;b&gt;/.test(html), true, 'HTML inside a string is escaped')
    check(html.includes('<span'), true, 'but the token spans are still emitted')
    // Quotes are escaped too, even though the fragment only ever lands in
    // element content. It costs 6 bytes per quote and buys the freedom to
    // interpolate the fragment into an attribute later without re-auditing
    // every call site. Pinned here so the choice is deliberate, not inherited.
    check(highlightCode('"a"', 'ts'), tok('s', '"a"'), 'quotes are escaped inside tokens')
  })

  section('round-trip: markup never loses or invents characters', () => {
    const samples = [
      ['const x = 1; // hi\nconst y = "a\\"b";', 'ts'],
      ['def f():\n    return """doc"""\n# trailing', 'py'],
      ['{"a": [1, 2.5, true, null], "b": "c"}', 'json'],
      ['<div class="x" data-y=\'1\'>text</div>', 'html'],
      ['.a { color: #fff; margin: 0 auto; }', 'css'],
      ['# Title\n\n```js\nlet a = 1;\n```\n\n`inline`', 'md'],
      ['SELECT * FROM t WHERE a = 1 -- note', 'sql'],
      ['export FOO=bar\necho "$FOO" # done', 'sh'],
    ]
    for (const [src, lang] of samples) {
      check(plainOf(highlightCode(src, lang)), src, `round-trip ${lang}`)
    }
  })

  section('C family', () => {
    const html = highlightCode('const x = 1; // note\nlet s = "hi";', 'ts')
    check(/<span class="tok-k">const<\/span>/.test(html), true, 'const is a keyword')
    check(/<span class="tok-n">1<\/span>/.test(html), true, '1 is a number')
    check(/<span class="tok-c">\/\/ note<\/span>/.test(html), true, '// runs to EOL only')
    check(html.includes(tok('s', '"hi"')), true, 'string is delimited')

    check(highlightCode('0xFF 0b1010 1_000 1.5e-3', 'js').match(/tok-n/g).length, 4, 'all four number forms')
    // A keyword used as part of a longer identifier must NOT be coloured.
    check(/<span class="tok-k">class<\/span>/.test(highlightCode('class', 'ts')), true, 'bare class')
    check(/<span class="tok-k">class<\/span>/.test(highlightCode('classy', 'ts')), false, 'classy is not the keyword')
    check(/<span class="tok-k">class<\/span>/.test(highlightCode('myclass', 'ts')), false, 'nor is myclass')
  })

  section('truncated previews (the case that actually happens)', () => {
    // Rule 3: an unterminated string ends at end-of-LINE, not end-of-input.
    // The sample therefore has lines AFTER the cut — without that, the two
    // behaviours produce byte-identical output and the assertion is blind.
    const cut = highlightCode('const a = "one";\nconst b = "unterminated\nconst c = 2;', 'ts')
    check(cut.includes(tok('s', '"one"')), true, 'the terminated string still highlights')
    // The whole point: with the rule, line 3 is code again. Without it, it is
    // inside the string from line 2 and `2` never becomes a number token.
    check(cut.includes(tok('n', '2')), true, 'code after an unterminated string still highlights')
    check(cut.includes(tok('k', 'const')), true, 'and its keywords too')

    // A block comment legitimately spans lines, so it is allowed to run to EOF.
    // Asserted on the WHOLE output: a substring search for `b` would pass even
    // when the comment stops early, because `b` is present either way.
    check(
      highlightCode('a\n/* not closed\nb\nc', 'ts'),
      'a\n' + tok('c', '/* not closed\nb\nc'),
      'an unterminated block comment swallows the rest of the input'
    )
  })

  section('hash family', () => {
    const py = highlightCode('def f():\n    return """doc"""\n# note', 'py')
    check(/<span class="tok-k">def<\/span>/.test(py), true, 'def is a keyword')
    check(py.includes(tok('s', '"""doc"""')), true, 'triple-quoted string stays one token')
    // A `#` in COLUMN 0 — the regression: `atLineStart` was cleared before the
    // comment test ran, so only an indented `#` was ever recognised.
    check(py.includes(tok('c', '# note')), true, 'hash comment at column 0')
    // The leading indentation stays plain, exactly as it does for `//` in the
    // C family — whitespace is not part of the token.
    check(highlightCode('  # x', 'py'), '  ' + tok('c', '# x'), 'indented hash comment')
    check(highlightCode('#!/usr/bin/env bash', 'sh').includes(tok('c', '#!/usr/bin/env bash')), true, 'shebang')

    // A `#` glued to a word is not a comment (shell ${#arr}, python a#b is rare
    // but the rule keeps URLs and anchors from being eaten).
    check(/tok-c/.test(highlightCode('echo a#b', 'sh')), false, 'a#b has no comment')
    check(/tok-c/.test(highlightCode('echo a #b', 'sh')), true, 'a #b does')

    check(/tok-s/.test(highlightCode('url = "http://x/#frag"', 'py')), true, 'a # inside a string is not a comment')
  })

  section('JSON', () => {
    const html = highlightCode('{"key": "value", "n": 1}', 'json')
    check(html.includes(tok('a', '"key"')), true, 'a key (followed by :) is tok-a')
    check(html.includes(tok('s', '"value"')), true, 'a value is tok-s')
    check(/<span class="tok-n">1<\/span>/.test(html), true, 'numbers')
    check(/<span class="tok-k">true<\/span>/.test(highlightCode('true', 'json')), true, 'literals')
    // Only the key directly before the colon, not any string that happens to
    // be followed by a colon somewhere later.
    const two = highlightCode('{"a": "b", "c": "d"}', 'json')
    check((two.match(/tok-a/g) || []).length, 2, 'exactly two keys')
  })

  section('HTML', () => {
    const html = highlightCode('<div class="x">text</div>', 'html')
    check(/<span class="tok-a">div<\/span>/.test(html), true, 'tag name')
    check(/<span class="tok-a">class<\/span>/.test(html), true, 'attribute name')
    check(html.includes(tok('s', '"x"')), true, 'attribute value')
    check(/tok-a[^>]*>text/.test(html), false, 'text between tags is not a tag name')
    // A bare (unquoted) attribute value is a value, not a name.
    const bare = highlightCode('<div data-x=bare>', 'html')
    check(bare.includes(tok('a', 'bare')), false, 'a bare attribute value is not a name')
    check(bare.includes(tok('a', 'data-x')), true, 'but the attribute before = is')
    // Script bodies are emitted verbatim rather than half-coloured.
    check(/tok-k/.test(highlightCode('<script>const a=1</script>', 'html')), false, 'script body is not tokenized')
    check(/tok-c/.test(highlightCode('<!-- x -->', 'html')), true, 'comments')
  })

  section('CSS', () => {
    const css = highlightCode('.sel { color: #fff; margin: 0 auto; }', 'css')
    check(css.includes(tok('a', 'color')), true, 'property before : is tok-a')
    check(css.includes(tok('a', 'margin')), true, 'and margin')
    // Target the WORD, not `.sel`: the leading `.` is its own plain token, so a
    // pattern like `tok-a[^>]*>\.sel` could never match and proved nothing.
    check(css.includes(tok('a', 'sel')), false, 'a selector is not a property')
    check(/tok-c/.test(highlightCode('/* x */', 'css')), true, 'comments')
    check(/<span class="tok-k">@media<\/span>/.test(highlightCode('@media print {}', 'css')), true, 'at-rules')
  })

  section('SQL', () => {
    const sql = highlightCode('SELECT * FROM t WHERE a = 1 -- note', 'sql')
    check(/<span class="tok-k">SELECT<\/span>/.test(sql), true, 'uppercase keyword')
    check(/<span class="tok-k">select<\/span>/.test(highlightCode('select 1', 'sql')), true, 'lowercase keyword too')
    check(/<span class="tok-c">-- note<\/span>/.test(sql), true, '-- is a SQL line comment')
  })

  section('markdown', () => {
    const md = highlightCode('# Title\n\ntext\n\n```js\nlet a=1\n```\n', 'md')
    check(/<span class="tok-k"># Title<\/span>/.test(md), true, 'heading')
    check(md.includes('let a=1'), true, 'fence body is preserved')
    check(/tok-s/.test(highlightCode('a `code` b', 'md')), true, 'inline code')
    check(plainOf(md), '# Title\n\ntext\n\n```js\nlet a=1\n```\n', 'markdown round-trips exactly')
  })

  section('robustness', () => {
    check(highlightCode('', 'ts'), '', 'empty string')
    check(highlightCode(null, 'ts'), '', 'null does not throw')
    check(highlightCode(undefined, 'ts'), '', 'undefined does not throw')
    check(highlightCode('plain', 'text'), 'plain', 'unknown language is escaped verbatim')
    check(highlightCode('<x>', 'text'), '&lt;x&gt;', 'unknown language still escapes')

    // Unterminated everything, all at once.
    const nasty = '/* " \' ` \\ <div class=" // #'
    check(plainOf(highlightCode(nasty, 'ts')), nasty, 'unterminated soup round-trips')
    check(typeof highlightCode(nasty, 'html'), 'string', 'and does not throw for html')
    check(typeof highlightCode(nasty, 'py'), 'string', 'or py')
    check(typeof highlightCode(nasty, 'json'), 'string', 'or json')
    check(typeof highlightCode(nasty, 'css'), 'string', 'or css')
    check(typeof highlightCode(nasty, 'md'), 'string', 'or md')
    check(typeof highlightCode(nasty, 'sql'), 'string', 'or sql')

    // Lone surrogates / control characters from real files.
    check(typeof highlightCode(' ', 'ts'), 'string', 'weird bytes do not throw')
  })

  section('the size cap is real', () => {
    // NOT `'a'.repeat(n)`: a run of letters tokenizes to a single plain token,
    // so the escaped and the tokenized output are byte-identical and the
    // assertion passes whether or not the cap exists. The sample has to be
    // something the tokenizer would actually mark up.
    const unit = 'const a = 1;\n'
    const huge = unit.repeat(Math.ceil((HIGHLIGHT_MAX_CHARS + 1) / unit.length))
    check(huge.length > HIGHLIGHT_MAX_CHARS, true, 'the sample really is over the cap')
    const out = highlightCode(huge, 'ts')
    check(out, escapeHtml(huge), 'oversized input is escaped, not tokenized')
    check(/tok-/.test(out), false, 'and carries no markup at all')
    // Just under the cap still highlights, so the cap is a boundary not a rule.
    check(/tok-/.test(highlightCode('const a = 1;'.repeat(1000), 'ts')), true, 'normal sizes still highlight')
  })

  section('bounded work (a pathological file must not hang)', () => {
    // Every quote unterminated, every line a new one: the worst case for the
    // "stop at EOL" rule, and the shape of a minified dump.
    const started = Date.now()
    const src = ('const a = "x\n'.repeat(20000))
    highlightCode(src.slice(0, HIGHLIGHT_MAX_CHARS), 'ts')
    const ms = Date.now() - started
    check(ms < 5000, true, `400KB of unterminated strings in ${ms}ms`)
  })

  section('every token class the code emits is styled in every page', () => {
    // A missing CSS rule is a SILENT failure: the span is emitted, the class is
    // set, and the token simply inherits the surrounding colour — no error, no
    // log, and a reviewer skimming the diff sees the rule was "added".
    // So the set of kinds is derived from real output, not from a hardcoded
    // list: add a sixth kind to highlight.ts and this fails until both pages
    // grow a colour for it.
    const PAGES = [path.join('assets', 'panel.html'), path.join('assets', 'sidebar.html')]
    const samples = [
      ['const x = 1; // note\nlet s = "hi";', 'ts'],
      ['<div class="x">text</div>', 'html'],
      ['def f():\n  return """d"""\n# n', 'py'],
      ['.a { color: #fff; }', 'css'],
      ['{"k": "v", "n": 2}', 'json'],
      ['# T\n\n`code`', 'md'],
      ['SELECT 1 FROM t -- n', 'sql'],
    ]

    const kinds = new Set()
    for (const [src, lang] of samples) {
      for (const m of highlightCode(src, lang).matchAll(/class="tok-([a-z])"/g)) kinds.add(m[1])
    }
    check(
      kinds.size >= 5,
      true,
      `the samples exercise all five kinds (got ${[...kinds].sort().join(',')})`
    )

    for (const page of PAGES) {
      const css = fs.readFileSync(path.join(ROOT, page), 'utf-8')
      for (const k of kinds) {
        check(new RegExp(`\\.tok-${k}\\s*\\{`).test(css), true, `${page} colours .tok-${k}`)
      }
    }
  })

  console.log(`\nhighlight: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
