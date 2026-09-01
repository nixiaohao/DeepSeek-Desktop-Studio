/**
 * Unit tests for src/file-tree.ts (→ lib-new/file-tree.js).
 *
 * The class owns the sidebar's state — which directory is showing, which
 * folders are open, what has been read. It reads the filesystem through an
 * injected `readDirSync`, so a fake tree drives the real implementation.
 *
 * What is pinned here is mostly the CACHE, because that is where this kind of
 * code rots: a listing cached too aggressively stops showing new files, and one
 * cached not at all re-stats the disk on every render.
 *
 * Run with: npm test
 */
const path = require('node:path')
const { FileTree, defaultReadDir } = require(path.join(__dirname, '..', 'lib-new', 'file-tree.js'))

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

const dir = (parent, name) => ({ name, path: parent + '/' + name, isDir: true, expandable: true })
const file = (parent, name) => ({ name, path: parent + '/' + name, isDir: false, expandable: false })

/**
 * A fake filesystem. `throws` lists directories that should fail to read, so
 * the "unreadable directory must not kill the tree" path is exercised.
 */
function fakeFs(tree, opts = {}) {
  const reads = []
  const readDirSync = (d) => {
    reads.push(d)
    if (opts.throws && opts.throws.includes(d)) {
      const err = new Error(`EPERM: permission denied, scandir '${d}'`)
      err.code = 'EPERM'
      throw err
    }
    const list = tree[d]
    if (!list) {
      const err = new Error(`ENOENT: no such file or directory, scandir '${d}'`)
      err.code = 'ENOENT'
      throw err
    }
    return list
  }
  return { readDirSync, reads }
}

const TREE = {
  '/r': [dir('/r', 'src'), file('/r', 'readme.md')],
  '/r/src': [file('/r/src', 'a.ts'), dir('/r/src', 'lib')],
  '/r/src/lib': [file('/r/src/lib', 'b.ts')],
}

// ── empty state ──

console.log('file-tree: before a root is set')
{
  const t = new FileTree({ readDirSync: fakeFs(TREE).readDirSync })
  const snap = t.snapshot()
  check('root is empty', snap.root, '')
  check('no rows', snap.rows.length, 0)
  check('no errors', snap.errors.length, 0)
  check('not truncated', snap.truncated, false)
}

// ── basic navigation ──

console.log('file-tree: navigation')
{
  const f = fakeFs(TREE)
  const t = new FileTree({ readDirSync: f.readDirSync })
  t.setRoot('/r')

  check('root is remembered', t.root, '/r')
  check('a collapsed root shows one level', t.snapshot().rows.map((r) => r.name), ['src', 'readme.md'])
  check('nothing is expanded yet', t.isExpanded('/r/src'), false)

  t.toggle('/r/src')
  check('toggle opens', t.isExpanded('/r/src'), true)
  // Directories sort before files within a level (standard explorer behaviour),
  // so 'lib' comes before 'a.ts' even though a.ts was listed first.
  check('children appear', t.snapshot().rows.map((r) => r.name), [
    'src',
    'lib',
    'a.ts',
    'readme.md',
  ])

  t.toggle('/r/src')
  check('toggle closes again', t.isExpanded('/r/src'), false)
  check('children disappear', t.snapshot().rows.map((r) => r.name), ['src', 'readme.md'])

  // Nesting past one level is the case a naive depth counter gets wrong.
  t.toggle('/r/src')
  t.toggle('/r/src/lib')
  check('a nested folder opens', t.snapshot().rows.map((r) => r.name), [
    'src',
    'lib',
    'b.ts',
    'a.ts',
    'readme.md',
  ])
  check('depths are right', t.snapshot().rows.map((r) => r.depth), [0, 1, 2, 1, 0])

  t.collapseAll()
  check('collapseAll closes everything', t.snapshot().rows.length, 2)
}

// ── caching ──

console.log('file-tree: directory cache')
{
  const f = fakeFs(TREE)
  const t = new FileTree({ readDirSync: f.readDirSync })
  t.setRoot('/r')
  t.snapshot()
  const afterFirst = f.reads.length
  t.snapshot()
  t.snapshot()
  check('repeated renders do not re-read the disk', f.reads.length, afterFirst)

  t.refresh()
  t.snapshot()
  check('refresh() forces a re-read', f.reads.length > afterFirst, true)
}
{
  // The whole reason refresh() exists: a file created by the agent must show
  // up, and there is no filesystem watcher here to notice it.
  const grow = { '/r': [file('/r', 'a.ts')] }
  const f = fakeFs(grow)
  const t = new FileTree({ readDirSync: f.readDirSync })
  t.setRoot('/r')
  check('one file to start', t.snapshot().rows.map((r) => r.name), ['a.ts'])
  // Replaced, not mutated: a real readdir returns a NEW array, and mutating
  // the one in the fake would alias the cache instead of testing it.
  grow['/r'] = [file('/r', 'a.ts'), file('/r', 'brand-new.ts')]
  check('a new file is hidden by the cache', t.snapshot().rows.map((r) => r.name), ['a.ts'])
  t.refresh()
  check('until refresh()', t.snapshot().rows.map((r) => r.name), ['a.ts', 'brand-new.ts'])
}

// ── unreadable directories ──

