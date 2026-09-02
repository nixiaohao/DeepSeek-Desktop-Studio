/**
 * Unit tests for src/approval-groups.ts.
 *
 * The grouping rules look trivial and are not: they decide the order of the
 * buttons a user clicks to grant permission. A group that reorders itself
 * between two renders means a click lands on a different tool than the one the
 * user read — which is why every ordering case below pins the exact sequence
 * rather than asserting set equality.
 *
 * Run with: npm test
 */
const assert = require('node:assert')
const path = require('node:path')

const {
  groupApprovals,
  commonTool,
  normalizeIds,
  UNKNOWN_TOOL,
} = require(path.join(__dirname, '..', 'lib-new', 'approval-groups.js'))

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass += 1
  } catch (error) {
    fail += 1
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}

const a = (id, toolName, ts) => ({ approvalId: id, toolName, ts })

console.log('approval-groups: grouping')

check('empty input yields no groups', () => {
  assert.deepStrictEqual(groupApprovals([]), [])
})

check('groups by tool name', () => {
  const groups = groupApprovals([a('1', 'edit', 10), a('2', 'bash', 20), a('3', 'edit', 30)])
  assert.strictEqual(groups.length, 2)
  assert.deepStrictEqual(groups.map((g) => g.toolName), ['edit', 'bash'])
  assert.deepStrictEqual(groups[0].approvalIds, ['1', '3'])
  assert.deepStrictEqual(groups[1].approvalIds, ['2'])
})

check('the group waiting longest comes first', () => {
  const groups = groupApprovals([a('1', 'bash', 999), a('2', 'edit', 100)])
  assert.deepStrictEqual(groups.map((g) => g.toolName), ['edit', 'bash'])
})

check('within a group, the oldest approval is answered first', () => {
  const groups = groupApprovals([a('3', 'edit', 300), a('1', 'edit', 100), a('2', 'edit', 200)])
  assert.deepStrictEqual(groups[0].approvalIds, ['1', '2', '3'])
})

check('identical timestamps keep input order (no button reshuffle)', () => {
  // Not hypothetical: an agent queueing several edits lands them in the same
  // millisecond, and an unstable sort would then reorder the buttons between
  // two renders of the same pending set.
  const groups = groupApprovals([a('c', 'edit', 1), a('a', 'edit', 1), a('b', 'edit', 1)])
  assert.deepStrictEqual(groups[0].approvalIds, ['c', 'a', 'b'])
})

check('a group is ordered by its OLDEST member, not its newest', () => {
  // `edit` has both a stale request (100) and a fresh one (900); `bash` has one
  // in between (300). Ordering groups by newest would put bash first and leave
  // the long-waiting edit stuck behind a request that arrived a moment ago.
  const groups = groupApprovals([a('1', 'edit', 900), a('2', 'edit', 100), a('3', 'bash', 300)])
  assert.strictEqual(groups[0].toolName, 'edit')
  assert.strictEqual(groups[0].ts, 100, 'placed by its oldest member')
  assert.strictEqual(groups[1].toolName, 'bash')
})

check('a missing tool name falls back to a label, not to undefined', () => {
  const groups = groupApprovals([{ approvalId: '1', ts: 1 }])
  assert.strictEqual(groups[0].toolName, UNKNOWN_TOOL)
})

check('a blank tool name falls back too', () => {
  assert.strictEqual(groupApprovals([a('1', '   ', 1)])[0].toolName, UNKNOWN_TOOL)
})

check('an approval with no id is dropped — it can never be answered', () => {
  assert.deepStrictEqual(groupApprovals([{ toolName: 'edit', ts: 1 }]), [])
})

check('a missing ts sorts last instead of jumping to the front', () => {
  const groups = groupApprovals([a('new', 'edit'), a('old', 'edit', 5)])
  assert.deepStrictEqual(groups[0].approvalIds, ['old', 'new'])
})

console.log('approval-groups: the single-tool allow invariant')

check('one tool → that tool', () => {
  const list = [a('1', 'edit', 1), a('2', 'edit', 2)]
  assert.strictEqual(commonTool(list, ['1', '2']), 'edit')
})

check('mixed tools → null, so the batch is refused', () => {
  const list = [a('1', 'edit', 1), a('2', 'bash', 2)]
  assert.strictEqual(commonTool(list, ['1', '2']), null)
})

check('an id that is no longer pending → null', () => {
  // Deliberately null rather than an error: the agent resolved it on its own,
  // and reporting that as a failure would blame the user for nothing.
  assert.strictEqual(commonTool([a('1', 'edit', 1)], ['1', 'gone']), null)
})

check('empty id list → null', () => {
  assert.strictEqual(commonTool([a('1', 'edit', 1)], []), null)
})

check('a nameless tool still counts as one tool', () => {
  assert.strictEqual(commonTool([{ approvalId: '1' }, { approvalId: '2' }], ['1', '2']), UNKNOWN_TOOL)
})

check('a group produced by groupApprovals always passes commonTool', () => {
  // The two functions are the two halves of one rule; if they ever disagree the
  // UI would offer a button the IPC layer then refuses.
  const list = [a('1', 'edit', 1), a('2', 'bash', 2), a('3', 'edit', 3)]
  for (const group of groupApprovals(list)) {
    assert.strictEqual(commonTool(list, group.approvalIds), group.toolName)
  }
})

console.log('approval-groups: id normalisation')

check('de-duplicates', () => {
  assert.deepStrictEqual(normalizeIds(['a', 'a', 'b']), ['a', 'b'])
})

check('drops non-strings and blanks', () => {
  assert.deepStrictEqual(normalizeIds(['a', 1, null, '', '  ', {}, 'b']), ['a', 'b'])
})

check('trims', () => {
  assert.deepStrictEqual(normalizeIds(['  a  ']), ['a'])
})

check('a non-array is not an error, it is an empty batch', () => {
  assert.deepStrictEqual(normalizeIds(null), [])
  assert.deepStrictEqual(normalizeIds('a'), [])
  assert.deepStrictEqual(normalizeIds({ 0: 'a' }), [])
})

check('an empty batch is never allowed, even with no ids to check', () => {
  // Guards the IPC path: `commonTool([], [])` is null, so respond-many must
  // refuse before it reaches the fan-out rather than reporting a silent success.
  assert.strictEqual(commonTool([], normalizeIds([])), null)
})

console.log(`\napproval-groups: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
