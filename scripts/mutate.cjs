/**
 * Mutation helper — part of the "prove the test can actually fail" ritual.
 *
 * Usage:
 *   node scripts/mutate.cjs <file-under-lib-new> "<find>" "<replace>"
 *   npm test            # expect FAILURES
 *   git checkout -- <the src file> && npx tsc   # restore
 *
 * It exits 2 when the find string is absent. That is the entire point: doing
 * this with `sed` silently matched nothing THREE times, because tsc puts a
 * statement body on the following line, so `sed 's|if (x) return y|...|'` finds
 * no match, changes nothing, and the suite stays green — which reads as "the
 * test does not catch this bug" when really the mutation never happened.
 *
 * Always mutate the COMPILED output in lib-new/, never src/, and always restore
 * by rebuilding from src (npx tsc) rather than by hand.
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
