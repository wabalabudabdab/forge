## Context

Research question: **when compute is held equal, what in forge's review design reduces merged regressions —
extra compute, independence of the checker, or difference of mandate?**

Falsifiable hypothesis H1: two reviewers with different mandates (logical + deep) detect more injected
regressions than one reviewer given the same total budget in two passes, without a higher false-rejection rate.
H2: role difference matters beyond independence — logical+deep beats two reviewers with the same mandate.

## Decisions

- **Evaluate reviewers in isolation from the builder.** The builder's randomness would dominate a small
  sample. Diffs come from real human commits, so each clean diff is realistic and each buggy diff differs
  from it by exactly one known defect.
- **Oracle = the project's own tests.** A mutant enters the corpus only if the commit's tests pass on the
  clean version and fail on the mutated one. This removes equivalent mutants and makes "regression" an
  external fact, not our judgement. Cost: only test-covered code is sampled (stated as a validity threat).
- **Own mutator, not Stryker.** We need mutations confined to lines *added by the diff* and reproducible
  from a seed; a 150-line pure module with tests is simpler than adapting Stryker's file-level model.
  Operators: comparison flip, boundary shift (`<`↔`<=`, `±1`), condition negation, logical operator swap,
  removed early return/guard.
- **Arms (all see the same diff + commit message, never the tests):**
  - A0 `none` — approve everything (analytic baseline, no model call)
  - A1 `single-2pass` — one generic reviewer, two independent passes, reject if either rejects
  - A2 `same-mandate` — two fresh reviewers, both generic
  - A3 `forge` — reviewer-logical + reviewer-deep (current design)
  A1–A3 make two calls each, so call count is matched; tokens are measured and reported, not assumed equal.
  The "self-review in the builder's context" arm needs a builder and is deferred (noted in limits).
- **Sample.** ~30 clean diffs, each with one killable mutant → 60 items; 3 repetitions per item per arm
  (model nondeterminism) → 180 judgements per arm. Detects ≈20 pp differences in detection rate; smaller
  effects are reported as inconclusive, not as "no effect".
- **Metrics.** Detection rate (rejected buggy / buggy), false-rejection rate (rejected clean / clean),
  tokens per item; Wilson 95% intervals; breakdown by mutation operator.

## Risks / validity

- One repo, one language, one model family → external validity is narrow; stated in the write-up.
- Mutants are simpler than real agent-made bugs.
- Prompt quality of each arm is a confound; prompts are fixed and committed before the first run.
