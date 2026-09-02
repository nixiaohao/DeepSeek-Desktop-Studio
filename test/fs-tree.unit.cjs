/**
 * Unit tests for src/fs-tree.ts (→ lib-new/fs-tree.js).
 *
 * Everything here is decision logic with no I/O, so it runs in plain node.
 * Two areas get the most attention because they fail silently in ways that
 * only show up on somebody else's machine:
 *
 *   1. `parsePorcelainZ` — git's `-z` output is NUL-separated and renames carry
 *      TWO paths. Getting the record boundary wrong does not throw, it just
 *      shifts every filename by one, which looks like a working panel full of
 *      wrong names.
 *   2. `isWithinRoot` — the traversal guard that stands between a string from
 *      the renderer and a process boundary. The prefix-attack case
 *      (`/foo` vs `/foobar`) is the one everyone gets wrong.
 *
 * Run with: npm test
 */
const path = require('node:path')
const {
  isIgnoredName,
  sortEntries,
  isWithinRoot,
  parsePorcelainZ,
  summarizeGitStatus,
  gitStatusLabel,
  gitStatusBadge,
  indexGitStatus,
  gitStatusFor,
  parseBranch,
  relativeTo,
  buildTreeRows,
  MAX_TREE_ROWS,
} = require(path.join(__dirname, '..', 'lib-new', 'fs-tree.js'))

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
const entry = (name, isDir) => ({ name, path: '/x/' + name, isDir, expandable: isDir })
/** A DirEntry at a real parent path, for building fake directory listings. */
const entry2 = (parent, name, isDir) => ({
  name,
  path: parent + '/' + name,
  isDir,
  expandable: isDir,
})

// ── ignore rules ──

console.log('fs-tree: ignore rules')
check('node_modules is ignored', isIgnoredName('node_modules'), true)
check('.git is ignored', isIgnoredName('.git'), true)
check('dist is ignored', isIgnoredName('dist'), true)
check('__pycache__ is ignored', isIgnoredName('__pycache__'), true)
check('.DS_Store is ignored', isIgnoredName('.DS_Store'), true)
check('vim swap files are ignored', isIgnoredName('.main.ts.swp'), true)
check('editor backups are ignored', isIgnoredName('main.ts~'), true)
check('src is not ignored', isIgnoredName('src'), false)
check('package.json is not ignored', isIgnoredName('package.json'), false)
check('empty name is ignored', isIgnoredName(''), true)

// ── sorting ──

console.log('fs-tree: sorting')
check(
  'directories come before files',
  sortEntries([entry('b.ts', false), entry('a', true)]).map((e) => e.name),
  ['a', 'b.ts']
)
check(
  'names sort case-insensitively',
  sortEntries([entry('b.ts', false), entry('A.ts', false)]).map((e) => e.name),
  ['A.ts', 'b.ts']
)
check(
  'equal-ignoring-case names get a stable order',
  sortEntries([entry('abc.ts', false), entry('ABC.ts', false)]).map((e) => e.name),
  ['ABC.ts', 'abc.ts']
)
check(
  'sorting does not mutate the input',
  (() => {
    const input = [entry('b.ts', false), entry('a.ts', false)]
    sortEntries(input)
    return input.map((e) => e.name)
  })(),
  ['b.ts', 'a.ts']
)
check('empty list sorts to empty', sortEntries([]), [])

// ── traversal guard ──

console.log('fs-tree: path traversal guard')
check('root itself is inside root', isWithinRoot('/repo', '/repo'), true)
check('direct child is inside root', isWithinRoot('/repo', '/repo/src'), true)
check('nested child is inside root', isWithinRoot('/repo', '/repo/src/a/b.ts'), true)
check(
  'sibling with a shared prefix is NOT inside',
  isWithinRoot('/repo', '/repo-backup/x'),
  false
)
check('parent is not inside', isWithinRoot('/repo/src', '/repo'), false)
check('trailing slash on root is tolerated', isWithinRoot('/repo/', '/repo/src'), true)
check('trailing slash on candidate is tolerated', isWithinRoot('/repo', '/repo/src/'), true)
check('empty root rejects', isWithinRoot('', '/repo'), false)
check('empty candidate rejects', isWithinRoot('/repo', ''), false)
check(
  'windows separators work',
  isWithinRoot('C:\\work\\repo', 'C:\\work\\repo\\src\\a.ts'),
  true
)
check(
  'windows sibling prefix rejected',
  isWithinRoot('C:\\work\\repo', 'C:\\work\\repo-2\\a.ts'),
  false
)

