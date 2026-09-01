/**
 * dsh-stream tests.
 *
 * This module owns the wire contract, which is the part most likely to break on
 * an upstream bump and the part with no compile-time safety whatsoever: a wrong
 * envelope shape produces a polite `{accepted:false}` from the host and an
 * approval that hangs forever. `fetch` is stubbed so the class-level behaviour
 * (framing, reconnect, respond) is exercised without a live backend.
 */

const assert = require('node:assert')
const path = require('node:path')

const {
  splitUrl,
  muxUrl,
  respondBody,
  unaryBody,
  backoffDelay,
  DshStream,
} = require(path.join(__dirname, '..', 'lib-new', 'dsh-stream.js'))

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

async function checkAsync(name, fn) {
  try {
    await fn()
    pass += 1
  } catch (error) {
    fail += 1
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── URL handling ──

console.log('dsh-stream: URLs')

check('splits a bare rc.2 URL (no token)', () => {
  const s = splitUrl('http://127.0.0.1:3080/')
  assert.strictEqual(s.origin, 'http://127.0.0.1:3080')
  assert.strictEqual(s.token, '', 'rc.2 mints no token')
})

check('extracts the token from a newer URL', () => {
  const s = splitUrl('http://127.0.0.1:3080/?token=abc123XYZ')
  assert.strictEqual(s.origin, 'http://127.0.0.1:3080')
  assert.strictEqual(s.token, 'abc123XYZ')
})

check('tolerates a bare host:port', () => {
  const s = splitUrl('127.0.0.1:3080')
  assert.strictEqual(s.origin, 'http://127.0.0.1:3080')
})

check('tolerates surrounding whitespace and several trailing slashes', () => {
  const s = splitUrl('  http://127.0.0.1:3080///  ')
  assert.strictEqual(s.origin, 'http://127.0.0.1:3080')
})

check('an empty input yields an empty origin', () => {
  assert.strictEqual(splitUrl('').origin, '')
  assert.strictEqual(splitUrl('   ').origin, '')
})

check('mux URL omits the token when there is none', () => {
  assert.strictEqual(muxUrl('http://127.0.0.1:3080', ''), 'http://127.0.0.1:3080/api/events.mux')
})

check('mux URL carries the token when there is one', () => {
  assert.strictEqual(
    muxUrl('http://127.0.0.1:3080', 'a/b c'),
    'http://127.0.0.1:3080/api/events.mux?token=a%2Fb%20c',
    'the token must be encoded — it can contain characters unsafe in a query',
  )
})

check('mux URL tolerates an origin with a trailing slash', () => {
  assert.strictEqual(muxUrl('http://127.0.0.1:3080/', ''), 'http://127.0.0.1:3080/api/events.mux')
})

// ── envelopes ──

console.log('dsh-stream: envelopes')

check('an approval answer is a client-response echoing the rpcId', () => {
  const body = respondBody({ rpcId: 'rpc-42', sessionId: 's1', approvalId: 'ap-1', outcome: 'allowed-once' })
  assert.strictEqual(body.type, 'client-response')
  assert.strictEqual(body.rpcId, 'rpc-42', 'respond mints no id of its own')
  assert.strictEqual(body.result.ok, true)
  assert.deepStrictEqual(body.result.value, {
    sessionId: 's1', approvalId: 'ap-1', outcome: 'allowed-once',
  })
})

check('only the two client-givable outcomes are built', () => {
  const a = respondBody({ rpcId: 'r', sessionId: 's', approvalId: 'a', outcome: 'rejected' })
  assert.strictEqual(a.result.value.outcome, 'rejected')
})

check('a unary body carries the method that must match the URL', () => {
  const body = unaryBody('session.list')
  assert.strictEqual(body.type, 'client-request')
  assert.strictEqual(body.method, 'session.list')
  assert.ok(body.rpcId.length > 0)
})

check('each unary call mints a fresh rpcId', () => {
  const a = unaryBody('session.list')
  const b = unaryBody('session.list')
  assert.notStrictEqual(a.rpcId, b.rpcId, 'a reused id would mis-correlate responses')
  assert.match(a.rpcId, /^[0-9a-f-]{36}$/, 'uuid v4, same as upstream mints')
})

// ── backoff ──

console.log('dsh-stream: backoff')

check('backoff doubles and is capped', () => {
  assert.strictEqual(backoffDelay(0), 1000)
  assert.strictEqual(backoffDelay(1), 2000)
  assert.strictEqual(backoffDelay(2), 4000)
  assert.strictEqual(backoffDelay(3), 8000)
  assert.strictEqual(backoffDelay(20), 30000, 'capped — an hour-long wait is useless')
})

check('backoff survives a negative attempt', () => {
  assert.strictEqual(backoffDelay(-5), 1000)
})

// ── class behaviour with a stubbed transport ──

console.log('dsh-stream: stream behaviour')

/** Minimal Response stand-in: only .ok / .status / .body.getReader() are used. */
function sseResponse(chunks, status = 200) {
  let i = 0
  return {
    ok: status < 400,
    status,
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[i++]) }
          return { done: true, value: undefined }
        },
      }),
    },
  }
}