console.log('file-tree: unreadable directories')
{
  const f = fakeFs(TREE, { throws: ['/r/src'] })
  const t = new FileTree({ readDirSync: f.readDirSync })
  t.setRoot('/r')
  t.toggle('/r/src')
  const snap = t.snapshot()
  check('the rest of the tree still renders', snap.rows.map((r) => r.name), ['src', 'readme.md'])
  check('the failure is reported', snap.errors.length, 1)
  check('with the offending path', snap.errors[0].path, '/r/src')
  check('and the reason', snap.errors[0].message.includes('permission denied'), true)
}
{
  // A directory that vanishes between renders must not throw out of snapshot().
  // Uses its OWN copy of the tree: deleting from the shared TREE would
  // silently break every test that runs after this one.
  const local = { '/r': [file('/r', 'a.ts')] }
  const f = fakeFs(local)
  const t = new FileTree({ readDirSync: f.readDirSync })
  t.setRoot('/r')
  t.snapshot()
  delete local['/r']
  let threw = false
  try {
    t.refresh()
    t.snapshot()
  } catch {
    threw = true
  }
  check('a vanished root does not throw', threw, false)
}

// ── re-rooting ──

console.log('file-tree: changing root')
{
  const f = fakeFs(TREE)
  const t = new FileTree({ readDirSync: f.readDirSync })
  t.setRoot('/r')
  t.toggle('/r/src')
  t.setRoot('/r/src')
  check('the new root is used', t.root, '/r/src')
  check('expansion state is dropped', t.isExpanded('/r/src'), false)
  check('rows come from the new root', t.snapshot().rows.map((r) => r.name), ['lib', 'a.ts'])
  t.setRoot('/r/src')
  check('setting the same root is a no-op', t.snapshot().rows.map((r) => r.name), ['lib', 'a.ts'])
}

// ── git badges ──

console.log('file-tree: git badges')
{
  const f = fakeFs(TREE)
  const t = new FileTree({ readDirSync: f.readDirSync })
  t.setRoot('/r')
  t.toggle('/r/src')
  // git reports paths relative to the REPO root; the tree must re-base them.
  const snap = t.snapshot({
    entries: [
      { code: ' M', path: 'src/a.ts', staged: false, unstaged: true, untracked: false, conflicted: false },
      { code: '??', path: 'readme.md', staged: false, unstaged: false, untracked: true, conflicted: false },
    ],
    repoRoot: '/r',
  })
  const byName = Object.fromEntries(snap.rows.map((r) => [r.name, r]))
  check('a modified file is badged', byName['a.ts'].badge, 'M')
  check('a modified file is labelled', byName['a.ts'].status, '已修改')
  check('an untracked file is badged', byName['readme.md'].badge, '?')
  check('a clean folder has no badge', byName['lib'].badge, '')
}
{
  // The subtree case: the tree shows /r/src but the repo root is /r, so git's
  // "src/a.ts" has to be re-based before it can match "/r/src/a.ts".
  const f = fakeFs(TREE)
  const t = new FileTree({ readDirSync: f.readDirSync })
  t.setRoot('/r/src')
  const snap = t.snapshot({
    entries: [
      { code: ' M', path: 'src/a.ts', staged: false, unstaged: true, untracked: false, conflicted: false },
    ],
    repoRoot: '/r',
  })
  const byName = Object.fromEntries(snap.rows.map((r) => [r.name, r]))
  check('a subtree file still matches its status', byName['a.ts'].badge, 'M')
  check('an untouched sibling stays clean', byName['lib'].badge, '')
}
{
  const f = fakeFs(TREE)
  const t = new FileTree({ readDirSync: f.readDirSync })
  t.setRoot('/r')
  t.toggle('/r/src')
  const snap = t.snapshot({ entries: [], repoRoot: '/r' })
  check('an empty status list badges nothing', snap.rows.every((r) => r.badge === ''), true)
  const noGit = t.snapshot()
  check('no status argument at all is fine', noGit.rows.every((r) => r.badge === ''), true)
}

// ── the real readdir ──

console.log('file-tree: real directory read')
{
  // Exercises defaultReadDir against this repo: it must hide node_modules and
  // .git, which is the single most important filter (a pnpm workspace has tens
  // of thousands of entries under node_modules).
  const fs = require('node:fs')
  const repoRoot = path.join(__dirname, '..')
  const names = defaultReadDir(repoRoot).map((e) => e.name)
  check('node_modules is filtered out', names.includes('node_modules'), false)
  check('.git is filtered out', names.includes('.git'), false)
  check('dist is filtered out', names.includes('dist'), false)
  check('src is listed', names.includes('src'), true)
  check('package.json is listed', names.includes('package.json'), true)
  check(
    'symlinked directories are not marked as directories',
    (() => {
      // A symlink to a directory: listed, but not descended into, so a cycle
      // cannot hang the walk.
      const tmpParent = fs.mkdtempSync(require('node:os').tmpdir() + path.sep)
      const target = path.join(tmpParent, 'target')
      fs.mkdirSync(target)
      const link = path.join(tmpParent, 'link')
      try {
        fs.symlinkSync(target, link, 'junction')
      } catch {
        return true // no permission to create links here; nothing to assert
      }
      return defaultReadDir(tmpParent).find((e) => e.name === 'link')?.isDir === false
    })(),
    true
  )
}

console.log(`\nfile-tree: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
