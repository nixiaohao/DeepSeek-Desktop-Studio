/**
 * settings-model.unit.cjs — validation and change detection for the settings window.
 *
 * The interesting property under test is NOT "does it return the right string"
 * but "does it stay quiet when it should". checkEditorTemplate() produces
 * warnings for configurations that WORK — `buildEditorArgs()` handles both
 * cases it flags — so a false positive here is worse than a false negative: it
 * would nag the user about a setup that opens files correctly.
 *
 * changedFields() carries the opposite risk. It decides whether the app asks
 * for a restart, which is the most disruptive thing a settings window can
 * request, so an object-identity comparison there would produce a spurious
 * restart prompt on every edit.
 */
const assert = require('node:assert')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib-new')
const {
  checkEditorTemplate,
  normalizeTextField,
  changedFields,
  needsRestart,
  RESTART_REQUIRED_FIELDS,
} = require(path.join(LIB, 'settings-model.js'))

let assertions = 0
function check(label, fn) {
  try {
    fn()
    assertions += 1
  } catch (err) {
    console.error(`FAIL  ${label}\n      ${err.message}`)
    process.exitCode = 1
  }
}

/** A state with every field at a known value. */
function state(over) {
  const base = {
    themeId: 'default',
    uiScale: 1,
    sidebarVisible: true,
    panelVisible: true,
    statusVisible: true,
    editor: { command: 'code', args: '--goto {file}:{line}' },
    channel: 'next',
  }
  return { ...base, ...(over || {}) }
}

console.log('settings-model: editor template checks')

check('no editor configured → OS default, template is irrelevant', () => {
  // shell.openPath() is used and args are ignored entirely, so warning about a
  // nonsense template would be noise.
  const r = checkEditorTemplate('--goto {file}:{line}', '')
  assert.strictEqual(r.level, 'ok')
  assert.match(r.message, /系统默认程序/)
})

check('whitespace-only command counts as unset', () => {
  assert.strictEqual(checkEditorTemplate('', '   ').level, 'ok')
})

check('empty template is fine (it means {file})', () => {
  const r = checkEditorTemplate('   ', 'code')
  assert.strictEqual(r.level, 'ok')
  assert.match(r.message, /\{file\}/)
})

check('VS Code / Cursor form {file}:{line} is accepted', () => {
  // MUST be a substring match: the path is embedded inside a larger token, so
  // an exact-token check would reject the single most common real template.
  assert.strictEqual(checkEditorTemplate('--goto {file}:{line}', 'code').level, 'ok')
})

check('all three placeholders together are accepted', () => {
  assert.strictEqual(checkEditorTemplate('{file} {line} {col}', 'code').level, 'ok')
})

check('missing {file} warns — the path is appended at the end instead', () => {
  // `-n{line}` still opens the file (buildEditorArgs appends it) but the line
  // number is not attached to it, which is not what the template says.
  const r = checkEditorTemplate('-n{line}', 'notepad++')
  assert.strictEqual(r.level, 'warn')
  assert.match(r.message, /\{file\}/)
})

check('a template of only other placeholders warns', () => {
  assert.strictEqual(checkEditorTemplate('-a -b', 'code').level, 'warn')
})

check('unknown placeholder warns and names it', () => {
  const r = checkEditorTemplate('{file} {bogus}', 'code')
  assert.strictEqual(r.level, 'warn')
  assert.match(r.message, /\{bogus\}/)
})

check('several unknown placeholders are all reported', () => {
  const r = checkEditorTemplate('{aaa} {bbb}', 'code')
  assert.strictEqual(r.level, 'warn')
  assert.match(r.message, /\{aaa\}/)
  assert.match(r.message, /\{bbb\}/)
})

check('a typo is reported even when {file} is present and valid', () => {
  // The typo check runs FIRST: an unknown placeholder is invisible to the user
  // and is the more likely mistake, so it must not be masked by the file check.
  assert.strictEqual(checkEditorTemplate('--goto {file}:{ln}', 'code').level, 'warn')
})

