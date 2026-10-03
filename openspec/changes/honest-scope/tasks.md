## 1. Layout config

- [x] 1.1 Add `layout` with defaults to `cfg` in discover.workflow.js and document it in the header comment
- [x] 1.2 Rewrite SCOUT, IR and BEHAVIOR prompts to use `cfg.layout`; drop the "frontend-app prototype" line
- [x] 1.3 Verify: syntax check in an async wrapper; grep for leftover project paths returns nothing

## 2. Documentation

- [x] 2.1 SKILL.md: remove greenfield mode from description and Modes; add `layout` to the discover example
- [x] 2.2 README.md: remove greenfield mode, add a Limits section, describe scope as defect maintenance
- [x] 2.3 Verify: "greenfield" appears in README.md and SKILL.md only as out of scope, never as a supported mode
