// forge-discover — reconnaissance pass for forge. Never touches code (L1, report-only).
// Collects logic and code defects from four sources, tries to refute every finding with an
// independent agent, and writes the confirmed ones as cards into STATE.md for a human to triage.
//
// Sources:
//   MECH      — lint / typecheck / tests (mechanical, no judgement) + baseline for forge
//   IR        — docs/druid/ir.json: resource <-> route/schema/validators in the code
//   BEHAVIOR  — docs/druid/behavior/*.md: contracts <-> code (not implemented != defect, goes in a separate list)
//   DEEP      — src modules: logic errors without a spec (guards, comparisons, branches, types)
//
// Run: Workflow({ scriptPath: ".../discover.workflow.js", args: { ...cfg } })
// args (all optional):
//   projectPath  — backend git repo (also holds .agent-loop/)
//   extraPaths   — other codebases to search for behavior implementations (e.g. frontend-app)
//   stateFile    — STATE.md to write the cards into
//   druidDir     — directory holding ir.json and behavior/
//   gates        — { lint, test } shell commands
//   maxTokens    — token ceiling for the run; phases past the ceiling are skipped and logged
//   runAt        — date string for the header (the script has no access to Date)

export const meta = {
  name: 'forge-discover',
  description: 'Recon: lint/tests, code vs DRUID IR and behavior, deep module review, refutation, cards in STATE.md',
  phases: [
    { title: 'SCOUT', detail: 'list IR resources, behavior files, modules' },
    { title: 'MECH', detail: 'lint / typecheck / tests → baseline' },
    { title: 'IR', detail: 'IR resource vs code' },
    { title: 'BEHAVIOR', detail: 'contract vs code' },
    { title: 'DEEP', detail: 'module logic' },
    { title: 'VERIFY', detail: 'refute every finding' },
    { title: 'WRITE', detail: 'cards in STATE.md' },
  ],
}

const cfg = {
  projectPath: '/path/to/your-project',
  extraPaths: ['/path/to/your-frontend'],
  stateFile: '/path/to/your-project/STATE.md',
  druidDir: '/path/to/your-project/docs/druid',
  gates: { lint: 'bun run lint', test: 'bun run test' },
  maxTokens: 3_000_000,
  runAt: '',
  ...(args || {}),
}
const P = cfg.projectPath
const D = cfg.druidDir
const CODEBASES = [P, ...cfg.extraPaths].join(', ')

