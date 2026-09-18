// forge — a reusable agent loop that takes a project the rest of the way.
// One pass = one task from the queue: BUILD → GATE → REVIEW → INTEGRATE+CLEANUP → RECORD.
// The outer loop walks the queue while tasks remain and the budget holds out.
//
// Run: Workflow({ scriptPath: ".../forge.workflow.js", args: { ...cfg } })
// args (all optional, defaults are tuned for your project):
//   projectPath  — path to the project's git repo
//   baseBranch   — base branch (we merge into this one)
//   maxTasks     — how many tasks to take in one run (safety valve)
//   gates        — { lint, build, test }  shell commands for the gates (test may need a DB)
//   baseline     — { testsPassed, lintErrors } for the NO-REGRESSION criterion
//   maxAttempts  — attempts per task (across all runs); after that the task goes BLOCKED and the loop moves on
//   maxTokens    — output-token ceiling for the run (our own, independent of the "+500k")
//   denylist     — paths the loop must never touch (checked mechanically against git diff --name-only)
//
//   stateFile    — the project's STATE.md: the queue is D-NNN cards marked "**Decision:** go" (written by forge-discover, marked up by a human)
//
// State carried between runs:
//   STATE.md (stateFile)      — queue and outcomes for the human; the line "Pause: yes" is the kill switch
//   .agent-loop/state.md      — table | id | attempts | status | last_issues |  (attempt memory)
//   .agent-loop/baseline.json — baseline from discover, when args.baseline isn't passed
//   .agent-loop/journal.md    — per-task details
//   .agent-loop/run-log.md    — append-only, one entry per run
//
// Lessons from shaking this down (baked in, don't change without a reason):
//   1. the diff goes to the reviewer as a file artifact (read-only agents have no Bash)
//   2. BUILD never does a blind git add -A — it reverts env files before committing, then self-checks
//   3. the diff artifact is ALWAYS rm'd before regeneration (stale diff = bogus verdict)
//   4. INTEGRATE cleans up its own branch and checks that no .env slipped into the commit
//   5. (loop engineering) attempt limit + BLOCKED, denylist over the diff, token ceiling, run-log, Pause in STATE.md

export const meta = {
  name: 'forge',
  description: 'Agent loop: pulls tasks from the project queue and drives each one to merge through gates and review, cleaning up after itself',
  phases: [
    { title: 'SELECT' },
    { title: 'BUILD' },
    { title: 'GATE' },
    { title: 'REVIEW' },
    { title: 'INTEGRATE' },
  ],
}

const cfg = {
  projectPath: '/path/to/your-project',
  stateFile: '/path/to/your-project/STATE.md',
  baseBranch: 'main',
  maxTasks: 3,
  gates: {
    lint: 'bun run lint',
    build: 'bun run build',
    test: 'bun run test',
  },
  baseline: null,
  maxAttempts: 3,
  maxTokens: 600_000,
  denylist: ['.env', '.pem', '.key', '.gitlab-ci.yml', 'docker-compose', 'Dockerfile', '/auth/'],
  ...(args || {}),
}

const P = cfg.projectPath
const S = cfg.stateFile
const BASELINE = cfg.baseline
  ? `tests ${cfg.baseline.testsPassed} passed, lint ${cfg.baseline.lintErrors} errors`
  : `read ${P}/.agent-loop/baseline.json (testsPassed, lintErrors); if the file is missing, count a regression only from build_ok=false and tests_failed>0`

