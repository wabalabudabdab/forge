---
name: forge
description: Autonomous agent loop-director. Takes tasks from a project queue and drives each one to a merge through gates (tests/types/lint/build) and independent review, cleaning up its own branches. Triggers — "forge", "/forge", "run the loop", "drive the project", "work the queue". Works on mature code (IMPROVE) and greenfield (BUILD). NOT for a one-off edit — for iterative work through a task queue.
---

# forge — an agent loop that drives a project to done

> A director that picks up a project and works it task by task until it runs,
> then keeps improving it. Every task goes through the full circle and **cleans up after itself**.

## Activation
Triggers: `forge`, `/forge`, "run the loop", "drive the project", "work the queue".

## What it does (one pass = one task)
`SELECT` (top card in the queue) → `BUILD` (coder on its own branch) →
`GATE` (gates, criterion **NO-REGRESSION**) → `REVIEW` (logical + deep reviewers on a freshly generated diff artifact) →
`INTEGRATE` (merge + branch deletion) → `RECORD` (journal + state + card update in STATE.md).
The outer loop keeps going while triaged cards remain, `STATE.md` does not say `Pause: yes`, and the token ceiling is not exhausted.
A failing task does NOT stop the loop: it gets a `retry` with the reviewer's objections recorded in `state.md`,
and after `maxAttempts` it becomes `BLOCKED` (branch left in place for a human) while the loop takes the next card.

## Preconditions (MANDATORY — skipping these reproduces the failures this design came from)
Before starting, make sure that:
1. **You are in a sandbox clone**, not the production repository (full autonomy → contain the risk).
2. **The database is isolated** (its own container/port) if tests are integration tests — otherwise the loop writes into someone else's data.
3. **`.agent-loop/` and `.env*` are out of git tracking** (`.gitignore` + `git rm --cached`) — otherwise noise and secrets end up in commits.
4. **A baseline is recorded** in `.agent-loop/journal.md` (tests passed/failed, lint errors) — without it NO-REGRESSION cannot be measured.
5. **The queue is triaged** in `STATE.md`: D-NNN cards from forge-discover marked `**Decision:** go`.
6. **The denylist matches the project** — the default blocks `.env*`, keys, CI/Docker files, `/auth/`.

## Step 0 — forge-discover (read-only reconnaissance, never touches code)
Triggers: "forge discover", "find work", "what needs doing". Script: `discover.workflow.js`.
Four sources: MECH (lint/tsc/tests, writes `.agent-loop/baseline.json`), IR (`docs/druid/ir.json` ↔ routes/schemas),
BEHAVIOR (`docs/druid/behavior/*.md` ↔ backend and frontend code), DEEP (logic defects across source modules).
Every finding is handed to an independent agent whose job is to refute it; "not implemented" goes into a separate list, not into cards.
The result is a `## Discover — <date>` section in `STATE.md` with cards: Where / Code / Analysis / Cause / Spec / Fix options / Done when / Decision.
```
Workflow({ scriptPath: "discover.workflow.js",
  args: { projectPath, extraPaths, stateFile, druidDir, gates: { lint, test }, maxTokens, runAt: "<date>" } })
```
Defaults are placeholders — override them through args. Always pass `runAt`: the script has no access to `Date`.
A human triages each card with **Decision:** `go` (or `go, option 2`), `reject`, `later`. Only then does the loop run.

## Running the loop
Loop script: `forge.workflow.js`. Invocation:
```
Workflow({
  scriptPath: "forge.workflow.js",
  args: {
    projectPath: "<git repo>",
    stateFile:   "<STATE.md holding the cards>",
    baseBranch:  "main",
    maxTasks:    3,
    gates: { lint: "...", build: "...", test: "..." },
    baseline: null,          // null → .agent-loop/baseline.json written by discover
    maxAttempts: 3,          // attempts per task, counted across runs
    maxTokens: 600_000,      // output-token ceiling for one run
    denylist: [".env", ".pem", ".key", ".gitlab-ci.yml", "docker-compose", "Dockerfile", "/auth/"]
  }
})
```
Kill switch: `Pause: yes` in the `STATE.md` header — the next SELECT ends the run without touching code.
If no args are passed, the defaults in the script header apply.

## Guarantees (built in, each one earned during the runs)
- **NO-REGRESSION**: nothing is merged if previously passing tests fail, the build breaks, or lint errors grow.
- **The diff artifact is always fresh** (`rm` before generation) — a reviewer never judges by a stale file.
- **BUILD never commits env files or secrets** — `.env*` reverted before commit plus a self-check.
- **Self-cleanup**: the branch is merged `--no-ff` and deleted; no orphan branches are left behind.
- **Attempt limit** (`maxAttempts`): a retry carries the previous objections from `state.md` and re-creates the branch from base; after the limit the task goes `BLOCKED` with exactly one branch, no duplicates.
- **Denylist verified as fact**, not promised: `git diff --name-only` is matched against the patterns before review; a violation is never merged.
- **Token ceiling per run** (`maxTokens`) with per-task accounting in the journal.
- **`run-log.md`** — one append-only entry per run: tasks attempted, outcomes, tokens, stop reason.

## State files (`.agent-loop/`, outside git)
| file | role |
|---|---|
| `STATE.md` (project's) | queue and outcomes for the human: cards, Done, Blocked, `Pause:` |
| `state.md` | `\| id \| attempts \| status \| last_issues \|` — attempt memory between runs |
| `baseline.json` | written by discover: testsPassed, lintErrors |
| `journal.md` | per-task detail (gate, outcome, tokens) |
| `run-log.md` | one entry per run (both discover and the loop) |

The discipline comes from loop engineering: maker/checker, attempt limits, denylist, budget, run-log, kill switch.

## Modes
- **IMPROVE** (mature code): gates = tests/types/lint/build. Proven on a production monorepo (lint 83 → 0, then 12 failing tests → 0).
- **BUILD** (greenfield): gates = artifact validity + compilation. For Workflow scripts, compile inside an async wrapper (`vm.Script`), NOT bare `node --check` — the latter reports a false error on a top-level return.
