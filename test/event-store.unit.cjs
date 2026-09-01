/**
 * event-store unit tests.
 *
 * The mux stream is the one part of the panel that CANNOT be exercised in this
 * sandbox (it needs a live dsh backend), so the framing and correlation rules
 * are locked down here instead. Every case below is a failure mode that would
 * otherwise present as "the change list is empty" with no error anywhere.
 */

const assert = require('node:assert')
const path = require('node:path')

const {
  parseSseChunk,
  asKnownFrame,
  EventStore,
} = require(path.join(__dirname, '..', 'lib-new', 'event-store.js'))

let pass = 0
let fail = 0

function check(name, fn) {
  try {
    fn()
    pass += 1
  } catch (error) {
    fail += 1
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}

/** Wrap a frame the way the host does: full ServerRequest form. */
function sse(method, payload, rpcId = 'rpc-1') {
  return `data: ${JSON.stringify({ type: 'server-request', rpcId, method, payload })}\n\n`
}

function toolCallEvent(callId, name) {
  return {
    type: 'tool/call',
    seq: 1,
    time: 1000,
    data: { turn: 1, step: 1, callId, name, arguments: '{}' },
  }
}

function diffView(title, diffs) {
  return { for: 'call', view: { card: 'diff', title, diffs } }
}

// ── SSE framing ──

console.log('event-store: SSE framing')

check('skips the ": connected" comment line', () => {
  const r = parseSseChunk(': connected\n\n')
  assert.strictEqual(r.frames.length, 0, 'a comment line is not a frame')
  assert.strictEqual(r.malformed, 0, 'a comment is not a malformed frame')
})

check('parses one complete frame', () => {
  const r = parseSseChunk(sse('session/subscribed', { type: 'session/subscribed', sessionId: 's1', lastSeq: -1 }))
  assert.strictEqual(r.frames.length, 1)
  assert.strictEqual(r.frames[0].frame.type, 'session/subscribed')
  assert.strictEqual(r.frames[0].rpcId, 'rpc-1', 'the envelope rpcId must survive parsing')
  assert.strictEqual(r.rest, '')
})

check('parses several frames in one chunk', () => {
  const chunk =
    sse('session/subscribed', { type: 'session/subscribed', sessionId: 'a', lastSeq: 0 }, 'r1') +
    sse('session/subscribed', { type: 'session/subscribed', sessionId: 'b', lastSeq: 0 }, 'r2') +
    sse('session/subscribed', { type: 'session/subscribed', sessionId: 'c', lastSeq: 0 }, 'r3')
  const r = parseSseChunk(chunk)
  assert.strictEqual(r.frames.length, 3, 'a TCP segment can carry many frames')
})

check('reassembles a frame split across two chunks', () => {
  const full = sse('session/subscribed', { type: 'session/subscribed', sessionId: 's', lastSeq: 0 })
  const cut = Math.floor(full.length / 2)
  const first = parseSseChunk(full.slice(0, cut))
  assert.strictEqual(first.frames.length, 0, 'half a frame yields nothing yet')
  assert.strictEqual(first.rest, full.slice(0, cut), 'the tail must be carried over')

  const second = parseSseChunk(first.rest + full.slice(cut))
  assert.strictEqual(second.frames.length, 1, 'the completed frame parses')
  assert.strictEqual(second.rest, '')
})

check('reassembles across a three-way split', () => {
  const full = sse('approval/requested', { type: 'approval/requested', sessionId: 's', approvalId: 'a1', toolName: 'write' })
  const a = parseSseChunk(full.slice(0, 10))
  const b = parseSseChunk(a.rest + full.slice(10, 40))
  const c = parseSseChunk(b.rest + full.slice(40))
  assert.strictEqual(c.frames.length, 1)
  assert.strictEqual(c.frames[0].frame.approvalId, 'a1')
})

check('counts malformed JSON instead of throwing', () => {
  const r = parseSseChunk('data: {not json}\n\n' + sse('session/subscribed', { type: 'session/subscribed', sessionId: 's', lastSeq: 0 }))
  assert.strictEqual(r.frames.length, 1, 'one bad frame must not kill the stream')
  assert.strictEqual(r.malformed, 1)
})

check('ignores lines that are not "data: "', () => {
  const r = parseSseChunk('event: ping\nid: 7\n\n')
  assert.strictEqual(r.frames.length, 0)
  assert.strictEqual(r.malformed, 0)
})

check('joins multi-line data payloads', () => {
  // The wire carries the full ServerRequest envelope, not the bare frame.
  const full = sse('session/subscribed', { type: 'session/subscribed', sessionId: 's', lastSeq: 0 })
  const json = full.slice('data: '.length, -2) // strip the prefix and the trailing blank line
  const half = Math.floor(json.length / 2)
  const chunk = `data: ${json.slice(0, half)}\ndata: ${json.slice(half)}\n\n`
  const r = parseSseChunk(chunk)
  assert.strictEqual(r.frames.length, 1, 'SSE allows one payload across several data lines')
  assert.strictEqual(r.frames[0].frame.sessionId, 's')
})

check('leaves a trailing partial frame in rest', () => {
  const r = parseSseChunk(sse('session/subscribed', { type: 'session/subscribed', sessionId: 's', lastSeq: 0 }) + 'data: {"type":')
  assert.strictEqual(r.frames.length, 1)
  assert.strictEqual(r.rest, 'data: {"type":')
})

// ── frame narrowing ──

console.log('event-store: frame narrowing')

check('accepts a server-request envelope', () => {
  const f = asKnownFrame({ type: 'server-request', rpcId: 'r', method: 'x', payload: { type: 'session/subscribed' } })
  assert.ok(f !== null)
  assert.strictEqual(f.type, 'session/subscribed')
})

check('rejects a non-server-request envelope', () => {
  assert.strictEqual(asKnownFrame({ type: 'client-request', rpcId: 'r', method: 'x', payload: {} }), null)
  assert.strictEqual(asKnownFrame({ type: 'server-response', rpcId: 'r', result: {} }), null)
})

check('rejects garbage', () => {
  assert.strictEqual(asKnownFrame(null), null)
  assert.strictEqual(asKnownFrame('x'), null)
  assert.strictEqual(asKnownFrame({ type: 'server-request' }), null, 'a missing payload')
  assert.strictEqual(asKnownFrame({ type: 'server-request', payload: { noType: 1 } }), null)
})

// ── change tracking ──

console.log('event-store: change tracking')

function storeWithWrite() {
  const s = new EventStore()
  s.feed({
    type: 'session/event',
    sessionId: 'sess-1',
    event: toolCallEvent('call-1', 'write'),
    view: diffView('Write foo.ts', [{ path: '/w/foo.ts', oldText: null, newText: 'hello\n' }]),
  })
  return s
}

check('a tool/call with a diff view becomes a pending change', () => {
  const s = storeWithWrite()
  const snap = s.snapshot()
  assert.strictEqual(snap.changes.length, 1)
  const c = snap.changes[0]
  assert.strictEqual(c.callId, 'call-1')
  assert.strictEqual(c.status, 'pending', 'a call is only an intent until it lands')
  assert.strictEqual(c.title, 'Write foo.ts')
  assert.strictEqual(c.diffs[0].path, '/w/foo.ts')
  assert.strictEqual(c.diffs[0].oldText, null, 'a create has no before-image')
})

check('a tool/call without a diff view is ignored', () => {
  const s = new EventStore()
  const changed = s.feed({ type: 'session/event', sessionId: 's', event: toolCallEvent('c1', 'read') })
  assert.strictEqual(changed, false)
  assert.strictEqual(s.snapshot().changes.length, 0, 'a read touches nothing')
})

check('a terminal call view is ignored', () => {
  const s = new EventStore()
  const frame = {
    type: 'session/event',
    sessionId: 's',
    event: toolCallEvent('c1', 'bash'),
    view: { for: 'call', view: { card: 'terminal', title: 'ls' } },
  }
  assert.strictEqual(s.feed(frame), false)
  assert.strictEqual(s.snapshot().changes.length, 0)
})

check('tool/result confirms the change landed', () => {
  const s = storeWithWrite()
  s.feed({
    type: 'session/event',
    sessionId: 'sess-1',
    event: { type: 'tool/result', seq: 2, time: 2000, data: { turn: 1, step: 1, callId: 'call-1', name: 'write' } },
    view: { for: 'result', view: { card: 'diff', diffs: [{ path: '/w/foo.ts', oldText: '', newText: 'hello\n' }] } },
  })
  const c = s.snapshot().changes[0]
  assert.strictEqual(c.status, 'applied', 'only the result proves it was written')
})

check('a result for an unknown call is dropped', () => {
  const s = new EventStore()
  const changed = s.feed({
    type: 'session/event',
    sessionId: 's',
    event: { type: 'tool/result', seq: 1, time: 1, data: { callId: 'never-seen' } },
  })
  assert.strictEqual(changed, false)
  assert.strictEqual(s.snapshot().changes.length, 0)
})

check('a call with no callId is ignored', () => {
  const s = new EventStore()
  const changed = s.feed({
    type: 'session/event',
    sessionId: 's',
    event: { type: 'tool/call', time: 1, data: { name: 'write' } },
    view: diffView('Write x', [{ path: '/x', oldText: null, newText: '' }]),
  })
  assert.strictEqual(changed, false, 'callId is the only correlation key')
})

check('falls back to the tool name when the view has no title', () => {
  const s = new EventStore()
  s.feed({
    type: 'session/event',
    sessionId: 's',
    event: toolCallEvent('c1', 'edit'),
    view: { for: 'call', view: { card: 'diff', diffs: [{ path: '/a', oldText: 'a', newText: 'b' }] } },
  })
  assert.strictEqual(s.snapshot().changes[0].title, 'edit')
})

check('a diffs array with no usable entry is ignored', () => {
  const s = new EventStore()
  const changed = s.feed({
    type: 'session/event',
    sessionId: 's',
    event: toolCallEvent('c1', 'write'),
    view: { for: 'call', view: { card: 'diff', title: 'W', diffs: [{ noPath: 1 }] } },
  })
  assert.strictEqual(changed, false)
})

// ── approvals ──

console.log('event-store: approvals')

check('an approval keeps the rpcId needed to answer it', () => {
  const s = new EventStore()
  s.feed({ type: 'approval/requested', sessionId: 's', approvalId: 'ap-1', toolName: 'write', callId: 'call-1' }, 'rpc-99')
  const a = s.snapshot().approvals[0]
  assert.strictEqual(a.rpcId, 'rpc-99', 'respond is a client-response and must echo this id')
  assert.strictEqual(a.toolName, 'write')
})

check('an approval with no rpcId is still recorded but unanswerable', () => {
  const s = new EventStore()
  s.feed({ type: 'approval/requested', sessionId: 's', approvalId: 'ap-1', toolName: 'write' })
  assert.strictEqual(s.snapshot().approvals.length, 1)
  assert.strictEqual(s.snapshot().approvals[0].rpcId, '')
})

check('an approval joins back to its call', () => {
  const s = storeWithWrite()
  s.feed({ type: 'approval/requested', sessionId: 'sess-1', approvalId: 'ap-1', toolName: 'write', callId: 'call-1' }, 'r1')
  const a = s.approvalForCall('call-1')
  assert.ok(a, 'the join is what lets the card show WHAT is being approved')
  assert.strictEqual(a.approvalId, 'ap-1')
})

check('a rejected approval marks its call rejected', () => {
  const s = storeWithWrite()
  s.feed({ type: 'approval/requested', sessionId: 'sess-1', approvalId: 'ap-1', toolName: 'write', callId: 'call-1' }, 'r1')
  s.feed({ type: 'approval/resolved', sessionId: 'sess-1', approvalId: 'ap-1', outcome: 'rejected' })
  assert.strictEqual(s.snapshot().changes[0].status, 'rejected')
  assert.strictEqual(s.snapshot().approvals.length, 0, 'a resolved approval leaves the inbox')
})

check('allowed-once leaves the call pending until the result arrives', () => {
  const s = storeWithWrite()
  s.feed({ type: 'approval/requested', sessionId: 'sess-1', approvalId: 'ap-1', toolName: 'write', callId: 'call-1' }, 'r1')
  s.feed({ type: 'approval/resolved', sessionId: 'sess-1', approvalId: 'ap-1', outcome: 'allowed-once' })
  assert.strictEqual(s.snapshot().changes[0].status, 'pending', 'permission is not proof it ran')
})

check('an unmatched rejection does not throw', () => {
  const s = new EventStore()
  s.feed({ type: 'approval/resolved', sessionId: 's', approvalId: 'nope', outcome: 'rejected' })
  assert.strictEqual(s.snapshot().changes.length, 0)
})

// ── sessions, ordering, bounds ──

console.log('event-store: sessions and bounds')

check('sessions are created and newest-first', () => {
  const s = new EventStore()
  s.feed({ type: 'session/subscribed', sessionId: 'a', lastSeq: -1 })
  s.noteSessionInfo({ sessionId: 'a', cwd: '/work', running: true, updatedAt: 10 })
  s.noteSessionInfo({ sessionId: 'b', cwd: '/other', running: false, updatedAt: 20 })
  const sessions = s.snapshot().sessions
  assert.strictEqual(sessions.length, 2)
  assert.strictEqual(sessions[0].sessionId, 'b', 'freshest first')
  assert.strictEqual(sessions[0].cwd, '/other')
})

check('noteSessionRunning creates a session on demand', () => {
  const s = new EventStore()
  s.noteSessionRunning('new', true)
  assert.strictEqual(s.snapshot().sessions[0].running, true)
})

check('unknown frame types are counted, not fatal', () => {
  const s = new EventStore()
  s.feed({ type: 'session/projection', sessionId: 's', key: 'k', value: 1, seq: 1 })
  s.feed({ type: 'session/queue', sessionId: 's', items: [] })
  assert.strictEqual(s.snapshot().dropped, 2, 'upstream adds frames freely; ignoring them is correct')
})

check('a stream/error frame is not counted as dropped', () => {
  const s = new EventStore()
  s.feed({ type: 'stream/error', error: { code: 'internal', message: 'boom' } })
  assert.strictEqual(s.snapshot().dropped, 0)
})

check('changes cap at the limit, oldest evicted first', () => {
  const s = new EventStore()
  for (let i = 0; i < 260; i += 1) {
    s.feed({
      type: 'session/event',
      sessionId: 's',
      event: toolCallEvent(`c${i}`, 'write'),
      view: diffView('W', [{ path: `/f${i}`, oldText: null, newText: 'x' }]),
    })
  }
  const snap = s.snapshot()
  assert.strictEqual(snap.changes.length, 200, 'the list must not grow without bound')
  assert.strictEqual(snap.changes[0].callId, 'c259', 'newest first')
  assert.strictEqual(snap.changes[199].callId, 'c60', 'oldest entries dropped')
})

check('stale pending calls age out of the snapshot', () => {
  const s = new EventStore()
  s.feed({
    type: 'session/event',
    sessionId: 's',
    event: { type: 'tool/call', time: 1000, data: { callId: 'old', name: 'write' } },
    view: diffView('W', [{ path: '/a', oldText: null, newText: 'x' }]),
  })
  assert.strictEqual(s.snapshot().changes.length, 1, 'fresh enough to show')

  const later = Date.now() + 31 * 60 * 1000
  assert.strictEqual(
    s.snapshot(later).changes.length, 0,
    'a stalled agent must not pin memory — eviction runs on when WE last heard, not the event time',
  )
})

check('eviction uses when we saw the call, not the event timestamp', () => {
  const s = new EventStore()
  // An event timestamp from 1970 is realistic for a replay; it must not be
  // treated as 56 years stale the moment it arrives.
  s.feed({
    type: 'session/event',
    sessionId: 's',
    event: { type: 'tool/call', time: 1000, data: { callId: 'replayed', name: 'write' } },
    view: diffView('W', [{ path: '/a', oldText: null, newText: 'x' }]),
  })
  assert.strictEqual(s.snapshot().changes.length, 1)
})

check('re-feeding a stalled call does not renew its TTL', () => {
  const s = new EventStore()
  const frame = {
    type: 'session/event',
    sessionId: 's',
    event: { type: 'tool/call', time: 1000, data: { callId: 'dup', name: 'write' } },
    view: diffView('W', [{ path: '/a', oldText: null, newText: 'x' }]),
  }
  s.feed(frame)
  const later = Date.now() + 20 * 60 * 1000
  s.feed(frame) // a duplicate delivery must not extend the lease
  assert.strictEqual(s.snapshot(later + 20 * 60 * 1000).changes.length, 0)
})

check('reset clears everything', () => {
  const s = storeWithWrite()
  s.feed({ type: 'approval/requested', sessionId: 'sess-1', approvalId: 'ap-1', toolName: 'write', callId: 'call-1' }, 'r1')
  s.reset()
  const snap = s.snapshot()
  assert.strictEqual(snap.changes.length, 0)
  assert.strictEqual(snap.approvals.length, 0)
  assert.strictEqual(snap.sessions.length, 0)
  assert.strictEqual(s.approvalForCall('call-1'), undefined, 'reset must break the join map too')
})

check('feeding 1000 frames never throws and stays bounded', () => {
  const s = new EventStore()
  for (let i = 0; i < 1000; i += 1) {
    s.feed({ type: 'session/event', sessionId: 's', event: toolCallEvent(`c${i}`, 'write'), view: diffView('W', [{ path: '/f', oldText: null, newText: 'x' }]) }, `r${i}`)
  }
  assert.strictEqual(s.snapshot().changes.length, 200)
})

// ── end-to-end through the wire format ──

console.log('event-store: end-to-end')

check('a realistic approval flow survives the whole pipeline', () => {
  const s = new EventStore()
  const wire =
    ': connected\n\n' +
    sse('session/subscribed', { type: 'session/subscribed', sessionId: 'sess-1', lastSeq: -1 }, 'r0') +
    sse('tool/call', {
      type: 'session/event',
      sessionId: 'sess-1',
      event: { type: 'tool/call', seq: 1, time: 1000, data: { turn: 1, step: 1, callId: 'call-7', name: 'write', arguments: '{}' } },
      view: diffView('Write src/a.ts', [{ path: '/w/src/a.ts', oldText: null, newText: 'export const a = 1\n' }]),
    }, 'r1') +
    sse('approval/requested', {
      type: 'approval/requested', sessionId: 'sess-1', approvalId: 'ap-7', toolName: 'write', callId: 'call-7', reason: 'needs write access',
    }, 'r2')

  // Feed byte-by-byte in 7-char slices: the harshest realistic split.
  let rest = ''
  let total = 0
  for (let i = 0; i < wire.length; i += 7) {
    const r = parseSseChunk(rest + wire.slice(i, i + 7))
    rest = r.rest
    assert.strictEqual(r.malformed, 0)
    for (const f of r.frames) { s.feed(f.frame, f.rpcId); total += 1 }
  }
  assert.strictEqual(total, 3, 'every frame survived arbitrary splitting')

  const snap = s.snapshot()
  assert.strictEqual(snap.changes.length, 1)
  assert.strictEqual(snap.approvals.length, 1)
  assert.ok(s.approvalForCall('call-7'), 'the approval still finds its call')
  assert.strictEqual(snap.changes[0].diffs[0].path, '/w/src/a.ts')
  // The whole point of carrying rpcId: without it this approval is unanswerable.
  assert.strictEqual(snap.approvals[0].rpcId, 'r2')
  assert.strictEqual(
    s.getApproval('ap-7').rpcId, 'r2',
    'respond is a client-response and must echo the frame\'s envelope id',
  )
})

console.log(`\nevent-store: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
