## Context

`discover` prompts embed paths from one TypeScript monorepo. Agents follow those paths literally, so on
any other repo SCOUT finds nothing under `src/server/routes` and IR marks every resource "not implemented".

## Decisions

- **Config shape.** `layout: { moduleRoots: string[], routesDir: string | null, irCodeDirs: string[] }`.
  Defaults: `moduleRoots: ['src']`, `routesDir: null`, `irCodeDirs: ['src']`. With `routesDir: null` the
  IR prompt tells the agent to locate the route by grepping the codebases instead of assuming a folder.
  Rejected: auto-detecting layout in SCOUT — extra agent judgement in the one phase that should be mechanical.
- **Remove the mode, keep the phase.** The greenfield mode had no mechanism behind it (only a different
  gate sentence). Removing it is cheaper and more honest than half-building it.
- **Limits section in README**, not scattered caveats: one place a reader checks before trusting the tool.

## Risks

- Existing private callers that relied on the old defaults must now pass `layout`. Acceptable: there is one caller, and its invocation is updated in SKILL.md's example.
