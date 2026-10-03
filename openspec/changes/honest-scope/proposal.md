## Why

The README and SKILL.md promise more than the code does. forge is a defect-maintenance loop for mature
code, but it is advertised as also handling greenfield work (a "BUILD" mode with no design, spec or
test-first phase), and `discover.workflow.js` hard-codes the directory layout of the one private
project it was run on (`src/server/routes`, `db/actions`, `frontend/src`). A public repo that claims
generality it does not have is worse than a narrow one that is accurate.

## What Changes

- **BREAKING** Remove the "BUILD (greenfield)" mode from SKILL.md and README. forge is described as a
  maintenance loop for mature code: it fixes triaged defects; it does not design or build features.
- State the limits explicitly: no planning/decomposition, no test-first step, done-criterion is judged
  by reviewers (not by a test), specs are consumed only by `discover`, evidence is two tasks on one repo.
- Move the hard-coded project layout in `discover.workflow.js` into a `layout` config block with
  neutral defaults; remove references to a project-specific "frontend-app prototype".
- Fix the README naming collision: the loop phase called `BUILD` stays (it is the implement step),
  the removed *mode* no longer shares its name.

## Capabilities

### New Capabilities
- `loop-scope`: what forge claims to do, what it explicitly does not do, and how a project's layout is configured.

### Modified Capabilities

## Impact

`README.md`, `skill/SKILL.md`, `skill/discover.workflow.js` (config + prompt text only, no control-flow change).
Callers passing no `layout` get generic defaults instead of the old project's paths.
