/**
 * Unit tests for src/git-service.ts (→ lib-new/git-service.js).
 *
 * The class takes `spawn` by injection and imports no Electron, so a fake
 * spawn drives the real implementation here — the same trick dsh-stream.unit
 * uses with `globalThis.fetch`. That matters because every failure mode below
 * is invisible in normal use and only shows up on a machine that is not mine:
 *
 *   - git not installed at all (ENOENT)
 *   - git hanging on a credential prompt
 *   - the auto-update workspace, where writing would be silently reverted
 *   - a filename that begins with `-` becoming a git option
 *
 * Run with: npm test
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  GitService,
  MAX_DIFF_CHARS,
  WRITE_FILE_LIMIT,
  looksLikeRepo,
} = require(path.join(__dirname, '..', 'lib-new', 'git-service.js'))

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(
      `  FAIL  ${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`
    )
  }
}
function assert(cond, label, detail) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}\n        ${detail}`)
  }
}
/**
 * Run one async scenario. A throw must land as a FAIL, not as an unhandled
 * rejection that aborts the rest of the file (see the modules.smoke notes
 * about a suite that reports green while half of it never ran).
 */
async function section(name, fn) {
  try {
    await fn()
  } catch (err) {
    fail++
    console.log(`  FAIL  ${name} threw\n        ${err && err.stack ? err.stack : err}`)
  }
}

/** A real directory: snapshot() stat()s it before doing anything else. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-'))
const sub = path.join(tmp, 'src')
fs.mkdirSync(sub, { recursive: true })

/**
 * Fake spawn. `router(cmd, args)` returns:
 *   { code, stdout?, stderr? }  → normal exit
 *   { error }                   → 'error' event (ENOENT etc)
 *   'hang'                      → never settles, for the timeout path
 */
function fakeSpawn(router) {
  const calls = []
  const children = []
  function spawnFn(cmd, args, opts) {
    calls.push({ cmd, args: [...args], opts })
    const L = { out: [], err: [], error: [], close: [] }
    let killed = false
    const child = {
      stdout: { on: (ev, cb) => { if (ev === 'data') L.out.push(cb) } },
      stderr: { on: (ev, cb) => { if (ev === 'data') L.err.push(cb) } },
      on(ev, cb) { if (L[ev]) L[ev].push(cb); return child },
      kill() { killed = true },
      get killed() { return killed },
    }
    children.push(child)
    const result = router(cmd, args)
    if (result === 'hang') return child
    setTimeout(() => {
      if (result.error) {
        for (const cb of L.error) cb(result.error)
        return
      }
      if (result.stdout !== undefined) for (const cb of L.out) cb(result.stdout)
      if (result.stderr !== undefined) for (const cb of L.err) cb(result.stderr)
      for (const cb of L.close) cb(result.code === undefined ? 0 : result.code)
    }, 0)
    return child
  }
  return { spawnFn, calls, children }
}

const ENOENT = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })

/** Router for a healthy repo with the given status output. */
function repoRouter(statusOut, branch = 'main') {
  return (cmd, args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0\n' }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: tmp + '\n' }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: branch + '\n' }
    if (args[0] === 'status') return { code: 0, stdout: statusOut }
    if (args[0] === 'diff') return { code: 0, stdout: 'diff --git a/x b/x\n' }
    return { code: 0, stdout: '' }
  }
}

