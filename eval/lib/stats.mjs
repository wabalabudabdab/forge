// Rates with Wilson 95% intervals. Wilson rather than the normal approximation because the
// samples are small and rates near 0 or 1 are expected (e.g. the "none" arm).

const Z = 1.959964

export function wilson(k, n) {
  if (n === 0) return { p: null, lo: null, hi: null, k, n }
  const p = k / n
  const z2 = Z * Z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { p, lo: Math.max(0, center - margin), hi: Math.min(1, center + margin), k, n }
}

const rate = (rows) => wilson(rows.filter((r) => r.rejected).length, rows.length)

// rows: { arm, item, kind: 'clean' | 'buggy', operator, rep, rejected, tokens }
export function summarize(rows) {
  const out = {}
  for (const arm of [...new Set(rows.map((r) => r.arm))]) {
    const mine = rows.filter((r) => r.arm === arm)
    const buggy = mine.filter((r) => r.kind === 'buggy')
    const byOperator = {}
    for (const op of [...new Set(buggy.map((r) => r.operator))]) byOperator[op] = rate(buggy.filter((r) => r.operator === op))
    out[arm] = {
      detection: rate(buggy),
      falseRejection: rate(mine.filter((r) => r.kind === 'clean')),
      meanTokens: mine.length ? mine.reduce((a, r) => a + (r.tokens || 0), 0) / mine.length : null,
      byOperator,
    }
  }
  return out
}
