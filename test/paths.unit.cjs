/**
 * Unit tests for file-path recognition in agent output
 * (src/path-links.ts → lib-new/path-links.js).
 *
 * The matcher is heuristic, so these cases pin the two failure modes that
 * actually matter: missing a real path (feature broken) and matching URL
 * routes (annoying noise that makes the panel untrustworthy).
 *
 * Run with: npm test
 */
const path = require('node:path')
const {
  findPaths,
  isLikelyPath,
} = require(path.join(__dirname, '..', 'lib-new', 'path-links.js'))

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`)
  }
}
const texts = (s) => findPaths(s).map((h) => h.text)

console.log('paths: windows')
{
  check('backslash path', texts('Wrote C:\\Users\\a\\proj\\src\\main.ts'),
    ['C:\\Users\\a\\proj\\src\\main.ts'])
  check('forward-slash path', texts('reading D:/DevWorks/shell/src/main.ts'),
    ['D:/DevWorks/shell/src/main.ts'])
  check('path in a sentence', texts('已写入 C:\\tmp\\out.txt 完成'),
    ['C:\\tmp\\out.txt'])
}

console.log('paths: posix')
{
  check('absolute file', texts('patched /home/user/proj/src/app.ts'),
    ['/home/user/proj/src/app.ts'])
  check('directory (3+ segments)', texts('cd /home/user/project'),
    ['/home/user/project'])
  check('quoted path', texts("opened '/srv/app/index.js'"),
    ['/srv/app/index.js'])
}

console.log('paths: punctuation trimming')
{
  check('trailing period', texts('Wrote /home/a/b.txt.'), ['/home/a/b.txt'])
  check('trailing comma', texts('/home/a/b.txt, then more'), ['/home/a/b.txt'])
  check('trailing paren', texts('see (/home/a/b.txt)'), ['/home/a/b.txt'])
  check('trailing quote', texts('"/home/a/b.txt"'), ['/home/a/b.txt'])
}

console.log('paths: noise is rejected')
{
  check('https URL not a path', texts('GET https://example.com/a/b/c.ts'), [])
  check('protocol-relative not a path', texts('see //cdn.example.com/x.js'), [])
  check('api route not a path', texts('GET /api/events'), [])
  check('too short', texts('wrote /tmp'), [])
  check('bare filename not a path', texts('main.ts'), [])
  check('flag not a path', texts('run --out=/x'), [])
  check('plain prose', texts('the agent finished successfully'), [])
}

console.log('paths: multiple and mixed')
{
  check('two paths in one line', texts('diff /home/a/x.ts and /home/b/y.ts'),
    ['/home/a/x.ts', '/home/b/y.ts'])
  check('windows and posix together', texts('C:\\w\\a.ts vs /home/b.ts'),
    ['C:\\w\\a.ts', '/home/b.ts'])
  check('ordering by position', findPaths('/a/b/c.ts then /d/e/f.ts').map((h) => h.index),
    [0, 15])
}

console.log('paths: chinese context')
{
  check('chinese sentence', texts('已修改文件 /home/user/proj/src/主程序.ts'),
    ['/home/user/proj/src/主程序.ts'])
}

console.log('paths: isLikelyPath')
{
  check('whole string is a path', isLikelyPath('/home/a/b.ts'), true)
  check('whole string is windows path', isLikelyPath('C:\\a\\b\\c.ts'), true)
  check('sentence is not', isLikelyPath('wrote /home/a/b.ts today'), false)
  check('empty is not', isLikelyPath('   '), false)
}

console.log('paths: indices are usable for rendering')
{
  const line = 'ok -> /home/a/b.ts'
  const hit = findPaths(line)[0]
  check('slice by index round-trips', line.slice(hit.index, hit.index + hit.length), hit.text)
}

console.log(`\npaths: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