// ── porcelain parsing ──

console.log('fs-tree: git status -z parsing')
{
  const out = parsePorcelainZ(' M src/a.ts\0')
  check('one modified file', out.length, 1)
  check('  code', out[0].code, ' M')
  check('  path', out[0].path, 'src/a.ts')
  check('  unstaged', out[0].unstaged, true)
  check('  staged', out[0].staged, false)
}
check('empty input yields nothing', parsePorcelainZ(''), [])
check(
  'no trailing separator does not create a phantom row',
  parsePorcelainZ(' M a.ts').length,
  1
)
check(
  'two records parse to two rows',
  parsePorcelainZ(' M a.ts\0?? b.ts\0').map((e) => e.path),
  ['a.ts', 'b.ts']
)
{
  // The whole reason for -z: a path with a space or non-ASCII name must come
  // through byte-for-byte. Without -z git would quote it as "a\303\251.txt".
  const out = parsePorcelainZ(' M src/my file.ts\0 M 中文/文件.txt\0')
  check('paths with spaces survive', out[0].path, 'src/my file.ts')
  check('non-ascii paths survive', out[1].path, '中文/文件.txt')
}
{
  const out = parsePorcelainZ('R  old.ts\0new.ts\0')
  check('rename yields one row', out.length, 1)
  check('rename shows the destination', out[0].path, 'new.ts')
  check('rename records the source', out[0].from, 'old.ts')
}
{
  const out = parsePorcelainZ('R  old.ts\0new.ts\0 M after.ts\0')
  check('a rename does not shift the following record', out.length, 2)
  check('  rename row', out[0].path, 'new.ts')
  check('  next row is intact', out[1].path, 'after.ts')
}
{
  const out = parsePorcelainZ('?? new.ts\0')
  check('untracked is untracked', out[0].untracked, true)
  check('untracked is not staged', out[0].staged, false)
  check('untracked is not unstaged', out[0].unstaged, false)
}
{
  const out = parsePorcelainZ('UU conflicted.ts\0')
  check('conflict is flagged', out[0].conflicted, true)
  check('conflict is not counted as staged', out[0].staged, false)
  check('conflict is not counted as unstaged', out[0].unstaged, false)
}
{
  const out = parsePorcelainZ('A  added.ts\0')
  check('staged add is staged', out[0].staged, true)
  check('staged add is not unstaged', out[0].unstaged, false)
}
{
  const out = parsePorcelainZ('MM both.ts\0')
  check('staged and unstaged at once', [out[0].staged, out[0].unstaged], [true, true])
}
check('malformed short records are skipped', parsePorcelainZ('ab\0 M ok.ts\0').map((e) => e.path), ['ok.ts'])
check(
  'a record with no path is skipped',
  parsePorcelainZ(' M \0 M ok.ts\0').map((e) => e.path),
  ['ok.ts']
)

// ── summary ──

console.log('fs-tree: status summary')
{
  const s = summarizeGitStatus(parsePorcelainZ(' M a\0A  b\0?? c\0UU d\0'))
  check('total counts every row', s.total, 4)
  check('staged', s.staged, 1)
  check('unstaged', s.unstaged, 1)
  check('untracked', s.untracked, 1)
  check('conflicted', s.conflicted, 1)
}
{
  // A conflicted file must not also inflate the staged/unstaged counters —
  // "1 staged, 1 conflicted" for the same file reads as twice the change.
  const s = summarizeGitStatus(parsePorcelainZ('UU d\0'))
  check('a conflict alone reports zero staged', s.staged, 0)
  check('a conflict alone reports zero unstaged', s.unstaged, 0)
}
check('empty summary is all zeroes', summarizeGitStatus([]), {
  total: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
})

