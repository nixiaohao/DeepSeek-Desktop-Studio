/**
 * Unit tests for external-editor argument building
 * (src/external-editor.ts → lib-new/external-editor.js).
 *
 * Only the pure `buildEditorArgs()` is exercised: the rest of the module needs
 * Electron's shell. `electron` is stubbed before the require so this runs
 * under plain node.
 *
 * The important property here is that a path containing spaces stays a SINGLE
 * argv element — we spawn with shell:false, so splitting it would hand the
 * editor a broken path.
 *
 * Run with: npm test
 */
const path = require('node:path')
const Module = require('module')

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { shell: { openPath: async () => '' } }
  }
  return origLoad.apply(this, arguments)
}

const {
  buildEditorArgs,
  EDITOR_PRESETS,
  describeEditorConfig,
} = require(path.join(__dirname, '..', 'lib-new', 'external-editor.js'))
Module._load = origLoad

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

const FILE = '/home/u/proj/src/main.ts'
const SPACED = 'C:\\Program Files\\My App\\src\\主程序.ts'

console.log('editor: default template')
{
  check('no template → just the file', buildEditorArgs(undefined, FILE), [FILE])
  check('empty template → just the file', buildEditorArgs('   ', FILE), [FILE])
}

console.log('editor: placeholders')
{
  check('{file}:{line}', buildEditorArgs('--goto {file}:{line}', FILE, 42),
    ['--goto', '/home/u/proj/src/main.ts:42'])
  check('-n{line} {file}', buildEditorArgs('-n{line} {file}', FILE, 7),
    ['-n7', '/home/u/proj/src/main.ts'])
  check('{line} defaults to 1', buildEditorArgs('--goto {file}:{line}', FILE),
    ['--goto', '/home/u/proj/src/main.ts:1'])
  check('{col} expands', buildEditorArgs('{file}:{line}:{col}', FILE, 3, 9),
    ['/home/u/proj/src/main.ts:3:9'])
}

console.log('editor: paths with spaces stay intact')
{
  const argv = buildEditorArgs('--goto {file}:{line}', SPACED, 10)
  check('spaced path is one argv element', argv, ['--goto', 'C:\\Program Files\\My App\\src\\主程序.ts:10'])
  check('exactly two elements', argv.length, 2)
}

console.log('editor: file always present')
{
  check('template without {file} still gets it', buildEditorArgs('--new-window', FILE),
    ['--new-window', FILE])
}

console.log('editor: presets')
{
  const ids = EDITOR_PRESETS.map((p) => p.id)
  check('presets include code/cursor/notepadpp/system',
    ['code', 'cursor', 'notepadpp', 'system'].every((i) => ids.includes(i)), true)
  const system = EDITOR_PRESETS.find((p) => p.id === 'system')
  check('system preset has empty command (uses OS default)', system.config.command, '')
  // Every non-system preset template must actually reference the file.
  const all = EDITOR_PRESETS.filter((p) => p.id !== 'system')
  check('all real presets produce the file in argv',
    all.every((p) => buildEditorArgs(p.config.args, FILE, 1).some((a) => a.includes(FILE))), true)
}

// The 设置 menu shows this string on a disabled item, so a wrong answer here
// is user-visible and cannot be corrected by clicking.
console.log('editor: describeEditorConfig')
{
  check('unset → system default', describeEditorConfig(undefined), '系统默认程序（未配置）')
  check('empty command → system default', describeEditorConfig({ command: '' }), '系统默认程序（未配置）')
  check('whitespace command → system default', describeEditorConfig({ command: '   ' }), '系统默认程序（未配置）')
  check('known preset → its label', describeEditorConfig({ command: 'code' }), 'VS Code')
  check('known preset → its label (cursor)', describeEditorConfig({ command: 'cursor' }), 'Cursor')
  // A custom pick has no friendlier name than the path itself.
  check('custom path → the raw command', describeEditorConfig({ command: 'D:\\apps\\my editor.exe' }), 'D:\\apps\\my editor.exe')
  // Matching must be on `command` only: a preset whose args were edited is
  // still that preset.
  check('preset with edited args still matches', describeEditorConfig({ command: 'code', args: '{file}' }), 'VS Code')
}

console.log(`\neditor: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
