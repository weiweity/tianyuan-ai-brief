# Agent instructions

请用中文回复用户的问题。

## Scope and authorization

- Explanation, inspection, diagnosis, review, and PLAN ONLY requests are read-only. An explicit request to fix, optimize, or implement authorizes the scoped changes and appropriate verification; proceed without repeated confirmation while that scope remains clear.
- Skills do not expand authorization. Commit, push, PR creation, merge, deployment, external writes, real-data access, paid calls, and material deletion require authorization covering that action. Once granted, do not ask again unless the target, scope, or risk materially changes.
- Preserve unrelated work. A local task completion report must distinguish the work delivered, verification performed, and remaining blockers; it does not imply business approval or production acceptance.

## Skill routing

Use skills explicitly requested by the user or clearly matching the task's intended outcome. Use the current host's available skill-loading mechanism; if there is no dedicated Skill tool, read the listed `SKILL.md` completely and follow it. Do not invent tool names or trigger a workflow merely because its topic is mentioned.

Inspecting a skill or checking its version does not authorize its setup scripts, upgrades, telemetry, config writes, auto-fixes, or publishing steps. Follow higher-priority instructions and the user's authorized scope; if a skill blocks progress, identify the relevant rule and explain the smallest decision needed.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate; diagnosis stays read-only unless repair is authorized
- QA/testing site behavior → invoke /qa-only for reporting, /qa when fixes are authorized
- Code review/diff check → invoke /review; apply fixes only when authorized
- Visual polish → invoke /design-review
- Ship/deploy/PR execution → invoke /ship or /land-and-deploy within the authorized actions; status questions remain read-only
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Project knowledge and sources

- Start with `business-docs/README.md` for navigation. For customer-agent governance, use `business-docs/01-客服Agent项目/README.md` to locate the relevant `00`–`06` sources, design contracts, and evidence; read only the sources needed for the task.
- This repository owns project scope, approvals, status, and formal contracts. The independent product repository owns runtime implementation facts. Code or test success does not itself advance an approval gate.
- Navigation pages, generated views, historical snapshots, and model memory are not independent authority for current status. Verify current claims against the relevant source and evidence; report conflicts instead of guessing. Directory names alone do not establish lifecycle status.
- Change generated pages and contract exports through their source files and documented generators in `business-docs/08-工具/README.md`. Preserve frozen history and immutable exports; create a new version when required rather than overwriting one.
- Follow the public/private boundary documented in the business entry points. Do not add real customer content, credentials, PII, or private evidence links to public candidates; Git exclusion alone is not physical isolation.
- Verify time-sensitive model capabilities, pricing, tool parameters, and external product facts using current authoritative documentation. Do not hard-code model-specific assumptions or transient project status into this file.

## Test routing

Use the smallest test tier that proves the current logical change. The repository can already contain unrelated uncommitted work, so route by the files changed in the current task unit, not by the entire `git status` result.

- Markdown wording, indexes, and historical notes only: use Node 24.x and run `npm --prefix sites run test:docs:fast`. If the default `node` is not v24.x, prepend the locally configured Node 24 binary directory without writing that machine-specific path into repository files.
  This script checks diff formatting, not business correctness; also read the changed wording and verify any newly added paths or references.
- Customer project `00`–`06`, status derivation, or generated-source metadata: first run `sync:business-surfaces` when the source intentionally changed, then run `test:customer-contracts`. Run `test:customer-boundary` when public/private boundaries, aliases, evidence IDs, URLs, tokens, or private-workspace behavior changed.
- Current implementation-design Markdown under `20-设计-进行中/`: run `test:design-contracts`. If PlantUML changed, run `sync:arch-diagrams` before the check.
- SQL or OpenAPI contracts: run `test:machine-contracts`; add the relevant targeted Node/Python tests when behavior changed.
- HTML templates, generated HTML shell, CSS, browser interaction, accessibility, archive/build scripts, dependencies, lockfiles, CI, or release plumbing: run the corresponding browser/archive checks; use `test:release` for a release candidate.
- Always run `test:release` before a publish manifest, stage/commit handoff, PR, deployment, or formal project-phase acceptance claim. A normal report that a scoped local edit is finished is not a phase acceptance claim. A lightweight tier is iteration evidence, not release evidence.
- Reuse recorded passing verification only when the candidate contents, relevant environment, and dependencies remain unchanged. Rerun affected checks after new changes, failures, or unresolved concerns; do not repeat a passing full suite solely for another status update. Release evidence must remain traceable to the candidate being handed off.
- Do not run PostgreSQL preflight, browser suites, or `npm audit` for a wording-only edit unless that edit is part of a release checkpoint.
