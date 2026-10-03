# Review-independence experiment

forge merges a change only if two reviewer agents with different mandates approve it. This experiment
measures whether that design earns its cost, and which part of it does the work.

## Question

When the number of reviewer calls is held equal, what reduces merged regressions:
extra compute, independence of the checker, or a difference of mandate?

- **H1 (independence).** Two reviewers in fresh contexts catch more injected regressions than one reviewer
  making a second pass over its own verdict, without more false rejections.
- **H2 (role).** forge's logical + deep pair catches more than two reviewers with the same generic mandate.

Either result is publishable. "Independence adds nothing over a second pass" would be as useful to anyone
building these loops as the opposite.

## Method

**Corpus.** Small real commits from a public repository (dayjs). The clean item is a commit's change to
source files. The buggy item is the same change with one seeded mutation on a line the commit added
(`lib/mutate.mjs`: comparison flip, boundary shift, condition negation, logical swap, removed guard).
A pair is kept only if the project's tests pass on the commit and fail with the mutation: every buggy
item is a regression by the project's own oracle, not by our judgement.

**Arms.** Every model arm makes two reviewer calls per item and rejects if either rejects.

| arm | what it isolates |
|---|---|
| `none` | baseline: approve everything |
| `single-2pass` | more compute: one reviewer, second pass sees its own first verdict |
| `same-mandate` | independence: two generic reviewers in fresh contexts |
| `forge` | independence + role: `reviewer-logical` + `reviewer-deep` with forge's mandates |

Reviewers see the commit message and the source diff only — never tests, test output, or which item is buggy.
Prompts are in `prompts/` and are fixed before the first run.

**Metrics.** Detection rate (buggy rejected / buggy), false-rejection rate (clean rejected / clean),
output tokens per item; Wilson 95% intervals; detection per mutation operator.

**Sample.** 30 pairs × 3 repetitions = 180 judgements per arm. Differences of roughly 20 percentage points
are detectable; smaller ones are reported as inconclusive, not as "no effect".

## Reproduce

```bash
# 1. corpus (no model calls); the clone must have dependencies installed
git clone https://github.com/iamkun/dayjs && (cd dayjs && npm ci --ignore-scripts)
node eval/build-corpus.mjs --repo ./dayjs --test "npx jest --silent" \
  --src '^src/' --tests '(^test/|\.test\.)' --want 30 --scan 900 --out eval/corpus/dayjs-30

# 2. args for the workflow (corpus + committed prompts)
node eval/make-args.mjs eval/corpus/dayjs-30/items.jsonl 3 > args.json

# 3. run in Claude Code, one model arm per run (a Workflow run is capped at 1000 agents;
#    one arm is 60 items × 3 reps × 2 calls = 360):
#    Workflow({ scriptPath: "eval/review-eval.workflow.js", args: { ...args.json, arms: ["none", "single-2pass"] } })
#    then arms: ["same-mandate"] and arms: ["forge"]; save each returned object to a file

# 4. results
node eval/save-results.mjs < run-1.json >  eval/results/dayjs-30.jsonl
node eval/save-results.mjs < run-2.json >> eval/results/dayjs-30.jsonl
node eval/save-results.mjs < run-3.json >> eval/results/dayjs-30.jsonl
node eval/analyze.mjs eval/results/dayjs-30.jsonl
```

`npm test` inside `eval/` runs the unit tests for the mutator and the statistics.

## Limits

- One repository, one language, one model family. External validity is narrow.
- Only test-covered code can enter the corpus, and mutants are simpler than real agent-made bugs.
- Reviewers judge diffs written by humans, not by forge's coding agent.
- `forge` uses custom agent types whose system prompts also differ; "role" includes that.
- Token spend is measured per arm and averaged per item, not per call.
- Not tested: self-review inside the builder's own context (needs a builder in the loop).

## Results

Not run yet.