async function main() {
  // ── not a repository ──
  console.log('git-service: non-repo directories')
  await section('non-repo', async () => {
    const f = fakeSpawn((cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0\n' }
      return { code: 128, stderr: 'fatal: not a git repository\n' }
    })
    const snap = await new GitService({ spawn: f.spawnFn }).snapshot(tmp)
    check('isRepo is false', snap.isRepo, false)
    check('branch is empty', snap.branch, '')
    check('root is empty', snap.root, '')
    check('no entries', snap.entries.length, 0)
    // "Not a repo" is a normal state for a directory, not a failure — showing
    // it as an error would make the panel look broken for most users.
    check('no error text for a plain non-repo', snap.error, undefined)
  })

  // ── missing directory ──
  console.log('git-service: missing directory')
  await section('missing dir', async () => {
    const f = fakeSpawn(repoRouter(''))
    const snap = await new GitService({ spawn: f.spawnFn }).snapshot(path.join(tmp, 'nope'))
    check('isRepo is false', snap.isRepo, false)
    assert(
      typeof snap.error === 'string' && snap.error.includes('目录不存在'),
      'snapshot reports the missing directory',
      `expected a 目录不存在 error, got ${JSON.stringify(snap.error)}`
    )
    check('no git was spawned for a missing directory', f.calls.length, 0)
  })

  // ── happy path ──
  console.log('git-service: reading a repo')
  await section('happy path', async () => {
    const f = fakeSpawn(repoRouter(' M src/a.ts\0?? src/b.ts\0A  src/c.ts\0'))
    const svc = new GitService({ spawn: f.spawnFn })
    const snap = await svc.snapshot(tmp)
    check('isRepo', snap.isRepo, true)
    check('branch', snap.branch, 'main')
    check('root is the toplevel', snap.root, tmp)
    check('three entries parsed', snap.entries.length, 3)
    check('summary total', snap.summary.total, 3)
    check('summary unstaged', snap.summary.unstaged, 1)
    check('summary untracked', snap.summary.untracked, 1)
    check('summary staged', snap.summary.staged, 1)
    check('not write locked by default', snap.writeLocked, false)

    const kinds = f.calls.map((c) => c.args[0] + (c.args[1] ? ' ' + c.args[1] : ''))
    check('spawned version probe + toplevel + branch + status', kinds, [
      '--version',
      'rev-parse --show-toplevel',
      'rev-parse --abbrev-ref',
      'status --porcelain=v1',
    ])

    // The probe is cached: without that, every refresh would spawn a useless
    // fifth process.
    await svc.snapshot(tmp)
    check('the git probe is cached', f.calls.filter((c) => c.args[0] === '--version').length, 1)
  })

  // ── detached HEAD ──
  console.log('git-service: detached HEAD')
  await section('detached', async () => {
    const f = fakeSpawn(repoRouter(' M a.ts\0', 'HEAD'))
    const snap = await new GitService({ spawn: f.spawnFn }).snapshot(tmp)
    check('still a repo', snap.isRepo, true)
    check('branch is blank, not the literal HEAD', snap.branch, '')
    check('status still comes through', snap.entries.length, 1)
  })

  // ── git not installed ──
  console.log('git-service: git missing')
  await section('git missing', async () => {
    const f = fakeSpawn(() => ({ error: ENOENT }))
    const svc = new GitService({ spawn: f.spawnFn })
    const snap = await svc.snapshot(tmp)
    check('isRepo is false', snap.isRepo, false)
    assert(
      typeof snap.error === 'string' && snap.error.includes('未找到 git'),
      'error says git is missing in plain language',
      `got ${JSON.stringify(snap.error)}`
    )
    assert(
      !String(snap.error).includes('ENOENT'),
      'the raw ENOENT is translated, not leaked',
      `got ${JSON.stringify(snap.error)}`
    )
    check('only one spawn attempt was made', f.calls.length, 1)
    await svc.snapshot(tmp)
    check('the failure is cached too', f.calls.length, 1)
  })

  // ── hung git ──
  console.log('git-service: timeout')
  await section('timeout', async () => {
    const f = fakeSpawn((cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0\n' }
      return 'hang'
    })
    const svc = new GitService({ spawn: f.spawnFn, timeoutMs: 30 })
    const diff = await svc.diffText(tmp, 'src/a.ts')
    check('ok is false', diff.ok, false)
    assert(
      typeof diff.error === 'string' && diff.error.includes('超时'),
      'a hung git times out instead of hanging the panel forever',
      `got ${JSON.stringify(diff.error)}`
    )
    check('the hung process was killed', f.children[f.children.length - 1].killed, true)
  })

  // ── write lock ──
  console.log('git-service: auto-update write lock')
  await section('write lock', async () => {
    const f = fakeSpawn(repoRouter(' M a.ts\0'))
    const svc = new GitService({ spawn: f.spawnFn, getManagedDir: () => tmp })
    check('the managed dir itself is locked', svc.isWriteLocked(tmp), true)
    check('a child of it is locked', svc.isWriteLocked(sub), true)
    check('an unrelated dir is not locked', svc.isWriteLocked(path.dirname(tmp)), false)
    check('an unknown managed dir locks nothing', new GitService({ spawn: f.spawnFn }).isWriteLocked(tmp), false)
    const snap = await svc.snapshot(tmp)
    check('snapshot reports writeLocked', snap.writeLocked, true)
  })

  // ── diff safety ──
  console.log('git-service: diff path handling')
  await section('argument order', async () => {
    const f = fakeSpawn(repoRouter(''))
    await new GitService({ spawn: f.spawnFn }).diffText(tmp, 'src/a.ts')
    const args = f.calls[f.calls.length - 1].args
    check('the path comes after --', args[args.length - 2], '--')
    check('the path is the last arg', args[args.length - 1], 'src/a.ts')
    check('color is disabled', args.includes('--no-color'), true)
    check('external diff drivers are disabled', args.includes('--no-ext-diff'), true)
  })
  await section('traversal refused', async () => {
    const f = fakeSpawn(repoRouter(''))
    const svc = new GitService({ spawn: f.spawnFn })
    const before = f.calls.length
    const r = await svc.diffText(tmp, '../../etc/passwd')
    check('a .. path is refused', r.ok, false)
    assert(
      typeof r.error === 'string' && r.error.includes('路径不在该目录内'),
      'refusal is explained',
      `got ${JSON.stringify(r.error)}`
    )
    check('no git was spawned for it', f.calls.length, before)
  })
  await section('outside dir refused', async () => {
    const f = fakeSpawn(repoRouter(''))
    const r = await new GitService({ spawn: f.spawnFn })
      .diffText(tmp, path.join(path.dirname(tmp), 'elsewhere', 'x.ts'))
    check('an absolute path outside the dir is refused', r.ok, false)
  })
  await section('empty path refused', async () => {
    const f = fakeSpawn(repoRouter(''))
    const r = await new GitService({ spawn: f.spawnFn }).diffText(tmp, '')
    check('an empty path is refused', r.ok, false)
  })
  await section('oversized diff', async () => {
    // A 50 MB diff must not be shipped over IPC to the renderer whole.
    const huge = 'x'.repeat(MAX_DIFF_CHARS + 1000)
    const f = fakeSpawn((cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0\n' }
      if (args[0] === 'diff') return { code: 0, stdout: huge }
      return { code: 0, stdout: '' }
    })
    const r = await new GitService({ spawn: f.spawnFn }).diffText(tmp, 'big.bin')
    check('an oversized diff still succeeds', r.ok, true)
    check('it is flagged as truncated', r.truncated, true)
    check('it is cut to the cap', r.text.length, MAX_DIFF_CHARS)
  })
  await section('git failure surfaces', async () => {
    const f = fakeSpawn((cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0\n' }
      if (args[0] === 'diff') return { code: 1, stderr: 'fatal: ambiguous argument\n' }
      return { code: 0, stdout: '' }
    })
    const r = await new GitService({ spawn: f.spawnFn }).diffText(tmp, 'a.ts')
    check('a non-zero exit is a failure', r.ok, false)
    check('git says why', r.error, 'fatal: ambiguous argument')
  })

  // ── repo detection helper ──
  console.log('git-service: repo detection')
  await section('repo detection', async () => {
    // Note: this writes a .git FILE into the temp dir, so it runs last.
    check('a dir without .git is not a repo', looksLikeRepo(tmp), false)
    fs.writeFileSync(path.join(tmp, '.git'), 'gitdir: elsewhere\n')
    check('a .git FILE counts (worktree / submodule)', looksLikeRepo(tmp), true)
  })

  // ── write operations: the three §3.8 guards + happy paths ──

  console.log('git-service: write operations (stage/unstage/commit)')

  await section('stage refuses the auto-update workspace', async () => {
    const f = fakeSpawn(repoRouter(''))
    const svc = new GitService({ spawn: f.spawnFn, getManagedDir: () => tmp })
    const r = await svc.stage(tmp, ['src/a.ts'])
    check('ok is false', r.ok, false)
    assert(
      typeof r.error === 'string' && r.error.includes('自动更新'),
      'refusal names the auto-update management',
      JSON.stringify(r.error)
    )
    // The refusal happens BEFORE git is spawned: guarding by not spawning is
    // the whole point — a guard that still runs the command first has failed.
    check('no git call was made', f.calls.length, 0)
  })

  await section('stage refuses while index.lock exists', async () => {
    // The fake repo router answers `rev-parse --git-path index.lock` with a
    // relative path inside tmp; a real lock file is placed there.
    const lockPath = path.join(tmp, '.git', 'index.lock')
    // An earlier section wrote `.git` as a FILE (worktree probe) — clear it.
    fs.rmSync(path.join(tmp, '.git'), { force: true, recursive: true })
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true })
    fs.writeFileSync(lockPath, '')
    try {
      const f = fakeSpawn((cmd, args) => {
        if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0\n' }
        if (args[0] === 'rev-parse' && args[2] === 'index.lock') return { code: 0, stdout: '.git/index.lock\n' }
        return { code: 0, stdout: '' }
      })
      const svc = new GitService({ spawn: f.spawnFn })
      const r = await svc.stage(tmp, ['src/a.ts'])
      check('ok is false', r.ok, false)
      assert(
        typeof r.error === 'string' && r.error.includes('index.lock'),
        'refusal names the lock',
        JSON.stringify(r.error)
      )
      const addCalls = f.calls.filter((c) => c.args[0] === 'add')
      check('no git add was made', addCalls.length, 0)
    } finally {
      fs.rmSync(lockPath, { force: true })
    }
  })

  await section('stage passes a validated file list to git add', async () => {
    const f = fakeSpawn(repoRouter(''))
    const svc = new GitService({ spawn: f.spawnFn })
    const r = await svc.stage(tmp, ['src/a.ts', 'src/b.ts'])
    check('ok', r.ok, true)
    const add = f.calls.find((c) => c.args[0] === 'add')
    assert(add !== undefined, 'git add was spawned', JSON.stringify(f.calls.map((c) => c.args[0])))
    check('add args keep `--` path separation', add.args.slice(0, 2), ['add', '--'])
    check('both files forwarded', add.args.slice(2), ['src/a.ts', 'src/b.ts'])
  })

  await section('stage rejects traversal and junk without spawning git add', async () => {
    const f = fakeSpawn(repoRouter(''))
    const svc = new GitService({ spawn: f.spawnFn })
    for (const bad of [['../outside.txt'], ['src/a.ts', 42], ['src/../../x'], []]) {
      const r = await svc.stage(tmp, bad)
      check(`ok is false for ${JSON.stringify(bad)}`, r.ok, false)
      check(`no add for ${JSON.stringify(bad)}`, f.calls.filter((c) => c.args[0] === 'add').length, 0)
    }
    const r = await svc.stage(tmp, ['../outside.txt'])
    assert(
      typeof r.error === 'string' && r.error.includes('目录内'),
      'traversal refusal names the boundary',
      JSON.stringify(r.error)
    )
  })

  await section('stage caps the file list', async () => {
    const f = fakeSpawn(repoRouter(''))
    const svc = new GitService({ spawn: f.spawnFn })
    const many = Array.from({ length: WRITE_FILE_LIMIT + 1 }, (_, i) => `f${i}.txt`)
    const r = await svc.stage(tmp, many)
    check('ok is false over the limit', r.ok, false)
    check('no add spawned', f.calls.filter((c) => c.args[0] === 'add').length, 0)
  })

  await section('unstage uses reset against HEAD', async () => {
    const f = fakeSpawn(repoRouter(''))
    const svc = new GitService({ spawn: f.spawnFn })
    const r = await svc.unstage(tmp, ['src/c.ts'])
    check('ok', r.ok, true)
    const reset = f.calls.find((c) => c.args[0] === 'reset')
    assert(reset !== undefined, 'git reset was spawned', JSON.stringify(f.calls.map((c) => c.args[0])))
    check('reset is index-only against HEAD', reset.args.slice(0, 4), ['reset', '-q', 'HEAD', '--'])
  })

  await section('commit refuses an empty or whitespace message', async () => {
    const f = fakeSpawn(repoRouter(''))
    const svc = new GitService({ spawn: f.spawnFn })
    for (const bad of ['', '   ', null, undefined, 42]) {
      const r = await svc.commit(tmp, bad)
      check(`ok is false for ${JSON.stringify(bad)}`, r.ok, false)
      check(`no commit for ${JSON.stringify(bad)}`, f.calls.filter((c) => c.args[0] === 'commit').length, 0)
    }
  })

  await section('commit forwards the message as ONE argument (no shell)', async () => {
    const f = fakeSpawn(repoRouter(''))
    const svc = new GitService({ spawn: f.spawnFn })
    const evil = 'look; rm -rf / && `whoami` "quoted"'
    const r = await svc.commit(tmp, evil)
    check('ok', r.ok, true)
    const commit = f.calls.find((c) => c.args[0] === 'commit')
    assert(commit !== undefined, 'git commit was spawned', '')
    check('message travels as one argv element', commit.args[1] === '-m' && commit.args[2] === evil, true)
  })

  await section('commit surfaces the missing-identity failure plainly', async () => {
    const f = fakeSpawn((cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0\n' }
      if (args[0] === 'commit') return { code: 128, stderr: '*** Please tell me who you are.\n\nyour user.name\n' }
      return { code: 0, stdout: '' }
    })
    const svc = new GitService({ spawn: f.spawnFn })
    const r = await svc.commit(tmp, 'msg')
    check('ok is false', r.ok, false)
    assert(
      typeof r.error === 'string' && r.error.includes('user.name'),
      'the error names user.name instead of dumping git hints',
      JSON.stringify(r.error)
    )
  })

  await section('commit reports a generic git failure verbatim', async () => {
    const f = fakeSpawn((cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0\n' }
      if (args[0] === 'commit') return { code: 1, stderr: 'nothing to commit\n' }
      return { code: 0, stdout: '' }
    })
    const svc = new GitService({ spawn: f.spawnFn })
    const r = await svc.commit(tmp, 'msg')
    check('ok is false', r.ok, false)
    check('stderr is the error', r.error, 'nothing to commit')
  })
}

main()
  .catch((err) => {
    fail++
    console.log(`  FAIL  unexpected error\n        ${err && err.stack ? err.stack : err}`)
  })
  .then(() => {
    console.log(`\ngit-service: ${pass} passed, ${fail} failed`)
    if (fail > 0) process.exit(1)
  })
