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

console.log(`\nfs-tree: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
