/**
 * Unit tests for token redaction (src/redact.ts → lib-new/redact.js).
 *
 * Security-critical: `dsh web` mints a fresh per-process token on every
 * launch, and that token is a live credential for the local web UI. Any token
 * that reaches backend.log or the monitor panel is a leak, so these cases pin
 * the shapes that actually occur in harness output.
 *
 * Run with: npm test
 */
const path = require('node:path')
const {
  redactTokenInText,
  redactTokenInUrl,
} = require(path.join(__dirname, '..', 'lib-new', 'redact.js'))

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (ok) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`)
  }
}
function noToken(label, text) {
  // Nothing that looks like a token value may survive.
  const leaked = /token=[A-Za-z0-9_-]{8,}/u.test(text)
  if (!leaked) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label} — token leaked: ${JSON.stringify(text)}`)
  }
}

const TOKEN = 'kQ9f3ZpLm2Xr7TbN5wYc1Hd4Js8Vg0Ae6UiOqRzFnSh'

console.log('redact: URL query form')
{
  const url = `http://127.0.0.1:3080/?token=${TOKEN}`
  check('query token masked', redactTokenInText(url), 'http://127.0.0.1:3080/?token=***')
  check('redactTokenInUrl matches', redactTokenInUrl(url), 'http://127.0.0.1:3080/?token=***')
  noToken('no raw token survives in text', redactTokenInText(url))
}

console.log('redact: the actual harness startup line')
{
  const line = `dsh web: http://127.0.0.1:3080/?token=${TOKEN}`
  const out = redactTokenInText(line)
  check('startup line masked', out, 'dsh web: http://127.0.0.1:3080/?token=***')
  noToken('startup line has no token', out)
}

console.log('redact: JSON payloads')
{
  check(
    'compact JSON',
    redactTokenInText(`{"token":"${TOKEN}"}`),
    '{"token":"***"}'
  )
  check(
    'spaced JSON',
    redactTokenInText(`{ "token" : "${TOKEN}" }`),
    '{ "token" : "***" }'
  )
  noToken('json masked', redactTokenInText(`{"token":"${TOKEN}"}`))
}

console.log('redact: multiple tokens in one chunk')
{
  const two = `a token=${TOKEN} and token=${TOKEN} again`
  const out = redactTokenInText(two)
  check('both masked', out, 'a token=*** and token=*** again')
  noToken('no survivor', out)
}

console.log('redact: boundaries and false positives')
{
  // Token-ish chars must stop at whitespace / quotes / end of chunk.
  check('stops at whitespace', redactTokenInText('token=abc def'), 'token=*** def')
  check('stops at newline', redactTokenInText('token=abc\ndef'), 'token=***\ndef')
  check('empty value untouched', redactTokenInText('token= x'), 'token= x')
  // Plain text must pass through byte-for-byte — over-redacting would mangle
  // the log and hide real errors.
  const plain = 'dsh web: server listening\n中文日志不变 [ERR] something failed'
  check('plain text untouched', redactTokenInText(plain), plain)
  // "tokenizer=" must NOT match — the regex requires the literal "token=".
  check('tokenizer= not over-matched', redactTokenInText('tokenizer=abc'), 'tokenizer=abc')
}

console.log('redact: idempotent')
{
  const once = redactTokenInText(`/?token=${TOKEN}`)
  check('second pass changes nothing', redactTokenInText(once), once)
}

console.log(`\nredact: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
