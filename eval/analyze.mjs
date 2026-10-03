#!/usr/bin/env node
// Usage: node eval/analyze.mjs eval/results/<run>.jsonl  → markdown tables on stdout
import { readFileSync } from 'node:fs'
import { summarize } from './lib/stats.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node eval/analyze.mjs <results.jsonl>')
  process.exit(1)
}
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const s = summarize(rows)
const pct = (r) => (r.p === null ? '—' : `${(r.p * 100).toFixed(0)}% [${(r.lo * 100).toFixed(0)}–${(r.hi * 100).toFixed(0)}] (${r.k}/${r.n})`)

console.log('| arm | detection of injected regressions | false rejection of clean diffs | mean tokens / item |')
console.log('|---|---|---|---|')
for (const [arm, v] of Object.entries(s)) console.log(`| ${arm} | ${pct(v.detection)} | ${pct(v.falseRejection)} | ${v.meanTokens === null ? '—' : Math.round(v.meanTokens)} |`)

const ops = [...new Set(Object.values(s).flatMap((v) => Object.keys(v.byOperator)))].sort()
console.log('\n| arm | ' + ops.join(' | ') + ' |')
console.log('|---|' + ops.map(() => '---').join('|') + '|')
for (const [arm, v] of Object.entries(s)) console.log(`| ${arm} | ` + ops.map((o) => (v.byOperator[o] ? pct(v.byOperator[o]) : '—')).join(' | ') + ' |')
console.log('\nIntervals are Wilson 95%. Overlapping intervals mean the difference is not established at this sample size.')
