## ADDED Requirements

### Requirement: Mutations are confined, seeded and reproducible
The mutator SHALL apply exactly one mutation to a line added by a unified diff, chosen deterministically from a seed,
and SHALL report the operator and the line it changed.

#### Scenario: Same seed, same mutant
- **WHEN** the mutator runs twice on the same diff with the same seed
- **THEN** both runs produce byte-identical output and the same operator/line metadata

#### Scenario: Only added lines are mutated
- **WHEN** a diff contains context lines and removed lines that match a mutation operator
- **THEN** only a line starting with `+` (excluding the `+++` header) is changed

#### Scenario: No applicable site
- **WHEN** no added line matches any operator
- **THEN** the mutator returns null instead of an unchanged diff

### Requirement: Corpus contains only oracle-confirmed regressions
The corpus builder SHALL include a mutant only if the project's test command passes on the clean commit and fails with the mutant applied.

#### Scenario: Surviving mutant is discarded
- **WHEN** tests still pass with the mutant applied
- **THEN** the mutant is excluded and recorded in the build log as "survived"

### Requirement: Review arms are fixed and matched in call count
The experiment SHALL run arms none, single-2pass, same-mandate and forge over the identical corpus, each model arm making exactly two reviewer calls per item, with prompts read from committed files.

#### Scenario: Reviewer never sees the oracle
- **WHEN** any reviewer prompt is built
- **THEN** it contains the diff and commit message and does not contain test files, test output or the mutation metadata

### Requirement: Results report rates with intervals
The analysis SHALL output, per arm, detection rate, false-rejection rate and mean tokens per item, each rate with a Wilson 95% interval, plus detection rate per mutation operator.

#### Scenario: Analysis of a known input
- **WHEN** the analyzer reads a results file with 10 buggy items of which 7 were rejected
- **THEN** it reports detection 0.70 with interval bounds 0.40 and 0.89 (two decimals)
