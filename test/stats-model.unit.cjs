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
  estimateCost,
  formatCostSummary,
  formatDuration,
  formatTokens,
  formatStatsSummary,
  formatStatusLine,
  parsePriceOverrides,
  pickPrice,
  BUILTIN_PRICES,
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
    contextPressure: { contextWindow: 1000, pressureTokens: 120, projectedTokens: 90 },
  })])
  assert.equal(o.contextUsed, 120)
  assert.equal(o.contextWindow, 1000)
  assert.equal(o.contextPercent, 12)
})

check('context falls back to projectedTokens when pressure is absent', () => {
  const o = aggregateOverview([overviewRow({
    contextPressure: { projectedTokens: 90 },
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

check('overview folds llmMs/steps over every session', () => {
  const o = aggregateOverview([
    overviewRow({ stats: { llmMs: 300_000, steps: 4, turns: 3 } }),
    overviewRow({ parentSessionId: 'p', stats: { llmMs: 60_000, steps: 2, turns: 1 } }),
  ])
  assert.equal(o.llmMs, 360_000)
  assert.equal(o.steps, 6)
})

check('active figures come from the newest MAIN session only', () => {
  const o = aggregateOverview([
    overviewRow({
      sessionId: 'old', updatedAt: 10, agentPreset: 'deepseek-chat',
      stats: { turns: 9 },
      usage: { uncachedInputTokens: 100, cacheReadTokens: 300, outputTokens: 40 },
    }),
    overviewRow({
      sessionId: 'new', updatedAt: 20, agentPreset: 'flash',
      stats: { turns: 2 },
      usage: { uncachedInputTokens: 10, cacheReadTokens: 30, outputTokens: 4 },
    }),
    overviewRow({
      // newest of all, but a subagent — never the "current session"
      sessionId: 'sub', parentSessionId: 'new', updatedAt: 99, agentPreset: 'ghost',
      stats: { turns: 77 },
      usage: { uncachedInputTokens: 999 },
    }),
  ])
  assert.equal(o.activeTurns, 2)
  assert.equal(o.activePreset, 'flash')
  assert.equal(o.activeTokens, 44)
  assert.equal(o.activeHitRate, 75) // 30 / (30+10)
})

check('active fields degrade independently when projections are missing', () => {
  const o = aggregateOverview([
    overviewRow({ sessionId: 'bare', updatedAt: 5, agentPreset: 'flash' }),
  ])
  assert.equal(o.activeTurns, null)
  assert.equal(o.activePreset, 'flash')
  assert.equal(o.activeTokens, 0)
  assert.equal(o.activeHitRate, null)
})

// ── formatStatusLine (the Reasonix-style bottom bar) ──

check('formatStatusLine returns empty when nothing has been seen', () => {
  assert.equal(formatStatusLine(null), '')
  assert.equal(formatStatusLine(undefined), '')
  assert.equal(formatStatusLine({
    active: null,
    agg: { tokens: 0, hitRate: null, cost: null },
    contextPercent: null,
    compactThreshold: 0.8,
  }), '')
  // An active session that has produced nothing observable is "nothing" too.
  assert.equal(formatStatusLine({
    active: { turns: 0, tokens: 0, hitRate: null, cost: null },
    agg: { tokens: 0, hitRate: null, cost: null },
    contextPercent: null,
    compactThreshold: 0.8,
  }), '')
})

check('formatStatusLine renders every segment in the reference order', () => {
  const line = formatStatusLine({
    active: { preset: 'deepseek-v4-flash + plan', turns: 3, tokens: 44_000, hitRate: 75, cost: 0.1234 },
    agg: { tokens: 657_000, hitRate: 94.2, cost: 3.9 },
    contextPercent: 1,
    compactThreshold: 0.8,
  })
  assert.equal(
    line,
    'deepseek-v4-flash + plan | 本次命中 75% | 平均命中 94.2% | 会话 tokens 657k | ' +
    '本次 tokens 44k | 本次费用 ¥0.123 | 当前会话 3 轮 | 上下文 1% | 压缩阈值 80% | 会话费用 ¥3.9',
  )
})

check('formatStatusLine shows dashes for missing values, never zeros', () => {
  const line = formatStatusLine({
    active: { preset: 'flash', turns: 1, tokens: 0, hitRate: null, cost: null },
    agg: { tokens: 0, hitRate: null, cost: null },
    contextPercent: null,
    compactThreshold: 0.8,
  })
  assert.equal(
    line,
    'flash | 本次命中 - | 平均命中 - | 会话 tokens - | 本次 tokens - | 本次费用 - | ' +
    '当前会话 1 轮 | 上下文 - | 压缩阈值 80% | 会话费用 -',
  )
})

check('formatStatusLine keeps the bar alive on context alone', () => {
  const line = formatStatusLine({
    active: null,
    agg: { tokens: 0, hitRate: null, cost: null },
    contextPercent: 42,
    compactThreshold: 0.8,
  })
  assert.ok(line.includes('上下文 42%'), line)
})

check('formatStatusLine renders the threshold from the fraction given', () => {
  const line = formatStatusLine({
    active: { preset: 'm', turns: 1, tokens: 1, hitRate: 1, cost: 0 },
    agg: { tokens: 1, hitRate: 1, cost: 0 },
    contextPercent: null,
    compactThreshold: 0.75,
  })
  assert.ok(line.includes('压缩阈值 75%'), line)
})

// ── cost estimation (price table × token buckets) ──

check('parsePriceOverrides keeps valid entries and drops junk', () => {
  const entries = parsePriceOverrides(JSON.stringify([
    { model: 'flash', cached: 0.1, uncached: 1, output: 2 },
    { model: '', cached: 1, uncached: 1, output: 1 },           // no name → drop
    { model: 'zeros' },                                          // no prices → drop
    { model: 'cw', cached: 0.1, uncached: 1, output: 2, cacheWrite: 0.5 },
    'junk', null, 42,                                            // non-objects → drop
  ]))
  assert.equal(entries.length, 2)
  assert.equal(entries[0].model, 'flash')
  assert.equal(entries[1].model, 'cw')
  assert.equal(entries[1].cacheWrite, 0.5)
  assert.equal(entries[0].cacheWrite, undefined)
})

check('parsePriceOverrides survives broken JSON and non-arrays', () => {
  assert.deepEqual(parsePriceOverrides('{broken'), [])
  assert.deepEqual(parsePriceOverrides('{"model":"x"}'), [])
})

check('pickPrice matches case-insensitively then falls back to *', () => {
  const entries = [
    { model: 'Flash', cached: 1, uncached: 2, output: 3 },
    { model: '*', cached: 9, uncached: 9, output: 9 },
  ]
  assert.equal(pickPrice(entries, 'flash')?.cached, 1)
  assert.equal(pickPrice(entries, 'unknown-preset')?.cached, 9)
  assert.equal(pickPrice(entries, undefined), null)
  assert.equal(pickPrice([{ model: 'a', cached: 1, uncached: 1, output: 1 }], 'b'), null)
})

check('estimateCost prices each bucket per million tokens', () => {
  // DeepSeek V3.2: cached ¥0.2, uncached ¥2, output ¥3 per Mtok.
  const price = BUILTIN_PRICES[0]
  const cost = estimateCost(
    { uncachedInput: 1_000_000, cacheRead: 2_000_000, output: 500_000, cacheWrite: 100_000 },
    price,
  )
  // 2 + 0.4 + 1.5 + 0 (cacheWrite unbilled) = 3.9
  assert.equal(cost, 3.9)
})

check('estimateCost bills cacheWrite only when the entry defines it', () => {
  const withCw = { model: 'x', cached: 0, uncached: 0, output: 0, cacheWrite: 1 }
  assert.equal(estimateCost({ cacheWrite: 1_000_000 }, withCw), 1)
  assert.equal(estimateCost({ cacheWrite: 1_000_000 }, BUILTIN_PRICES[0]), 0)
})

check('formatCostSummary renders hit rate, estimate and unmatched', () => {
  assert.equal(formatCostSummary(null), '')
  assert.equal(formatCostSummary({ hitRate: null, cost: null, matched: null, unmatched: 0 }), '')
  assert.equal(formatCostSummary({ hitRate: 94.2, cost: 1.234, matched: 'flash', unmatched: 0 }), '命中率 94.2% · 估算 ¥1.23')
  assert.equal(formatCostSummary({ hitRate: 94, cost: 3.9, matched: 'flash', unmatched: 2 }), '命中率 94% · 估算 ¥3.9 · 未匹配 2')
  assert.equal(formatCostSummary({ hitRate: null, cost: 123.456, matched: '*', unmatched: 0 }), '估算 ¥123')
})

console.log(`stats-model.unit: ${checks} checks passed`)