// ── labels ──

console.log('fs-tree: labels and badges')
check('untracked label', gitStatusLabel('??'), '未跟踪')
check('unstaged modify label', gitStatusLabel(' M'), '已修改')
check('staged modify label', gitStatusLabel('M '), '修改(已暂存)')
check('both columns label', gitStatusLabel('MM'), '修改(暂存+未暂存)')
check('staged add label', gitStatusLabel('A '), '新增(已暂存)')
check('deleted label', gitStatusLabel(' D'), '已删除')
check('conflict label', gitStatusLabel('UU'), '冲突')
check('ignored label', gitStatusLabel('!!'), '已忽略')
check(
  'an unknown code falls back to the raw code, not a blank',
  gitStatusLabel('ZZ'),
  'ZZ'
)
check('untracked badge', gitStatusBadge(parsePorcelainZ('?? a\0')[0]), '?')
check('conflict badge', gitStatusBadge(parsePorcelainZ('UU a\0')[0]), '!')
check('staged badge', gitStatusBadge(parsePorcelainZ('A  a\0')[0]), '●')
check('unstaged badge', gitStatusBadge(parsePorcelainZ(' M a\0')[0]), 'M')
check('clean file has no badge', gitStatusBadge(parsePorcelainZ('A  a\0')[0]) !== '', true)

// ── index ──

console.log('fs-tree: status index')
{
  // git always reports forward slashes; the file tree walks with the PLATFORM
  // separator (backslash on Windows). Both must resolve to the same row or
  // every file looks clean on Windows — a silent wrong answer, not a crash.
  const map = indexGitStatus(parsePorcelainZ(' M src/a.ts\0?? src/b.ts\0'))
  check('the index is keyed with forward slashes', map.has('src/a.ts'), true)
  check('a forward-slash lookup resolves', gitStatusFor(map, 'src/a.ts') !== undefined, true)
  check('a backslash lookup resolves', gitStatusFor(map, 'src\\a.ts') !== undefined, true)
  check(
    'lookup returns the right row, not just any row',
    gitStatusFor(map, 'src\\b.ts')?.untracked,
    true
  )
  check('an untracked path is absent', gitStatusFor(map, 'src/clean.ts'), undefined)
}

// ── branch ──

console.log('fs-tree: branch parsing')
check('a branch name parses', parseBranch('main\n'), 'main')
check('a slash branch name survives', parseBranch('feature/panel\n'), 'feature/panel')
check('detached HEAD is not a branch', parseBranch('HEAD\n'), '')
check('empty output yields empty', parseBranch(''), '')
check('whitespace-only output yields empty', parseBranch('   \n'), '')

// ── repo-relative rebasing ──

console.log('fs-tree: repo-relative paths')
check('a nested file rebases', relativeTo('/repo', '/repo/src/a.ts'), 'src/a.ts')
check('a deeper file rebases', relativeTo('/repo', '/repo/src/lib/b.ts'), 'src/lib/b.ts')
check('the root itself rebases to empty', relativeTo('/repo', '/repo'), '')
check(
  'a path outside the root is returned unchanged',
  relativeTo('/repo', '/elsewhere/a.ts'),
  '/elsewhere/a.ts'
)
check(
  'a sibling with a shared prefix is not rebased',
  relativeTo('/repo', '/repo-2/a.ts'),
  '/repo-2/a.ts'
)
check(
  'windows paths rebase',
  relativeTo('C:\\work\\repo', 'C:\\work\\repo\\src\\a.ts'),
  'src/a.ts'
)
check('an empty root returns the path', relativeTo('', '/repo/a.ts'), '/repo/a.ts')

// ── tree flattening ──

