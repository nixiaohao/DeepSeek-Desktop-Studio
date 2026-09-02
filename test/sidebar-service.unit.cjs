/**
 * Unit tests for src/sidebar-service.ts (→ lib-new/sidebar-service.js).
 *
 * This is the coordinator, so what is pinned here is mostly COORDINATION:
 * throttling, coalescing concurrent refreshes, and keeping the git badges in
 * step with the tree. Those are the parts that are easy to get subtly wrong —
 * nothing throws, the panel just quietly shows stale data.
 *
 * GitService and FileTree are both injectable, so no git binary and no real
 * filesystem is involved.
 *
 * Run with: npm test
 */
const path = require('node:path')
const { FileTree } = require(path.join(__dirname, '..', 'lib-new', 'file-tree.js'))
const {
  SidebarService,
  GIT_REFRESH_MIN_INTERVAL_MS,
  CHANGED_FILES_LIMIT,
} = require(path.join(__dirname, '..', 'lib-new', 'sidebar-service.js'))

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
async function section(name, fn) {
  try {
    await fn()
  } catch (err) {
    fail++
    console.log(`  FAIL  ${name} threw\n        ${err && err.stack ? err.stack : err}`)
  }
}

const dir = (parent, name) => ({ name, path: parent + '/' + name, isDir: true, expandable: true })
const file = (parent, name) => ({ name, path: parent + '/' + name, isDir: false, expandable: false })

const TREE = {
  '/r': [dir('/r', 'src'), file('/r', 'readme.md')],
  '/r/src': [file('/r/src', 'a.ts')],
}
const fakeRead = (tree) => (d) => {
  if (!tree[d]) throw new Error(`ENOENT: ${d}`)
  return tree[d]
}

const entry = (code, p) => ({
  code,
  path: p,
  staged: code[0] !== ' ' && code[0] !== '?',
  unstaged: code[1] !== ' ' && code[1] !== '?',
  untracked: code === '??',
  conflicted: code.includes('U'),
})

/** A GitService stand-in that counts calls and returns a fixed snapshot. */
function fakeGit(snapshot) {
  const calls = { snapshot: [], diff: [] }
  return {
    calls,
    async snapshot(dir) {
      calls.snapshot.push(dir)
      return typeof snapshot === 'function' ? snapshot(dir) : snapshot
    },
    async diffText(dir, file) {
      calls.diff.push({ dir, file })
      return { ok: true, text: `diff for ${file}`, truncated: false }
    },
    isWriteLocked: () => false,
  }
}

