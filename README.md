# forge — an autonomous agent loop that ships to merge

**forge** takes a queue of tasks in a real repository and drives each one to a merged commit on its
own: a coding agent implements it on a branch, quality gates decide whether it regressed anything,
two independent reviewers judge it from a freshly generated diff, and the loop merges, deletes the
branch, records what happened, and picks up the next task.

It is not a prompt template and not "an agent that writes code". It is a control loop with an
invariant, a budget, a kill switch and a durable state file — designed so that autonomy is bounded
and every failure mode it has actually hit is closed by a mechanism, not by a wish.

Run on a real production TypeScript monorepo. Two tasks carried end to end:

| Task | What it did | Gate result | Outcome |
|---|---|---|---|
| T-001 | Lint cleanup, 83 → 0 errors across 57 files, logic untouched | no-regression held (tests 44 pass / 12 fail = baseline), build ✅, typecheck ✅ | merged `--no-ff`, branch deleted |
| T-003 | Fixed the 12 baseline-failing integration tests | 56 passed / 0 failed, lint 0, build ✅ | merged, branch deleted |

Authorship, plainly: the design — the loop, the gate criterion, the preconditions and the fixes
listed below — is mine. The implementation was written with Claude Code under that design, which is
also the point: this is what directing agents looks like when the result has to survive a merge.

---

## Why it exists

Coding agents are good at producing a diff and bad at being trusted with a repository. The gap is
not model quality — it is that nothing around the model answers the three questions an engineering
organization must answer before code lands:

1. **Did this break anything that worked yesterday?**
2. **Who checked it, and did that checker actually see the code?**
3. **What happens when it fails — repeatedly, or in a way nobody notices?**

forge is an answer to those three questions in the form of a loop. The agent is a component inside
it, not the system itself.

---

## Engineering concepts it is built on

### 1. Maker/checker separation
The agent that writes the code never approves it. Review is done by two separate agents with
different mandates — one asking *does this do what the task asked?*, the other *edge cases,
performance, security* — neither of which has authority to edit. This is the banking maker/checker
control applied to agents: the useful property is not "two opinions", it is that the approving party
has no stake in the work being accepted.

### 2. NO-REGRESSION as the gate invariant, not "all green"
Real codebases are not green. The repository it ran on had 83 lint errors and 12 failing tests at
baseline. A gate demanding a clean build would either block every task forever or push the agent to
"fix" unrelated code to get through.

So the gate is **relative to a recorded baseline**: previously passing tests must still pass, lint
errors must not increase, build and typecheck must stay at exit 0. Clearing the baseline debt then
becomes an ordinary task in the queue rather than a precondition for doing any work at all. This is
the difference between a quality gate and a quality *ratchet* — the ratchet is what works on legacy
code, and it is why the second task in the table above was possible.

### 3. Artifact-mediated review, and the stale-artifact hazard
An early run failed for a reason worth keeping: the logical reviewer had no shell access, could not
run `git diff`, and correctly refused to approve code it could not see. The fix was to make diff
generation an explicit phase — the loop writes the diff to a file and reviewers read that file.

That introduced the sharper failure: a restored backup left an *old* diff in place, the reviewer
read it, and rejected clean code for problems that no longer existed. **A stale artifact does not
error — it lies with full confidence.** So the diff phase now deletes before it generates.
Freshness is the producer's responsibility, never the consumer's assumption. This is cache
invalidation wearing a different hat, and it is the most instructive defect the project produced.