function frame(payload, rpcId = 'r') {
  return `data: ${JSON.stringify({ type: 'server-request', rpcId, method: payload.type, payload })}\n\n`
}

function writeCall(callId, filePath) {
  return frame({
    type: 'session/event',
    sessionId: 'sess-1',
    event: { type: 'tool/call', seq: 1, time: Date.now(), data: { callId, name: 'write' } },
    view: { for: 'call', view: { card: 'diff', title: `Write ${filePath}`, diffs: [{ path: filePath, oldText: null, newText: 'x\n' }] } },
  })
}

function withFetch(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = original
  })
}

async function main() {
  await checkAsync('connects and turns a wire frame into a change', async () => {
    const stream = new DshStream()
    await withFetch(async () => sseResponse([': connected\n\n', writeCall('c1', '/w/a.ts')]), async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(60)
    })
    const changes = stream.changes()
    assert.strictEqual(changes.length, 1)
    assert.strictEqual(changes[0].diffs[0].path, '/w/a.ts')
    stream.stop()
  })

  await checkAsync('a frame split across chunks still lands', async () => {
    const stream = new DshStream()
    const wire = writeCall('c1', '/w/a.ts')
    await withFetch(async () => sseResponse([wire.slice(0, 20), wire.slice(20, 50), wire.slice(50)]), async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(60)
    })
    assert.strictEqual(stream.changes().length, 1, 'TCP does not respect frame boundaries')
    stream.stop()
  })

  await checkAsync('an approval can be answered', async () => {
    const stream = new DshStream()
    const posted = []
    const wire =
      writeCall('c1', '/w/a.ts') +
      frame({ type: 'approval/requested', sessionId: 'sess-1', approvalId: 'ap-1', toolName: 'write', callId: 'c1' }, 'rpc-7')

    await withFetch(async (url, init) => {
      if (String(url).includes('/api/events.mux')) return sseResponse([wire])
      posted.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ result: { ok: true, value: { accepted: true } } }) }
    }, async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(60)
      const result = await stream.respond('ap-1', 'allowed-once')
      assert.strictEqual(result.ok, true, JSON.stringify(result))
    })

    const respond = posted.find((p) => p.url.includes('/api/respond'))
    assert.ok(respond, 'an approval must reach /api/respond')
    assert.strictEqual(respond.body.rpcId, 'rpc-7', 'the echoed id is the whole mechanism')
    assert.strictEqual(respond.body.result.value.outcome, 'allowed-once')
    stream.stop()
  })

  await checkAsync('answering a stale approval reports why instead of throwing', async () => {
    const stream = new DshStream()
    const result = await stream.respond('never-seen', 'rejected')
    assert.strictEqual(result.ok, false)
    assert.match(result.error, /失效/)
  })

  await checkAsync('a refused receipt surfaces the host reason', async () => {
    const stream = new DshStream()
    await withFetch(async () => sseResponse([
      frame({ type: 'approval/requested', sessionId: 's', approvalId: 'ap-1', toolName: 'write' }, 'r1'),
    ]), async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(60)
    })
    await withFetch(async () => ({ ok: true, json: async () => ({ result: { ok: true, value: { accepted: false, reason: 'not-pending' } } }) }), async () => {
      const result = await stream.respond('ap-1', 'rejected')
      assert.strictEqual(result.ok, false)
      assert.match(result.error, /not-pending/, 'the host reason is the only clue available')
    })
    stream.stop()
  })

  await checkAsync('session.list is polled and merged', async () => {
    const stream = new DshStream()
    await withFetch(async (url) => {
      if (String(url).includes('/api/events.mux')) return sseResponse([])
      return {
        ok: true,
        json: async () => ({
          result: { ok: true, value: { items: [{ sessionId: 'sess-1', cwd: '/work', running: true, updatedAt: 5 }] } },
        }),
      }
    }, async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(80)
    })
    const sessions = stream.sessions()
    assert.strictEqual(sessions.length, 1)
    assert.strictEqual(sessions[0].cwd, '/work')
    assert.strictEqual(sessions[0].running, true)
    stream.stop()
  })

  await checkAsync('stop() aborts the connection and prevents reconnect', async () => {
    const stream = new DshStream()
    let fetches = 0
    await withFetch(async () => {
      fetches += 1
      return sseResponse([])
    }, async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(30)
      stream.stop()
      const before = fetches
      await wait(1300)
      assert.strictEqual(fetches, before, 'a stopped stream must stay stopped')
    })
  })

  await checkAsync('a dropped stream reconnects on its own', async () => {
    const stream = new DshStream()
    let fetches = 0
    await withFetch(async () => {
      fetches += 1
      return sseResponse([]) // opens, then immediately ends → reconnect
    }, async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(1400)
      assert.ok(fetches >= 2, `expected a reconnect within the 1s backoff, got ${fetches} fetch(es)`)
    })
    stream.stop()
  })

  await checkAsync('a new URL resets the store instead of showing stale state', async () => {
    const stream = new DshStream()
    const urls = []
    await withFetch(async (url) => {
      urls.push(String(url))
      return sseResponse([writeCall('c1', '/w/a.ts')])
    }, async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(60)
    })
    assert.strictEqual(stream.changes().length, 1)

    // A backend restart mints a new token → different URL → everything we knew is gone.
    await withFetch(async (url) => {
      urls.push(String(url))
      return sseResponse([])
    }, async () => {
      stream.start('http://127.0.0.1:3080/?token=deadbeef')
      await wait(60)
    })
    assert.strictEqual(stream.changes().length, 0, 'stale changes would look live')

    const muxCalls = urls.filter((u) => u.includes('/api/events.mux'))
    assert.strictEqual(muxCalls.length, 2, 'the stream must RECONNECT on a new url, not just drop')
    assert.ok(muxCalls[1].includes('token=deadbeef'), 'and it must talk to the new token')
    stream.stop()
  })

  await checkAsync('a restart with a new url keeps the stream alive', async () => {
    // The regression this locks down: teardown() used to leave `running`
    // true, so start() with a changed url took its early-return branch and
    // never reopened — the change list stayed empty forever after a restart.
    const stream = new DshStream()
    let muxOpens = 0
    await withFetch(async (url) => {
      if (String(url).includes('/api/events.mux')) muxOpens += 1
      return sseResponse([])
    }, async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(40)
      stream.start('http://127.0.0.1:3080/?token=newtoken')
      await wait(40)
    })
    assert.strictEqual(muxOpens, 2, `expected a fresh connection after the url change, got ${muxOpens}`)
    stream.stop()
  })

  await checkAsync('a 500 on the mux endpoint does not throw', async () => {
    const stream = new DshStream({ log: () => {} })
    await withFetch(async () => sseResponse([], 500), async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(50)
    })
    assert.strictEqual(stream.connected, false)
    assert.strictEqual(stream.changes().length, 0)
    stream.stop()
  })

  await checkAsync('malformed frames are counted, not fatal', async () => {
    const stream = new DshStream()
    await withFetch(async () => sseResponse(['data: {oops}\n\n', writeCall('c1', '/w/a.ts')]), async () => {
      stream.start('http://127.0.0.1:3080')
      await wait(60)
    })
    assert.strictEqual(stream.malformedCount, 1)
    assert.strictEqual(stream.changes().length, 1, 'one bad frame must not lose the good one')
    stream.stop()
  })

  await checkAsync('the token never appears in a log line', async () => {
    const lines = []
    const stream = new DshStream({ log: (m) => lines.push(m) })
    await withFetch(async () => sseResponse([], 500), async () => {
      stream.start('http://127.0.0.1:3080/?token=SECRETSECRET')
      await wait(50)
    })
    const all = lines.join('\n')
    assert.ok(!all.includes('SECRETSECRET'), `token leaked into logs: ${all}`)
    stream.stop()
  })

  await checkAsync('start() with an empty URL is a no-op', async () => {
    const stream = new DshStream()
    let fetches = 0
    await withFetch(async () => { fetches += 1; return sseResponse([]) }, async () => {
      stream.start('')
      await wait(30)
    })
    assert.strictEqual(fetches, 0)
    stream.stop()
  })

  console.log(`\ndsh-stream: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
