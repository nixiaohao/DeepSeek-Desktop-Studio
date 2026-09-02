/**
 * stats-model.unit.cjs — the status bar's stats fold.
 *
 * Everything here runs in plain node: stats-model.ts is zero-dependency by
 * contract (pinned in modules.smoke.cjs), so these tests would fail to even
 * import it if that regressed.
 */
'use strict'

const assert = require('node:assert/strict')
const {
  aggregateStats,
  aggregateOverview,
  formatDuration,
  formatTokens,
  formatStatsSummary,
} = require('../lib-new/stats-model.js')

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
}

check('empty input aggregates to all zeros', () => {
  assert.deepStrictEqual(aggregateStats([]), {
    llmMs: 0, toolMs: 0, steps: 0, tokensIn: 0, tokensOut: 0,
    agentsTotal: 0, agentsRunning: 0, agentsSub: 0,
  })
})

check('main + subagent figures are summed across sessions', () => {
  const s = aggregateStats([
    {
      sessionId: 'main', running: true,
      stats: { steps: 4, llmMs: 392_000, toolMs: 12_000 },
      usage: { uncachedInputTokens: 600_000, cacheReadTokens: 50_000, cacheWriteTokens: 6_000, outputTokens: 42_200 },
    },
    {
      sessionId: 'sub1', parentSessionId: 'main', running: true,
      stats: { steps: 2, llmMs: 60_000, toolMs: 3_000 },
      usage: { uncachedInputTokens: 1_000, outputTokens: 800 },
    },
  ])
  assert.equal(s.llmMs, 452_000)
  assert.equal(s.toolMs, 15_000)
  assert.equal(s.steps, 6)
  assert.equal(s.tokensIn, 657_000)
  assert.equal(s.tokensOut, 43_000)
  assert.equal(s.agentsTotal, 2)
  assert.equal(s.agentsRunning, 2)
  assert.equal(s.agentsSub, 1)
})

check('a session without projections still counts as an agent', () => {
  const s = aggregateStats([{ sessionId: 'cold', running: false }])
  assert.equal(s.agentsTotal, 1)
  assert.equal(s.agentsRunning, 0)
  assert.equal(s.agentsSub, 0)
  assert.equal(s.llmMs, 0)
})

check('non-finite / negative / wrong-typed fields contribute zero', () => {
  const s = aggregateStats([
    {
      sessionId: 'x', running: 'yes',
      stats: { llmMs: Number.NaN, toolMs: -5, steps: 'many' },
      usage: { uncachedInputTokens: Number.POSITIVE_INFINITY, outputTokens: null },
    },
    null,
    'garbage',
  ])
  assert.equal(s.agentsTotal, 1)
  assert.equal(s.llmMs, 0)
  assert.equal(s.toolMs, 0)
  assert.equal(s.steps, 0)
  assert.equal(s.tokensIn, 0)
  assert.equal(s.tokensOut, 0)
})

check('formatDuration covers the s/m/h ranges', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(-1), '0s')
  assert.equal(formatDuration(Number.NaN), '0s')
  assert.equal(formatDuration(12_400), '12s')
  assert.equal(formatDuration(392_000), '6m32s')
  assert.equal(formatDuration(7_380_000), '2h03m')
})

check('formatTokens uses the compact k/M scale', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(830), '830')
  assert.equal(formatTokens(42_200), '42.2k')
  assert.equal(formatTokens(656_000), '656k')
  assert.equal(formatTokens(1_200_000), '1.2M')
})

check('formatStatsSummary renders the readable line in a fixed order', () => {
  assert.equal(formatStatsSummary(null), '')
  assert.equal(formatStatsSummary({}), '')
  const line = formatStatsSummary({
    llmMs: 392_000, toolMs: 12_000, steps: 4,
    tokensIn: 656_000, tokensOut: 42_200,
    agentsTotal: 4, agentsRunning: 1, agentsSub: 3,
  })
  assert.equal(line, 'LLM 6m32s · 工具 12s · ↑656k ↓42.2k tok · 子agent 3 · 运行中 1')
})

check('formatStatsSummary drops quiet groups instead of showing zeros', () => {
  assert.equal(formatStatsSummary({ llmMs: 0, toolMs: 0, steps: 0, tokensIn: 0, tokensOut: 0, agentsTotal: 3, agentsRunning: 0, agentsSub: 0 }), '')
})

// ── aggregateOverview (panel 会话概览 tab) ──

const overviewRow = (over) => over

check('empty overview input yields zeros and null ratios', () => {
  const o = aggregateOverview([])
  assert.equal(o.contextUsed, 0)
  assert.equal(o.contextWindow, null)
  assert.equal(o.contextPercent, null)
  assert.equal(o.hitRate, null)
  assert.deepEqual(o.tokens, { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(o.breakdown, null)
})

check('hit rate derives from cacheRead over total input', () => {
  const o = aggregateOverview([overviewRow({
    usage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 20 },
  })])
  assert.equal(o.hitRate, 75) // 300 / (300+100)
  assert.deepEqual(o.tokens, { uncachedInput: 100, output: 50, cacheRead: 300, cacheWrite: 20 })
})

check('no input at all leaves hitRate null instead of NaN', () => {
  const o = aggregateOverview([overviewRow({ usage: { outputTokens: 5 } })])
  assert.equal(o.hitRate, null)
})

check('context occupancy prefers pressureTokens and reports percent of window', () => {
  const o = aggregateOverview([overviewRow({
    contextPressure: { contextWindow: 1000, pressureTokens: 120, surfaceTokens: 90 },
  })])
  assert.equal(o.contextUsed, 120)
  assert.equal(o.contextWindow, 1000)
  assert.equal(o.contextPercent, 12)
})

check('context falls back to surfaceTokens when pressure is absent', () => {
  const o = aggregateOverview([overviewRow({
    contextPressure: { surfaceTokens: 90 },
  })])
  assert.equal(o.contextUsed, 90)
  assert.equal(o.contextWindow, null)
  assert.equal(o.contextPercent, null)
})

check('across sessions tokens sum and the smallest window binds', () => {
  const o = aggregateOverview([
    overviewRow({ usage: { uncachedInputTokens: 10, cacheReadTokens: 90 }, contextPressure: { contextWindow: 2000, pressureTokens: 500 } }),
    overviewRow({ usage: { uncachedInputTokens: 30, outputTokens: 7, cacheReadTokens: 10 }, contextPressure: { contextWindow: 1000, pressureTokens: 800 } }),
  ])
  assert.deepEqual(o.tokens, { uncachedInput: 40, output: 7, cacheRead: 100, cacheWrite: 0 })
  assert.equal(o.contextWindow, 1000)
  assert.equal(o.contextUsed, 800)
  assert.equal(o.contextPercent, 80)
})

check('breakdown sums composition; junk fields contribute zero', () => {
  const o = aggregateOverview([
    overviewRow({ contextBreakdown: { systemTokens: 500, toolsTokens: 1200, messageTokens: 3000 } }),
    overviewRow({ contextBreakdown: { systemTokens: 'x', toolsTokens: null, messageTokens: 200 } }),
    overviewRow(null),
    overviewRow({ usage: { uncachedInputTokens: NaN } }),
  ])
  assert.deepEqual(o.breakdown, { system: 500, tools: 1200, messages: 3200 })
  assert.equal(o.tokens.uncachedInput, 0)
})

console.log(`stats-model.unit: ${checks} checks passed`)