const REPO_SNAP = {
  isRepo: true,
  branch: 'main',
  root: '/r',
  entries: [entry(' M', 'src/a.ts')],
  summary: { total: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
  writeLocked: false,
}

function make(opts = {}) {
  const changes = []
  const tree = new FileTree({ readDirSync: fakeRead(opts.tree ?? TREE) })
  const git = opts.git ?? fakeGit(REPO_SNAP)
  const svc = new SidebarService({
    tree,
    git,
    getSuggestions: () => opts.suggestions ?? [],
    onChange: () => changes.push(true),
  })
  return { svc, tree, git, changes }
}

async function main() {
  console.log('sidebar-service: initial state')
  await section('initial', async () => {
    const { svc } = make()
    check('no root yet', svc.root, '')
    check('git is empty', svc.gitInfo.isRepo, false)
    const snap = svc.snapshot()
    check('no rows', snap.rows.length, 0)
    check('no suggestions', snap.suggestions, [])
  })

  console.log('sidebar-service: setting a root')
  await section('setRoot', async () => {
    const { svc, git, changes } = make()
    await svc.setRoot('/r')
    check('root is set', svc.root, '/r')
    check('git was read once', git.calls.snapshot.length, 1)
    check('git was read for that directory', git.calls.snapshot[0], '/r')
    check('branch is picked up', svc.gitInfo.branch, 'main')
    check('the change was announced', changes.length, 1)

    const snap = svc.snapshot()
    check('rows come from the tree', snap.rows.map((r) => r.name), ['src', 'readme.md'])
    check('git summary is exposed', snap.git.summary.unstaged, 1)
  })
  await section('setRoot is a no-op for the same dir', async () => {
    const { svc, git } = make()
    await svc.setRoot('/r')
    await svc.setRoot('/r')
    check('git was not re-read', git.calls.snapshot.length, 1)
  })
  await section('the tree is never badged with the previous repo', async () => {
    // Both directories hold a file called `same.ts`, but only the FIRST repo
    // reports it modified. If gitState survived the switch, the new directory
    // would show a modification that belongs to the old one — silently wrong,
    // and the exact kind of wrong that makes people stop trusting the panel.
    const DIRTY_SNAP = {
      ...REPO_SNAP,
      entries: [entry(' M', 'same.ts')],
      summary: { total: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
    }
    const OTHER_SNAP = {
      ...REPO_SNAP,
      root: '/other',
      branch: 'dev',
      entries: [],
      summary: { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    }
    const tree = { '/r': [file('/r', 'same.ts')], '/other': [file('/other', 'same.ts')] }

    let release = () => {}
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const git = fakeGit(async (d) => {
      if (d === '/other') {
        await gate
        return OTHER_SNAP
      }
      return DIRTY_SNAP
    })

    const { svc } = make({ git, tree })
    await svc.setRoot('/r')
    check('the first root shows the modification', svc.snapshot().rows[0].badge, 'M')

    const pending = svc.setRoot('/other')
    // Mid-switch: the tree already points at /other, git has not landed yet.
    const mid = svc.snapshot()
    check('the rows already show the new directory', mid.rows.map((r) => r.name), ['same.ts'])
    check('with no stale badge from the old repo', mid.rows.every((r) => r.badge === ''), true)
    // The badges are rebased through the repo root so they mostly cannot bleed
    // across directories, but the BRANCH has no such protection: without the
    // reset the header would keep showing the previous repo while the new tree
    // is already on screen.
    check('and the old branch is not reported', mid.git.branch, '')
    check('nor the old file list', mid.git.files.length, 0)

    release()
    await pending
    check('and the switch completes', svc.gitInfo.branch, 'dev')
    check('with the new badge', svc.snapshot().rows[0].badge, '')
  })
  await section('switching roots while a refresh is in flight', async () => {
    // Reachable in the app: the mux stream calls refreshGit() constantly, so a
    // directory switch can easily land while a status read is already running.
    // The switch must wait for that read rather than start a second one, and
    // must not leave the finished read (which is for the OLD directory) shown
    // against the NEW tree.
    let release = () => {}
    const gate = new Promise((resolve) => {
      release = resolve
    })
    let n = 0
    const git = fakeGit(async (d) => {
      n++
      if (n === 2) await gate
      return d === '/r' ? REPO_SNAP : { ...REPO_SNAP, branch: 'dev' }
    })
    const tree = { '/r': [file('/r', 'a.ts')], '/other': [file('/other', 'b.ts')] }
    const { svc } = make({ git, tree })

    await svc.setRoot('/r')
    const inflight = svc.refreshGit(true)
    const switching = svc.setRoot('/other')

    check('the tree has already switched', svc.root, '/other')
    check('but the old branch is not on screen', svc.gitInfo.branch, '')

    release()
    await inflight
    await switching
    check('the new directory was actually read', git.calls.snapshot[git.calls.snapshot.length - 1], '/other')
    check('and its branch is the one on screen', svc.gitInfo.branch, 'dev')
  })
  await section('a throwing git report does not take the sidebar down', async () => {
    // GitService never rejects, but it is injected; setRoot() must not turn a
    // broken collaborator into an IPC-level "Error invoking remote method".
    const git = fakeGit(async (d) => {
      if (d === '/broken') throw new Error('git 已损坏')
      return REPO_SNAP
    })
    const { svc } = make({ git, tree: { '/r': [file('/r', 'a.ts')], '/broken': [file('/broken', 'b.ts')] } })
    await svc.setRoot('/r')
    check('the first root is a repo', svc.gitInfo.isRepo, true)
    await svc.setRoot('/broken')
    check('setRoot did not reject', svc.root, '/broken')
    check('the stale branch is gone', svc.gitInfo.branch, '')
    check('the failure is reported', svc.gitInfo.error.includes('git 已损坏'), true)
    check('the tree still renders', svc.snapshot().rows.length, 1)
  })
  await section('setRoot with an empty path is ignored', async () => {
    const { svc, git } = make()
    await svc.setRoot('')
    check('root stays empty', svc.root, '')
    check('no git call', git.calls.snapshot.length, 0)
  })

  console.log('sidebar-service: refresh throttling')
  await section('throttle', async () => {
    const { svc, git } = make()
    await svc.setRoot('/r')
    // setRoot() already refreshed, so git is fresh by definition. This is what
    // stops the mux stream (which can fire many times a second) from re-running
    // `git status` on every frame.
    check('an immediate refresh is skipped', await svc.refreshGit(), false)
    check('so no extra git call happened', git.calls.snapshot.length, 1)
  })
  await section('force bypasses the throttle', async () => {
    const { svc, git } = make()
    await svc.setRoot('/r')
    check('force reports it ran', await svc.refreshGit(true), true)
    check('force runs another git call', git.calls.snapshot.length, 2)
  })
  await section('the throttle is time based', async () => {
    const { svc, git } = make()
    await svc.setRoot('/r')
    // Pretend the minimum interval has elapsed.
    svc.lastGitAt = Date.now() - GIT_REFRESH_MIN_INTERVAL_MS - 10
    check('a refresh after the interval runs', await svc.refreshGit(), true)
    check('and calls git again', git.calls.snapshot.length, 2)
    check('and the next one is throttled again', await svc.refreshGit(), false)
  })
  await section('concurrent refreshes coalesce', async () => {
    // Two callers in flight must not both run: the slower one would write its
    // result last and the panel would show stale data that looks current.
    const { svc, git } = make()
    await svc.setRoot('/r')
    svc.lastGitAt = 0
    await Promise.all([svc.refreshGit(true), svc.refreshGit(true), svc.refreshGit(true)])
    check('only one git call was made', git.calls.snapshot.length, 2)
  })
  await section('refresh with no root is a no-op', async () => {
    const { svc, git } = make()
    check('nothing to refresh', await svc.refreshGit(true), false)
    check('git was never called', git.calls.snapshot.length, 0)
  })

  console.log('sidebar-service: git refresh invalidates the tree cache')
  await section('cache invalidation', async () => {
    // The whole point: a file created after the first listing must show up.
    const tree = { '/r': [file('/r', 'a.ts')] }
    const { svc } = make({ tree })
    await svc.setRoot('/r')
    check('one file to start', svc.snapshot().rows.map((r) => r.name), ['a.ts'])
    tree['/r'] = [file('/r', 'a.ts'), file('/r', 'new.ts')]
    svc.lastGitAt = 0
    await svc.refreshGit(true)
    check('the new file appears after a refresh', svc.snapshot().rows.map((r) => r.name), [
      'a.ts',
      'new.ts',
    ])
  })

  await section('a background refresh announces itself', async () => {
    // Refreshes are driven from the mux stream, so in the app nobody holds the
    // return value. If the service did not announce, the panel would sit on
    // stale git data until the user happened to click something.
    const { svc, changes } = make()
    await svc.setRoot('/r')
    const before = changes.length
    svc.lastGitAt = 0
    await svc.refreshGit(true)
    check('the refresh was announced', changes.length, before + 1)

    // An error is a state change too — otherwise a broken git would leave the
    // panel showing the last good status with no hint that it went stale.
    const broken = make({ git: fakeGit(async () => { throw new Error('boom') }) })
    await broken.svc.setRoot('/r')
    const beforeBroken = broken.changes.length
    broken.svc.lastGitAt = 0
    await broken.svc.refreshGit(true)
    check('and so is a failure', broken.changes.length, beforeBroken + 1)
    check('with the reason attached', broken.svc.gitInfo.error.includes('boom'), true)
  })
  await section('refreshAll drops the cache even when git is fresh', async () => {
    // The tree cache is separate from the git throttle: "git was fresh" says
    // nothing about whether a file appeared on disk.
    const tree = { '/r': [file('/r', 'a.ts')] }
    const { svc, git } = make({ tree })
    await svc.setRoot('/r')
    // Read once so the listing is actually cached — otherwise the test passes
    // with or without the invalidation and proves nothing.
    check('one file to start', svc.snapshot().rows.map((r) => r.name), ['a.ts'])

    tree['/r'] = [file('/r', 'a.ts'), file('/r', 'new.ts')]
    await svc.refreshAll()
    check('the new file appears', svc.snapshot().rows.map((r) => r.name), ['a.ts', 'new.ts'])
    check('without re-running git', git.calls.snapshot.length, 1)
  })

  console.log('sidebar-service: git state')
  await section('errors are surfaced', async () => {
    const { svc } = make({
      git: fakeGit({ ...REPO_SNAP, isRepo: false, error: '未找到 git，请安装 Git 后重启本程序' }),
    })
    await svc.setRoot('/r')
    check('the error reaches the snapshot', svc.snapshot().git.error, '未找到 git，请安装 Git 后重启本程序')
    check('the tree still renders', svc.snapshot().rows.length, 2)
  })
  await section('write lock is reported', async () => {
    const { svc } = make({ git: fakeGit({ ...REPO_SNAP, writeLocked: true }) })
    await svc.setRoot('/r')
    check('writeLocked reaches the snapshot', svc.snapshot().git.writeLocked, true)
  })
  await section('a huge change list is capped', async () => {
    const many = Array.from({ length: CHANGED_FILES_LIMIT + 50 }, (_, i) => entry(' M', `f${i}.ts`))
    const { svc } = make({ git: fakeGit({ ...REPO_SNAP, entries: many }) })
    await svc.setRoot('/r')
    check('the exposed list is capped', svc.snapshot().git.files.length, CHANGED_FILES_LIMIT)
  })

  console.log('sidebar-service: tree interaction')
  await section('toggling', async () => {
    const { svc, changes } = make()
    await svc.setRoot('/r')
    const before = changes.length
    svc.toggleDir('/r/src')
    check('the folder opens', svc.snapshot().rows.map((r) => r.name), ['src', 'a.ts', 'readme.md'])
    check('the change was announced', changes.length, before + 1)
    svc.collapseAll()
    check('collapseAll works', svc.snapshot().rows.length, 2)
  })
  await section('suggestions exclude the current root', async () => {
    const { svc } = make({ suggestions: ['/r', '/other', '/third'] })
    await svc.setRoot('/r')
    check('other dirs are offered', svc.snapshot().suggestions, ['/other', '/third'])
  })

  console.log('sidebar-service: diffs')
  await section('diff delegation', async () => {
    const { svc, git } = make()
    await svc.setRoot('/r')
    const r = await svc.diff('src/a.ts')
    check('the diff comes back', r.text, 'diff for src/a.ts')
    check('it was asked for the right directory', git.calls.diff[0].dir, '/r')
  })
  await section('diff with no root', async () => {
    const { svc } = make()
    const r = await svc.diff('a.ts')
    check('fails cleanly', r.ok, false)
    check('and says why', r.error, '尚未选择目录')
  })
}

main()
  .catch((err) => {
    fail++
    console.log(`  FAIL  unexpected error\n        ${err && err.stack ? err.stack : err}`)
  })
  .then(() => {
    console.log(`\nsidebar-service: ${pass} passed, ${fail} failed`)
    if (fail > 0) process.exit(1)
  })