console.log('fs-tree: tree flattening')
{
  // A tiny in-memory filesystem. Rows are addressed by absolute path so the
  // shape mirrors what FileTree hands in.
  const FS = {
    '/r': [
      entry2('/r', 'src', true),
      entry2('/r', 'readme.md', false),
    ],
    '/r/src': [
      entry2('/r/src', 'a.ts', false),
      entry2('/r/src', 'b.ts', false),
    ],
  }
  const readDir = (dir) => FS[dir] ?? []
  const base = { root: '/r', readDir, expanded: new Set() }

  check('a collapsed root lists only its children', buildTreeRows(base).rows.map((r) => r.name), [
    'src',
    'readme.md',
  ])
  check('top-level rows are depth 0', buildTreeRows(base).rows.map((r) => r.depth), [0, 0])
  check(
    'directories are marked expandable, files are not',
    buildTreeRows(base).rows.map((r) => r.expandable),
    [true, false]
  )

  check(
    'nothing is expanded when the set is empty',
    buildTreeRows(base).rows.map((r) => r.expanded),
    [false, false]
  )

  const open = buildTreeRows({ ...base, expanded: new Set(['/r/src']) })
  // The renderer needs this to point the disclosure triangle the right way.
  // Deriving it from the next row's depth breaks on the last row.
  check('the open folder is flagged, its siblings are not', open.rows.map((r) => r.expanded), [
    true,
    false,
    false,
    false,
  ])
  check('a file is never flagged expanded', open.rows[1].expanded, false)
  check('an expanded folder appends its children', open.rows.map((r) => r.name), [
    'src',
    'a.ts',
    'b.ts',
    'readme.md',
  ])
  check('children are indented one level', open.rows.map((r) => r.depth), [0, 1, 1, 0])

  check(
    'an empty directory contributes no rows',
    buildTreeRows({ root: '/r', readDir: () => [], expanded: new Set() }).rows.length,
    0
  )
}
{
  // Git badges must reach the rows, keyed through the repo root.
  const FS = { '/repo': [entry2('/repo', 'src', true)], '/repo/src': [entry2('/repo/src', 'a.ts', false)] }
  const index = indexGitStatus(parsePorcelainZ(' M src/a.ts\0'))
  const res = buildTreeRows({
    root: '/repo',
    readDir: (d) => FS[d] ?? [],
    expanded: new Set(['/repo/src']),
    statusFor: (p) => gitStatusFor(index, relativeTo('/repo', p)),
  })
  check('a dirty file gets a badge', res.rows[1].badge, 'M')
  check('a dirty file gets a label', res.rows[1].status, '已修改')
  check('a clean directory has no badge', res.rows[0].badge, '')
}
{
  // Depth and row caps: without them a symlink cycle or a forgotten
  // node_modules turns the panel into a hang.
  const deep = {}
  let p = '/x'
  for (let i = 0; i < 40; i++) {
    deep[p] = [entry2(p, 'd' + i, true)]
    p = p + '/d' + i
  }
  deep[p] = []
  const res = buildTreeRows({
    root: '/x',
    readDir: (d) => deep[d] ?? [],
    expanded: new Set(Object.keys(deep)),
    maxDepth: 3,
  })
  check('depth is capped', Math.max(...res.rows.map((r) => r.depth)) <= 3, true)

  const wide = { '/w': Array.from({ length: 50 }, (_, i) => entry2('/w', 'f' + i, false)) }
  const capped = buildTreeRows({ root: '/w', readDir: (d) => wide[d] ?? [], expanded: new Set(), maxRows: 10 })
  check('row count is capped', capped.rows.length, 10)
  check('being capped is reported', capped.truncated, true)

  const notCapped = buildTreeRows({ root: '/w', readDir: (d) => wide[d] ?? [], expanded: new Set(), maxRows: 100 })
  check('under the cap nothing is truncated', notCapped.truncated, false)
  check('the default cap is generous', MAX_TREE_ROWS >= 1000, true)
}

console.log(`\nfs-tree: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