const FINDING = {
  type: 'object',
  required: ['title', 'file', 'line', 'code', 'analysis', 'cause', 'spec_ref', 'fix_options', 'done_criterion', 'severity'],
  properties: {
    title: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    code: { type: 'string' },
    analysis: { type: 'string' },
    cause: { type: 'string' },
    spec_ref: { type: 'string' },
    fix_options: { type: 'array', items: { type: 'string' } },
    done_criterion: { type: 'string' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}
const FINDINGS = {
  type: 'object',
  required: ['findings', 'not_implemented'],
  properties: {
    findings: { type: 'array', items: FINDING },
    not_implemented: { type: 'array', items: { type: 'string' } },
  },
}
const SCOUT = {
  type: 'object',
  required: ['ir_resources', 'behavior_files', 'modules'],
  properties: {
    ir_resources: { type: 'array', items: { type: 'string' } },
    behavior_files: { type: 'array', items: { type: 'string' } },
    modules: { type: 'array', items: { type: 'string' } },
  },
}
const MECH = {
  type: 'object',
  required: ['lint_errors', 'tests_passed', 'tests_failed', 'tests_runnable', 'findings'],
  properties: {
    lint_errors: { type: 'integer' },
    tests_passed: { type: 'integer' },
    tests_failed: { type: 'integer' },
    tests_runnable: { type: 'boolean' },
    findings: { type: 'array', items: FINDING },
  },
}
const VERDICT = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

const RULES = `Rules for findings: report only what the code itself proves (file:line and a code excerpt are mandatory).
"Not implemented" is NOT a finding — it is an entry in not_implemented ("<spec> § <contract>: no code"). Style, naming and formatting are not findings.
Every finding needs: title (one line), file (path from the repo root), line, code (a 3-15 line excerpt), analysis (what the code does and what the spec or logic requires),
cause (the root cause), spec_ref (spec file and section, or "no spec" for DEEP), fix_options (2-3 concrete options), done_criterion (verifiable: a test, a command, an observable behavior), severity.`

const tokensAtStart = budget.spent()
const spentK = () => Math.round((budget.spent() - tokensAtStart) / 1000)
const tokensLeft = () => cfg.maxTokens - (budget.spent() - tokensAtStart)
const skipped = []
const canRun = (name, need) => {
  if (tokensLeft() > need && !(budget.total && budget.remaining() < need)) return true
  skipped.push(name)
  log(`⛔ ${name} skipped: token ceiling reached (${spentK()}k of ${Math.round(cfg.maxTokens / 1000)}k)`)
  return false
}
const tag = (kind, list) => (list || []).filter(Boolean).map((f) => ({ ...f, kind }))

phase('SCOUT')
const scout = await agent(
  `Using Read/Glob/Bash (read-only), collect:
- ir_resources: every resource name from ${D}/ir.json ("resources[].name").
- behavior_files: the file names in ${D}/behavior/.
- modules: subdirectories containing .ts/.tsx under ${P}/src (depth 2, e.g. "src/server/routes", "src/db/actions", "src/shared/helpers") and under ${P}/frontend/src (depth 2). Only directories that hold code; skip tests, types, consts.
Return the lists.`,
  { schema: SCOUT, agentType: 'explorer', phase: 'SCOUT', effort: 'low' },
)
if (!scout) throw new Error('SCOUT returned no lists')
log(`IR: ${scout.ir_resources.length} resources, behavior: ${scout.behavior_files.length}, modules: ${scout.modules.length}`)

phase('MECH')
const mech = await agent(
  `cd ${P}. Do not modify any code.
1. Run "${cfg.gates.lint}". lint_errors = the number of biome + tsc errors. Turn every type/lint error that points at a LOGIC problem (not style) into a finding per the rules below; purely stylistic ones are only counted, not reported.
2. Run "${cfg.gates.test}". If the tests cannot start at all (no database, no env) — set tests_runnable=false, tests_passed=0, tests_failed=0 and emit ONE finding "tests do not run: <reason>". Otherwise set tests_runnable=true, fill in the passed/failed counts, and turn every failing test into a finding.
3. Write ${P}/.agent-loop/baseline.json: {"testsPassed": N, "lintErrors": M, "testsRunnable": bool} (create the directory if missing).
${RULES}`,
  { schema: MECH, agentType: 'coder', phase: 'MECH' },
)
const baseline = mech ? { lint: mech.lint_errors, passed: mech.tests_passed, failed: mech.tests_failed, runnable: mech.tests_runnable } : null
log(`MECH: lint ${baseline ? baseline.lint : '?'}, tests ${baseline ? `${baseline.passed}/${baseline.failed}${baseline.runnable ? '' : ' (do not run)'}` : '?'}`)

let raw = tag('mech', mech ? mech.findings : [])
const notImpl = []

if (canRun('IR', 300_000)) {
  phase('IR')
  const ir = await parallel(
    scout.ir_resources.map((name) => () =>
      agent(
        `Resource "${name}" from ${D}/ir.json (find its object under resources; mind the x-notes at the root of the file — they define the rules for paths, types and encryption).
If the resource has x-existing != true AND there is no route for its path under ${P}/src/server/routes, it is not implemented: emit one line in not_implemented and leave findings empty.
Otherwise compare it against the code in ${P}/src (routes, shared/schemas, db/actions, db/pg): path and operations, attributes (nullable/readonly/default), permit, validators, unique, x-role-values.
A finding means the code diverges from the IR (an extra field is accepted, a required one is not validated, the method or path does not match, a readonly field is mutated, uniqueness is not enforced).
${RULES}`,
        { schema: FINDINGS, agentType: 'reviewer-logical', phase: 'IR', label: `ir:${name}` },
      ),
    ),
  )
  for (const r of ir.filter(Boolean)) {
    raw.push(...tag('ir', r.findings))
    notImpl.push(...r.not_implemented)
  }
  log(`IR: ${raw.filter((f) => f.kind === 'ir').length} findings, not implemented: ${notImpl.length}`)
}

if (canRun('BEHAVIOR', 300_000)) {
  phase('BEHAVIOR')
  const beh = await parallel(
    scout.behavior_files.map((file) => () =>
      agent(
        `Read ${D}/behavior/${file}. It is a behavioral spec (invariant / pre / post per operation).
Find the implementing code in: ${CODEBASES} (grep by entity, fields, statuses, paths). For EVERY contract decide: implemented correctly / implemented with a divergence / no code at all.
A divergence becomes a finding. No code becomes a not_implemented line of the form "${file} § <operation>: no code in <where you looked>". Correct means nothing to report.
The prototype in frontend-app counts as code too: frontend behavior that diverges from the contract is a real divergence.
${RULES}`,
        { schema: FINDINGS, agentType: 'reviewer-logical', phase: 'BEHAVIOR', label: `behavior:${file}` },
      ),
    ),
  )
  for (const r of beh.filter(Boolean)) {
    raw.push(...tag('behavior', r.findings))
    notImpl.push(...r.not_implemented)
  }
  log(`BEHAVIOR: ${raw.filter((f) => f.kind === 'behavior').length} findings, not implemented: ${notImpl.length}`)
}

if (canRun('DEEP', 400_000)) {
  phase('DEEP')
  const deep = await parallel(
    scout.modules.map((mod) => () =>
      agent(
        `Module ${P}/${mod}. Read every file in it. Look for LOGIC errors, not style:
wrong comparisons (string vs enum, == vs ===, null vs undefined), missing or removed guards, unhandled branches and statuses,
boundary errors (off-by-one, empty arrays, pagination), bad error handling (swallowed exceptions, wrong response codes),
race conditions and unfinished transactions, dead or unreachable code with real consequences, types that disagree with runtime behavior.
"I would have written it differently" is not a finding. Set spec_ref = "no spec".
${RULES}`,
        { schema: FINDINGS, agentType: 'reviewer-deep', phase: 'DEEP', label: `deep:${mod}` },
      ),
    ),
  )
  for (const r of deep.filter(Boolean)) raw.push(...tag('deep', r.findings))
  log(`DEEP: ${raw.filter((f) => f.kind === 'deep').length} findings`)
}

// dedupe by file+line (IR and DEEP can raise the same problem)
const seen = new Set()
const unique = raw.filter((f) => {
  const k = `${f.file}:${f.line}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
log(`${raw.length} raw findings, ${unique.length} after dedupe, ${spentK()}k tokens`)

let confirmed = unique
let refutedCount = 0
if (unique.length && canRun('VERIFY', 150_000)) {
  phase('VERIFY')
  const verdicts = await parallel(
    unique.map((f) => () =>
      agent(
        `Try to refute this finding. Open ${P}/${f.file} around line ${f.line} plus the related code; if spec_ref is not "no spec", open that spec under ${D}.
Finding: ${f.title}
Analysis: ${f.analysis}
Cause: ${f.cause}
Spec: ${f.spec_ref}
Set refuted=true if: the code does not actually do this; the behavior is intentional and covered by a spec or a test; the spec was misread; the problem is not reproducible.
When in doubt, set refuted=true. reason is one line grounded in the code.`,
        { schema: VERDICT, agentType: 'reviewer-deep', phase: 'VERIFY', label: `verify:${f.file.split('/').pop()}:${f.line}`, effort: 'high' },
      ),
    ),
  )
  confirmed = unique.filter((f, i) => verdicts[i] && !verdicts[i].refuted)
  refutedCount = unique.length - confirmed.length
  log(`VERIFY: ${confirmed.length} confirmed, ${refutedCount} refuted`)
} else if (unique.length) {
  log('VERIFY skipped — cards will be marked UNVERIFIED')
}

phase('WRITE')
const order = { high: 0, medium: 1, low: 2 }
confirmed.sort((a, b) => order[a.severity] - order[b.severity])
const verified = !skipped.includes('VERIFY')
const CHUNK = 12
const header = `## Discover — ${cfg.runAt || '$(date +%Y-%m-%d)'} (to triage)

Baseline: lint ${baseline ? baseline.lint : '?'} errors, tests ${baseline ? `${baseline.passed} passed / ${baseline.failed} failed${baseline.runnable ? '' : ' (do not run)'}` : '?'}.
Run: ${raw.length} raw → ${unique.length} unique → ${confirmed.length} ${verified ? 'confirmed' : 'UNVERIFIED'}${refutedCount ? `, ${refutedCount} refuted` : ''}. Tokens ~${spentK()}k.${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}
Triage: set **Decision:** in each card to \`go\` (you may write "go, option 2"), \`reject\` or \`later\`. forge picks up only \`go\`, top to bottom.`

await agent(
  `Using Read+Edit, add a new section to ${cfg.stateFile} IMMEDIATELY AFTER the "## High Priority" section (before "## Watch"). Do not delete or reword anything that is already there.
Section text (substitute the real date via shell date if the heading contains $(date ...)):
${header}

Leave a blank line below it. Later steps will append the cards.`,
  { agentType: 'coder', phase: 'WRITE', label: 'write:header', effort: 'low' },
)

for (let i = 0; i < confirmed.length; i += CHUNK) {
  const chunk = confirmed.slice(i, i + CHUNK)
  await agent(
    `Using Read+Edit, append cards to ${cfg.stateFile} at the end of the "## Discover — …" section (before the next "## " heading).
D-NNN numbering is continuous: find the highest D-NNN anywhere in the file and continue from it (start at D-001 if there is none).
Format for EVERY card (exactly as shown — a human reads this):

### D-NNN · <title>  ·  <kind> · <severity>
- **Where:** \`<file>:<line>\`
- **Code:**
  \`\`\`ts
  <code>
  \`\`\`
- **Analysis:** <analysis>
- **Cause:** <cause>
- **Spec:** <spec_ref>
- **Fix options:**
  1. <fix_options[0]>
  2. <fix_options[1]>
  ...
- **Done when:** <done_criterion>
- **Decision:** _

Card data (JSON):
${JSON.stringify(chunk)}`,
    { agentType: 'coder', phase: 'WRITE', label: `write:${i / CHUNK + 1}`, effort: 'low' },
  )
}

if (notImpl.length) {
  await agent(
    `Using Read+Edit, append this subsection to ${cfg.stateFile} at the end of the "## Discover — …" section (before the next "## " heading):

### Not implemented (per the specs; not defects, not picked up by forge)
${[...new Set(notImpl)].map((s) => `- ${s}`).join('\n')}`,
    { agentType: 'coder', phase: 'WRITE', label: 'write:not-implemented', effort: 'low' },
  )
}

await agent(
  `cd ${P}. Append this entry to the END of ${P}/.agent-loop/run-log.md (create the file if missing):
## $(date '+%Y-%m-%d %H:%M') — forge-discover run
- baseline: lint ${baseline ? baseline.lint : '?'}, tests ${baseline ? `${baseline.passed}/${baseline.failed}` : '?'}
- findings: ${raw.length} raw, ${unique.length} unique, ${confirmed.length} in STATE.md, ${refutedCount} refuted, ${new Set(notImpl).size} not implemented
- tokens: ~${spentK()}k of ${Math.round(cfg.maxTokens / 1000)}k${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}
Substitute the real date via shell date.`,
  { agentType: 'coder', phase: 'WRITE', label: 'run-log', effort: 'low' },
)

return {
  baseline,
  raw: raw.length,
  unique: unique.length,
  confirmed: confirmed.length,
  refuted: refutedCount,
  notImplemented: new Set(notImpl).size,
  skipped,
  tokensK: spentK(),
  byKind: ['mech', 'ir', 'behavior', 'deep'].map((k) => `${k}:${confirmed.filter((f) => f.kind === k).length}`).join(' '),
}
