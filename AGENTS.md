# Agent instructions

请用中文回复用户的问题。

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Test routing

Use the smallest test tier that proves the current logical change. The repository can already contain unrelated uncommitted work, so route by the files changed in the current task unit, not by the entire `git status` result.

- Markdown wording, indexes, and historical notes only: use Node 24.x and run `npm --prefix sites run test:docs:fast`. If the default `node` is not v24.x, prepend the locally configured Node 24 binary directory without writing that machine-specific path into repository files.
- Customer project `00`–`06`, status derivation, or generated-source metadata: first run `sync:business-surfaces` when the source intentionally changed, then run `test:customer-contracts`. Run `test:customer-boundary` when public/private boundaries, aliases, evidence IDs, URLs, tokens, or private-workspace behavior changed.
- Current implementation-design Markdown under `20-设计-进行中/`: run `test:design-contracts`. If PlantUML changed, run `sync:arch-diagrams` before the check.
- SQL or OpenAPI contracts: run `test:machine-contracts`; add the relevant targeted Node/Python tests when behavior changed.
- HTML templates, generated HTML shell, CSS, browser interaction, accessibility, archive/build scripts, dependencies, lockfiles, CI, or release plumbing: run the corresponding browser/archive checks; use `test:release` for a release candidate.
- Always run `test:release` before a publish manifest, stage/commit handoff, PR, deployment, or phase-closing claim. A lightweight tier is iteration evidence, not release evidence.
- Do not run PostgreSQL preflight, browser suites, or `npm audit` for a wording-only edit unless that edit is part of a release checkpoint.
