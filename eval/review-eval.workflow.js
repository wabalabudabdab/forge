export const meta = {
  name: 'forge-review-eval',
  description: 'Review-independence experiment: four review arms over a mutant corpus, matched call count',
  phases: [
    { title: 'single-2pass', detail: 'one reviewer, second pass sees its own first verdict' },
    { title: 'same-mandate', detail: 'two generic reviewers in fresh contexts' },
    { title: 'forge', detail: 'reviewer-logical + reviewer-deep' },
  ],
}

// args (built by eval/make-args.mjs — the script has no filesystem access):
//   items   — [{ id, kind: 'clean'|'buggy', operator, message, diff }]
//   prompts — { generic, rereview, logical, deep } with {{TASK}} {{DIFF}} {{PREV_APPROVED}} {{PREV_ISSUES}}
//   reps    — repetitions per item per arm (model nondeterminism), default 3
//   arms    — subset of ['none', 'single-2pass', 'same-mandate', 'forge'], default all
// Returns { records, tokensByArm }. Reviewers see only the commit message and the diff:
// never tests, test output, kind or operator.

const A = args || {}
const ITEMS = A.items || []
const P = A.prompts || {}
const REPS = A.reps || 3
const ARMS = A.arms || ['none', 'single-2pass', 'same-mandate', 'forge']
if (!ITEMS.length) throw new Error('args.items is empty')
for (const k of ['generic', 'rereview', 'logical', 'deep']) if (!P[k]) throw new Error(`args.prompts.${k} missing`)

const REVIEW = {
  type: 'object',
  required: ['approved', 'issues'],
  properties: { approved: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
}

const fill = (tpl, item, prev) =>
  tpl
    .replaceAll('{{TASK}}', item.message)
    .replaceAll('{{DIFF}}', item.diff)
    .replaceAll('{{PREV_APPROVED}}', prev ? String(prev.approved) : '')
    .replaceAll('{{PREV_ISSUES}}', prev ? (prev.issues.join('; ') || 'none') : '')

// labels use a neutral unit number: item ids end in -clean/-buggy and must not reach a reviewer
const units = ITEMS.flatMap((item) => Array.from({ length: REPS }, (_, rep) => ({ item, rep }))).map((u, n) => ({ ...u, n }))
const rejected = (rs) => rs.some((r) => !r || !r.approved) // a missing review counts as a rejection, and is flagged
const records = []
const tokensByArm = {}

const RUN = {
  'single-2pass': async ({ item, n }, phase) => {
    const first = await agent(fill(P.generic, item), { schema: REVIEW, phase, label: `${phase}:u${n}:1` })
    const second = await agent(fill(P.rereview, item, first || { approved: true, issues: [] }), { schema: REVIEW, phase, label: `${phase}:u${n}:2` })
    return [first, second]
  },
  'same-mandate': ({ item, n }, phase) =>
    parallel([1, 2].map((k) => () => agent(fill(P.generic, item), { schema: REVIEW, phase, label: `${phase}:u${n}:${k}` }))),
  forge: ({ item, n }, phase) =>
    parallel([
      () => agent(fill(P.logical, item), { schema: REVIEW, phase, agentType: 'reviewer-logical', label: `${phase}:u${n}:logical` }),
      () => agent(fill(P.deep, item), { schema: REVIEW, phase, agentType: 'reviewer-deep', label: `${phase}:u${n}:deep` }),
    ]),
}

for (const arm of ARMS) {
  if (arm === 'none') {
    for (const { item, rep } of units) records.push({ arm, item: item.id, kind: item.kind, operator: item.operator, rep, rejected: false, tokens: 0, missing: 0 })
    tokensByArm.none = 0
    continue
  }
  if (!RUN[arm]) throw new Error(`unknown arm ${arm}`)
  phase(arm)
  const before = budget.spent()
  const results = await pipeline(units, (u) => RUN[arm](u, arm))
  const spent = budget.spent() - before
  tokensByArm[arm] = spent
  const perUnit = Math.round(spent / units.length)
  results.forEach((rs, i) => {
    const { item, rep } = units[i]
    const reviews = rs || [null, null]
    records.push({
      arm, item: item.id, kind: item.kind, operator: item.operator, rep,
      rejected: rejected(reviews), tokens: perUnit, missing: reviews.filter((r) => !r).length,
      issues: reviews.filter(Boolean).flatMap((r) => r.issues),
    })
  })
  const miss = records.filter((r) => r.arm === arm && r.missing).length
  log(`${arm}: ${units.length} judgements, ${Math.round(spent / 1000)}k output tokens${miss ? `, ${miss} with a missing review (counted as rejection)` : ''}`)
}

return { records, tokensByArm }