check('non-string inputs do not throw', () => {
  // The page owns these fields; a null reaching here must not take the window
  // down, because the window is where the user fixes a bad configuration.
  assert.strictEqual(checkEditorTemplate(null, 'code').level, 'ok')
  assert.strictEqual(checkEditorTemplate(undefined, 'code').level, 'ok')
  assert.strictEqual(checkEditorTemplate('{file}', null).level, 'ok')
  assert.strictEqual(checkEditorTemplate(42, 42).level, 'ok')
})

console.log('settings-model: text field normalisation')

check('trims surrounding whitespace', () => {
  assert.strictEqual(normalizeTextField('  code  '), 'code')
})

check('non-strings collapse to the empty string', () => {
  assert.strictEqual(normalizeTextField(null), '')
  assert.strictEqual(normalizeTextField(undefined), '')
  assert.strictEqual(normalizeTextField(7), '')
  assert.strictEqual(normalizeTextField({}), '')
})

check('caps runaway input that would end up in spawn() and in the prefs file', () => {
  assert.strictEqual(normalizeTextField('x'.repeat(5000)).length, 512)
  assert.strictEqual(normalizeTextField('x'.repeat(5000), 32).length, 32)
})

check('inner whitespace is preserved (paths contain spaces)', () => {
  assert.strictEqual(normalizeTextField('  C:\\Program Files\\Code.exe  '), 'C:\\Program Files\\Code.exe')
})

console.log('settings-model: change detection')

check('an untouched state reports no changes', () => {
  assert.deepStrictEqual(changedFields(state(), state()), [])
})

check('a rebuilt-but-equal editor object is NOT a change', () => {
  // The page rebuilds `editor` on every keystroke. Comparing object identity
  // would report a change on every edit, and since the channel is the field
  // that forces a restart, that turns into a spurious restart prompt.
  const before = state()
  const after = state({ editor: { command: before.editor.command, args: before.editor.args } })
  assert.notStrictEqual(before.editor, after.editor)
  assert.deepStrictEqual(changedFields(before, after), [])
})

check('a scalar change is reported', () => {
  assert.deepStrictEqual(changedFields(state(), state({ uiScale: 1.3 })), ['uiScale'])
})

check('editor command change is reported as the editor field', () => {
  const after = state({ editor: { command: 'cursor', args: '--goto {file}:{line}' } })
  assert.deepStrictEqual(changedFields(state(), after), ['editor'])
})

check('editor args change is reported as the editor field', () => {
  const after = state({ editor: { command: 'code', args: '{file}' } })
  assert.deepStrictEqual(changedFields(state(), after), ['editor'])
})

check('several changes are all reported', () => {
  const after = state({ themeId: 'x', channel: 'stable', sidebarVisible: false })
  const out = changedFields(state(), after)
  for (const f of ['themeId', 'sidebarVisible', 'channel']) {
    assert.ok(out.includes(f), `missing ${f} in ${JSON.stringify(out)}`)
  }
  assert.strictEqual(out.length, 3)
})

check('a field changed and reverted is not reported', () => {
  assert.deepStrictEqual(changedFields(state(), state({ uiScale: 1 })), [])
})

console.log('settings-model: restart policy')

check('only a channel change requires a restart', () => {
  assert.deepStrictEqual(RESTART_REQUIRED_FIELDS, ['channel'])
})

check('channel change → restart', () => {
  assert.strictEqual(needsRestart(['channel']), true)
})

check('cosmetic changes → no restart', () => {
  // Theme, font scale and visibility are all applied live; asking for a
  // restart for these would be asking for the one thing that is not needed.
  assert.strictEqual(needsRestart(['themeId', 'uiScale', 'sidebarVisible']), false)
})

check('no changes → no restart', () => {
  assert.strictEqual(needsRestart([]), false)
})

check('a restart-required field among harmless ones still needs one', () => {
  assert.strictEqual(needsRestart(['editor', 'channel']), true)
})

console.log(`\nsettings-model: ${assertions} assertions passed`)
