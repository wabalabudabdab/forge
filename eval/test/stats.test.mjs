import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wilson, summarize } from '../lib/stats.mjs'

const r2 = (x) => Math.round(x * 100) / 100

test('wilson interval for 7 of 10', () => {
  const w = wilson(7, 10)
  assert.deepEqual([r2(w.p), r2(w.lo), r2(w.hi)], [0.7, 0.4, 0.89])
})

test('wilson handles 0 and n', () => {
  assert.equal(wilson(0, 10).lo, 0)
  assert.equal(r2(wilson(10, 10).hi), 1)
  assert.deepEqual(wilson(0, 0), { p: null, lo: null, hi: null, k: 0, n: 0 })
})

const rec = (arm, kind, rejected, operator = null, tokens = 100) => ({ arm, item: 'x', kind, operator, rep: 0, rejected, tokens })

test('summarize computes detection, false rejection and tokens per arm', () => {
  const rows = [
    ...Array.from({ length: 7 }, () => rec('forge', 'buggy', true, 'boundary-shift')),
    ...Array.from({ length: 3 }, () => rec('forge', 'buggy', false, 'logical-swap')),
    rec('forge', 'clean', true, null, 300),
    ...Array.from({ length: 9 }, () => rec('forge', 'clean', false, null, 300)),
  ]
  const s = summarize(rows).forge
  assert.equal(r2(s.detection.p), 0.7)
  assert.equal(s.detection.n, 10)
  assert.equal(r2(s.falseRejection.p), 0.1)
  assert.equal(s.meanTokens, 200)
  assert.equal(s.byOperator['boundary-shift'].p, 1)
  assert.equal(s.byOperator['logical-swap'].p, 0)
})

test('arms are kept separate', () => {
  const s = summarize([rec('none', 'buggy', false), rec('forge', 'buggy', true)])
  assert.equal(s.none.detection.p, 0)
  assert.equal(s.forge.detection.p, 1)
})
