## 1. Mutator (test-first)

- [ ] 1.1 Write failing tests for eval/lib/mutate.mjs from the spec scenarios (node:test)
- [ ] 1.2 Implement mutate.mjs until tests pass

## 2. Analysis (test-first)

- [ ] 2.1 Write failing tests for eval/lib/stats.mjs (Wilson interval, per-arm and per-operator aggregation)
- [ ] 2.2 Implement stats.mjs and eval/analyze.mjs

## 3. Corpus builder

- [ ] 3.1 Implement eval/build-corpus.mjs: pick small commits from a target repo, verify clean tests pass, keep killable mutants
- [ ] 3.2 Smoke-run on a public repo with a small sample; commit the build log, not the cloned repo

## 4. Review arms

- [ ] 4.1 Commit reviewer prompts under eval/prompts/ (generic, logical, deep)
- [ ] 4.2 Write eval/review-eval.workflow.js running the four arms with token accounting per arm
- [ ] 4.3 Dry run on 2 items to check the output format (needs approval: spends tokens)

## 5. Report

- [ ] 5.1 eval/README.md: question, hypotheses, method, limits, how to reproduce
- [ ] 5.2 Full run and results table (needs approval: spends tokens)
