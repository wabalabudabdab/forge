## Why

forge's README asserts that two independent reviewers with different mandates make merges safer. That
is a design belief, not a measured result: there are two runs on one private repo and no comparison.
The naive question ("does review catch regressions?") has an obvious answer and confounds two things —
an independent view and simply spending more compute. The question worth answering is *how*: which part
of the review design does the work, and on which kinds of defect.

## What Changes

- New `eval/` directory with a reproducible experiment on a public repository.
- A deterministic corpus builder: real small commits from a public TS/JS repo's history are the clean
  diffs; a seeded mutator injects one known defect into an added line, and a mutant is kept only if the
  repo's own tests catch it (so every buggy diff is a real regression by an external oracle).
- A Workflow script that runs four review arms over the same corpus with a matched token budget.
- An analysis script that produces the results table with confidence intervals, per arm and per defect type.
- A results write-up template that is published whatever the outcome.

## Capabilities

### New Capabilities
- `review-eval`: corpus construction, review arms, metrics and reporting for the review-independence experiment.

### Modified Capabilities

## Impact

New files only (`eval/**`). No change to the loop. Running the experiment spends model tokens; the run is
started manually and never by CI.
