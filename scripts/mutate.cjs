/**
 * Mutation helper — part of the "prove the test can actually fail" ritual.
 *
 * Usage:
 *   cp lib-new/<file> /tmp/orig.js             # ONCE, before the first mutation
 *   node scripts/mutate.cjs <file-under-lib-new> "<find>" "<replace>"
 *   npm test            # expect FAILURES
 *   cp /tmp/orig.js lib-new/<file>             # restore
 *
 * ⚠️ RESTORE BY COPYING FROM A BACKUP. NEVER `git checkout -- <file>`: that
 * restores from the INDEX, not the working tree, so uncommitted work is
 * silently destroyed with exit 0 (this cost a 240-line reconstruction on
 * 2026-09-02). If the backup is gone, `lib-new/*.js` is the compiled evidence
 * to reconstruct the source from — and `npx tsc` proves the reconstruction.
 *
 * ⚠️ Pass Windows-style paths (D:/…). node.exe cannot resolve Git Bash's
 * /d/… form, and the only symptom is "MUTATION PATTERN NOT FOUND" on every
 * case — which reads as "the tests caught nothing" when really nothing ran.
 *
 * It exits 2 when the find string is absent. That is the entire point: doing
 * this with `sed` silently matched nothing THREE times, because tsc puts a
 * statement body on the following line, so `sed 's|if (x) return y|...|'` finds
 * no match, changes nothing, and the suite stays green — which reads as "the
 * test does not catch this bug" when really the mutation never happened.
 *
 * ⚠️ MUTATE THE ARTIFACT THE TEST ACTUALLY READS. Most tests require lib-new/,
 * but a STATIC test reads src/*.ts — `test/panel-api.contract.cjs` brace-matches
 * the TypeScript source, so mutating lib-new/ there produces a green run that
 * reads as "the test catches nothing" when really nothing was tested.
 * Rule of thumb: runtime tests → lib-new/; static/source-reading tests → src/.
 *
 * ⚠️ GREP THE ANCHOR BEFORE TRUSTING A SWEEP. tsc puts a statement body on the
 * following line, so `if (x)` and `return y` are never adjacent. A whole sweep
 * reporting "pattern not found" is almost always the anchors, not the tests.
 *
 * Always restore by copying a backup (or `npx tsc` to rebuild lib-new/), never
 * by hand — see the warning above.
 */
const fs = require('node:fs')
const [file, find, repl] = process.argv.slice(2)
if (!file || find === undefined || repl === undefined) {
  console.error('usage: node scripts/mutate.cjs <file> "<find>" "<replace>"')
  process.exit(3)
}
const src = fs.readFileSync(file, 'utf8')
if (!src.includes(find)) {
  console.error('MUTATION PATTERN NOT FOUND in ' + file)
  process.exit(2)
}
fs.writeFileSync(file, src.replace(find, repl), 'utf8')
console.log('mutated: ' + file)