### 4. Blast-radius containment
Full autonomy is only acceptable when the radius of a mistake is known in advance:
- work happens in a **sandbox clone**, never the production repository;
- the database is a **separate container on its own port and volume** (an early version shared the
  development database — a correctness risk for data that was not the loop's to touch);
- **`.env*` and loop metadata are removed from git tracking**, because `git add -A` in an agent's
  hands will otherwise commit secrets and noise;
- a **denylist is verified as fact, not promised**: `git diff --name-only` is matched against the
  patterns before review, so a task touching credentials, CI config or auth cannot be merged.

### 5. Bounded autonomy — attempts, budget, kill switch
Every autonomous loop needs a reason to stop before it runs out of money or patience:
- `maxAttempts` per task; a retry re-creates the branch from base and carries the previous
  reviewer's objections into the next attempt, so retries are informed rather than identical;
- after the limit the task becomes `BLOCKED`, its branch is preserved for a human to inspect, and
  **the loop moves on** — one bad task does not stall the queue;
- `maxTokens` caps spend per run, with per-task accounting in the journal;
- a pause flag in the state file is a kill switch honoured at the next selection point, so a human
  can stop the loop without killing a process mid-merge.

The design goal is a loop that degrades into a queue of clearly-labelled problems, rather than one
that either hangs or thrashes.

### 6. Durable state outside the working tree
Attempt counts, reviewer objections, the token budget, the baseline and an append-only run log live
in `.agent-loop/`, outside git. A run can be interrupted and resumed; a later run knows what an
earlier one already tried and why it failed. Without this, "retry" means "repeat the same mistake".

### 7. Transactional integration and self-cleanup
Integration is all-or-nothing: merge `--no-ff` (so the task stays visible as a unit in history) and
delete the branch in the same phase. A loop that leaves branches behind accumulates
indistinguishable half-states within a day; self-cleanup is what makes it runnable unattended.

### 8. Read-only discovery with adversarial verification, then a human decision
Before the loop touches anything, `discover` finds work without write access: mechanical signals
(lint/types/tests), specification-versus-implementation drift, and reasoned defect hypotheses.
**Every finding is then handed to an independent agent whose job is to refute it** — unverified
findings never become tasks. Surviving findings are written as cards with cause, evidence and repair
options, and a human writes one line on each: *in progress*, *reject*, *later*.

This puts the human at the cheapest control point — deciding what is worth doing — instead of the
most expensive one, reviewing code an agent already wrote for a problem that was never real.

### 9. Policy and mechanism are separate files
`SKILL.md` holds the policy — when to run it, preconditions, guarantees, what it refuses to do.
`forge.workflow.js` / `discover.workflow.js` hold the mechanism. The policy is read by the agent
that invokes the loop; the mechanism is deterministic orchestration code. Keeping them apart is what
lets the loop's behaviour change by editing rules rather than by re-prompting.

---

## The loop

```
discover (read-only) → human triage → SELECT → BUILD → GATE → REVIEW → INTEGRATE → RECORD → next
                                          ↑                    │
                                          └── retry with objections (≤ maxAttempts) ──┘
```

| Phase | What happens |
|---|---|
| `SELECT` | Top task marked *in progress*; stop if paused, queue empty, or budget exhausted |
| `BUILD` | Coding agent implements on its own branch; env files protected from the commit |
| `GATE` | Lint / typecheck / build / tests, judged against the baseline (no-regression) |
| `REVIEW` | Fresh diff artifact generated, then logical + deep reviewers judge it independently |
| `INTEGRATE` | Denylist verified, merge `--no-ff`, branch deleted |
| `RECORD` | Journal entry, attempt state, token accounting, run-log line |

Two modes share the flow and differ only in what the gate means: **IMPROVE** for mature code
(tests/types/lint/build) and **BUILD** for greenfield (artifact validity and compilation).

---

## Repository layout

```
skill/SKILL.md                policy: activation, preconditions, guarantees, state files
skill/forge.workflow.js       the loop: select → build → gate → review → integrate → record
skill/discover.workflow.js    read-only discovery with adversarial verification of findings
```

Built for [Claude Code](https://claude.com/claude-code) as a skill plus two workflow scripts. The
concepts above are not tied to that runtime — the loop, the gates and the state model are the
portable part.

---

## What this is not

- Not a benchmark result. Two real tasks on one real codebase, with the failures written down.
- Not unattended-on-production software. It is designed for a sandbox clone by construction, and
  the preconditions in `SKILL.md` are requirements, not suggestions.
- Not an argument that agents should merge code without humans. It is an argument that if they do,
  these are the mechanisms that have to exist first.
