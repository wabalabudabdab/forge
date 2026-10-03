## 1. Mutator (test-first)

- [x] 1.1 Write failing tests for eval/lib/mutate.mjs from the spec scenarios (node:test)
- [x] 1.2 Implement mutate.mjs until tests pass

## 2. Analysis (test-first)

- [x] 2.1 Write failing tests for eval/lib/stats.mjs (Wilson interval, per-arm and per-operator aggregation)
- [x] 2.2 Implement stats.mjs and eval/analyze.mjs

## 3. Corpus builder

- [x] 3.1 Implement eval/build-corpus.mjs: pick small commits from a target repo, verify clean tests pass, keep killable mutants
- [x] 3.2 Smoke-run on a public repo with a small sample; commit the build log, not the cloned repo

## 4. Review arms

- [x] 4.1 Commit reviewer prompts under eval/prompts/ (generic, logical, deep)
- [x] 4.2 Write eval/review-eval.workflow.js running the four arms with token accounting per arm
- [x] 4.3 Dry run on 2 items (script already checked end-to-end with mocked agents) to check the output format (needs approval: spends tokens)

## 5. Report

- [x] 5.1 eval/README.md: question, hypotheses, method, limits, how to reproduce
- [ ] 5.2 Full run and results table (needs approval: spends tokens)
