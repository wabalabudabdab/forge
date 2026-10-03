## ADDED Requirements

### Requirement: Scope is stated as defect maintenance on mature code
The documentation SHALL describe forge as a loop that fixes human-triaged defects in an existing codebase
with a test/lint/build baseline, and SHALL NOT claim support for greenfield or feature development.

#### Scenario: Reader looks for supported modes
- **WHEN** a reader opens README.md or skill/SKILL.md
- **THEN** exactly one mode is described (maintenance of mature code) and no "greenfield" or "BUILD mode" claim appears

### Requirement: Limits are listed explicitly
README.md SHALL contain a "Limits" section stating: no planning or decomposition; no test-first step;
done-criterion judged by reviewers, not by a test; specifications used only by discover; evidence limited to two tasks on one private repository.

#### Scenario: Reader checks what forge does not do
- **WHEN** a reader opens the Limits section
- **THEN** each of the five limits above is stated in one sentence

### Requirement: Project layout is configurable
`discover.workflow.js` SHALL read module roots, the routes directory and the IR code directories from `cfg.layout`,
and its prompts SHALL NOT contain project-specific paths.

#### Scenario: No layout passed
- **WHEN** discover runs without `layout` in args
- **THEN** prompts reference `src` as the only module root and instruct the agent to locate routes by search rather than a fixed folder

#### Scenario: Layout passed
- **WHEN** args include `layout: { moduleRoots: ['packages/api/src'], routesDir: 'packages/api/src/routes', irCodeDirs: ['packages/api/src'] }`
- **THEN** every path in the SCOUT and IR prompts is derived from those values

#### Scenario: No leftover hard-coded paths
- **WHEN** `grep -nE "server/routes|db/actions|db/pg|frontend/src|frontend-app" skill/*.js` is run
- **THEN** it returns no matches outside the defaults comment