const TASK_SCHEMA = {
  type: 'object',
  required: ['id', 'has_task', 'scope', 'done_criterion', 'attempts', 'last_issues', 'reason'],
  properties: {
    id: { type: 'string' },
    has_task: { type: 'boolean' },
    scope: { type: 'string' },
    done_criterion: { type: 'string' },
    attempts: { type: 'integer' },
    last_issues: { type: 'string' },
    reason: { type: 'string' },
  },
}
const DIFF_SCHEMA = {
  type: 'object',
  required: ['files', 'violations'],
  properties: { files: { type: 'integer' }, violations: { type: 'array', items: { type: 'string' } } },
}
const GATE_SCHEMA = {
  type: 'object',
  required: ['lint_errors', 'build_ok', 'tests_passed', 'tests_failed', 'regression', 'notes'],
  properties: {
    lint_errors: { type: 'integer' },
    build_ok: { type: 'boolean' },
    tests_passed: { type: 'integer' },
    tests_failed: { type: 'integer' },
    regression: { type: 'boolean' },
    notes: { type: 'string' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['approved', 'issues'],
  properties: { approved: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
}
const INTEGRATE_SCHEMA = {
  type: 'object',
  required: ['merged', 'branch_deleted', 'notes'],
  properties: { merged: { type: 'boolean' }, branch_deleted: { type: 'boolean' }, notes: { type: 'string' } },
}

const results = []
const DENY = cfg.denylist.join(', ')
const tokensAtStart = budget.spent()
const tokensLeft = () => cfg.maxTokens - (budget.spent() - tokensAtStart)
let stopReason = 'queue empty'

for (let i = 0; i < cfg.maxTasks; i++) {
  if (tokensLeft() < 60_000 || (budget.total && budget.remaining() < 60_000)) {
    stopReason = `token ceiling (${Math.round((budget.spent() - tokensAtStart) / 1000)}k of ${Math.round(cfg.maxTokens / 1000)}k)`
    log(`Budget running out — stopping the loop: ${stopReason}`)
    break
  }

  phase('SELECT')
  const task = await agent(
    `Work through Read/Edit.
0. Read ${S}. If the header says "Pause: yes", that's the kill switch: has_task=false, reason="PAUSE".
1. The queue is the "### D-NNN · …" cards under the "## Discover — …" sections whose line reads "**Decision:** go" (a qualifier after a comma is allowed, e.g. "go, option 2"). Order is top to bottom through the file.
2. Read ${P}/.agent-loop/state.md (if it's missing, create it with the table "| id | attempts | status | last_issues |"). For the topmost card, get attempts (0 if there's no row) and last_issues.
   If attempts >= ${cfg.maxAttempts}, replace "**Decision:** go…" in the card with "**Decision:** blocked (attempt limit, branch forge/<id> left in place)", set status=blocked in state.md, and take the NEXT card. Repeat until you find an eligible one.
3. If there are none, has_task=false, reason="empty".
Return: id (D-NNN), has_task, scope = title + "Analysis" + the chosen fix option (the one the human named, otherwise option 1) + "Where", done_criterion = "Done when", attempts, last_issues, reason.`,
    { schema: TASK_SCHEMA, agentType: 'coder', phase: 'SELECT' },
  )
  if (!task || !task.has_task) {
    stopReason = task && task.reason === 'PAUSE' ? 'PAUSE (kill switch)' : 'queue empty'
    log(`Loop finished: ${stopReason}`)
    break
  }

  const BR = `forge/${task.id.toLowerCase()}`
  const attempt = (task.attempts || 0) + 1
  log(`▶ ${task.id} (attempt ${attempt}/${cfg.maxAttempts}): ${task.scope}`)
  const tokensAtTask = budget.spent()

  phase('BUILD')
  const build = await agent(
    `cd ${P} (a git repo). Solve task ${task.id}: ${task.scope}
Done criterion: ${task.done_criterion}
${task.last_issues ? `This is attempt ${attempt}. The last attempt was rejected: ${task.last_issues}. Take that into account.` : ''}
Steps:
1. git checkout ${cfg.baseBranch}; git branch -D ${BR} 2>/dev/null; git checkout -b ${BR}
2. Implement the task. Change ONLY what the task calls for. Do NOT touch business logic beyond what's necessary.
   FORBIDDEN paths (denylist, the merge will be rejected mechanically): ${DENY}. If the task can't be done without them, don't do it — explain in the summary.
3. Keep it clean: git checkout -- '**/.env*' 2>/dev/null; true  (env files never get committed)
4. git add -A && git commit -m "${task.id}: ${task.scope}"
5. Self-check: git show --stat HEAD must NOT list any .env* files.
Return a short summary as text.`,
    { agentType: 'coder', phase: 'BUILD' },
  )

  phase('GATE')
  const gate = await agent(
    `cd ${P} && git checkout ${BR}. Run the gates and return the numbers:
- lint_errors: "${cfg.gates.lint}" → the number after "Found N errors" (0 if there is none)
- build_ok: "${cfg.gates.build}" → exit 0?
- tests_passed / tests_failed: "${cfg.gates.test}" → "N passed / M failed"
Baseline: ${BASELINE}.
regression = true IF (tests_passed < baseline.testsPassed) OR (build_ok=false) OR (lint_errors > baseline.lintErrors). Otherwise false. Say in notes which baseline you used.`,
    { schema: GATE_SCHEMA, agentType: 'coder', phase: 'GATE' },
  )

  let reviews = []
  let integrate = { merged: false, branch_deleted: false, notes: '' }
  let issues = ''

  if (gate.regression) {
    issues = `GATE regression: tests ${gate.tests_passed}/${gate.tests_failed}, build ${gate.build_ok}, lint ${gate.lint_errors}. ${gate.notes}`
    integrate.notes = `GATE regression — branch ${BR} left in place for investigation`
    log(`✗ ${task.id}: ${issues}`)
  } else {
    // diff artifact: ALWAYS rm the old one before generating (lesson 3) + mechanical denylist check
    const diff = await agent(
      `cd ${P} && rm -f .agent-loop/${task.id}.diff .agent-loop/${task.id}.stat && git diff ${cfg.baseBranch}..${BR} > .agent-loop/${task.id}.diff && git diff --stat ${cfg.baseBranch}..${BR} > .agent-loop/${task.id}.stat && git diff --name-only ${cfg.baseBranch}..${BR}
Remove the old files first. files = the number of files from --name-only.
violations = the paths from --name-only that contain any substring from the denylist: ${DENY}. Empty array if there are none.`,
      { schema: DIFF_SCHEMA, agentType: 'coder', phase: 'REVIEW', label: `diff:${task.id}` },
    )
    if (diff && diff.violations.length) {
      issues = `denylist: ${diff.violations.join(', ')}`
      integrate.notes = `denylist violated — branch ${BR} left in place`
      log(`✗ ${task.id}: ${issues}`)
    } else {
      phase('REVIEW')
      reviews = await parallel([
        () =>
          agent(
            `Use Read to go through the FRESH diff at ${P}/.agent-loop/${task.id}.diff and ${P}/.agent-loop/${task.id}.stat (read it in chunks if it's large).
  Task ${task.id}: ${task.scope}. Criterion: ${task.done_criterion}.
  Does the diff match the intent? Check that the diff contains NO .env files ("diff --git" headers with .env).
  approved=false if logic changed beyond the task's scope, or if env files/secrets are present. issues — a list (empty if all is well).`,
            { schema: REVIEW_SCHEMA, agentType: 'reviewer-logical', phase: 'REVIEW' },
          ),
        () =>
          agent(
            `Use Read to go through the FRESH diff at ${P}/.agent-loop/${task.id}.diff (in chunks).
  Look for hidden breakage: behavior changed under the guise of a refactor, guards or checks removed, types broken.
  approved=false on well-founded suspicion. issues — a list.`,
            { schema: REVIEW_SCHEMA, agentType: 'reviewer-deep', phase: 'REVIEW' },
          ),
      ])
      const ok = reviews.filter(Boolean).every((r) => r.approved)
      if (ok) {
        phase('INTEGRATE')
        integrate = await agent(
          `cd ${P}. Before merging: git show --stat ${BR} must NOT list any .env* (if it does — merged=false, STOP).
  Otherwise: git checkout ${cfg.baseBranch}; git merge --no-ff ${BR} -m "merge ${task.id}"; git branch -d ${BR}
  Return merged, branch_deleted, notes. Confirm that "git branch" no longer shows ${BR}.`,
          { schema: INTEGRATE_SCHEMA, agentType: 'coder', phase: 'INTEGRATE' },
        )
      } else {
        issues = `REVIEW: ${reviews.filter(Boolean).flatMap((r) => r.issues).join('; ')}`
        integrate.notes = `REVIEW rejected it — branch ${BR} left in place`
        log(`✗ ${task.id}: ${issues}`)
      }
    }
  }

  const blocked = !integrate.merged && attempt >= cfg.maxAttempts
  const taskTokens = Math.round((budget.spent() - tokensAtTask) / 1000)

  // RECORD: journal + state (attempts) + queue
  await agent(
    `cd ${P}. Work through Read+Edit.
1. Append an entry for ${task.id} (attempt ${attempt}) to ${P}/.agent-loop/journal.md:
- gate: lint ${gate.lint_errors}, build ${gate.build_ok}, tests ${gate.tests_passed}/${gate.tests_failed}, regression ${gate.regression}
- outcome: ${integrate.merged ? 'MERGED + branch deleted' : 'not merged (' + integrate.notes + ')'}
- tokens: ~${taskTokens}k
2. In ${P}/.agent-loop/state.md, update or add the row for ${task.id}: attempts=${attempt}, status=${integrate.merged ? 'done' : blocked ? 'blocked' : 'retry'}, last_issues="${(issues || '').replace(/"/g, "'").slice(0, 300)}".
3. In ${S}: ${integrate.merged ? `in card ${task.id}, replace the "**Decision:** …" line with "**Decision:** done (forge, merged into ${cfg.baseBranch})" and add one line under "## Done (recent)": "- ${task.id}: ${task.scope.split('.')[0].slice(0, 90)} — forge".` : blocked ? `in card ${task.id}, replace the "**Decision:** …" line with "**Decision:** blocked (${cfg.maxAttempts} attempts, branch ${BR}: ${(issues || '').replace(/"/g, "'").slice(0, 120)})" and add a line under "## Blocked": "- ${task.id}: forge couldn't do it in ${cfg.maxAttempts} attempts, branch ${BR}".` : 'change nothing.'}`,
    { agentType: 'coder', phase: 'INTEGRATE', label: `record:${task.id}` },
  )

  results.push({ task: task.id, attempt, gate, merged: integrate.merged, blocked, issues, tokensK: taskTokens })
  if (blocked) log(`⛔ ${task.id}: BLOCKED after ${attempt} attempts — needs a human; the loop moves on`)
  else if (!integrate.merged) log(`↻ ${task.id}: attempt ${attempt} failed, the next pass will pick it up again with the notes in hand`)
}

const totalK = Math.round((budget.spent() - tokensAtStart) / 1000)
await agent(
  `cd ${P}. Append ONE entry to the END of ${P}/.agent-loop/run-log.md (create it if missing; delete nothing):
## $(date '+%Y-%m-%d %H:%M') — forge run
- tasks: ${results.length}, merged: ${results.filter((r) => r.merged).length}, retry: ${results.filter((r) => !r.merged && !r.blocked).length}, blocked: ${results.filter((r) => r.blocked).length}
- tokens: ~${totalK}k of ${Math.round(cfg.maxTokens / 1000)}k
- stopped on: ${stopReason}
- by task: ${results.map((r) => `${r.task}#${r.attempt}=${r.merged ? 'merged' : r.blocked ? 'BLOCKED' : 'retry'}`).join(', ') || 'none'}
Substitute the real date via shell date.`,
  { agentType: 'coder', phase: 'INTEGRATE', label: 'run-log', effort: 'low' },
)

return { ran: results.length, merged: results.filter((r) => r.merged).length, blocked: results.filter((r) => r.blocked).map((r) => r.task), tokensK: totalK, stopReason, results }
