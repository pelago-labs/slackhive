# @slackhive/qa

QA framework for Claude Code agents on slackhive.

**Tier 1 — Static healthcheck (the linter):** Deterministic checks against an agent's `CLAUDE.md`, `skills/`, `wiki/`, and `mcps.yaml`. No LLM, no infrastructure dependencies. Catches dangling skill references, undeclared MCPs, overlapping triggers, missing test coverage, and other authoring bugs before runtime.

**Tier 2 — Regression eval (the integration test):** Drives slackhive's `/test` SSE endpoint against a YAML corpus of approved test cases. Composable check primitives (`substring`, `tool_called`, `llm_judge`) plug together per agent — no per-agent adapter classes in framework code.

## Status

**Scaffold only.** Tasks 1+ implement the framework per the plan.

## Documentation

- [`docs/V1-DESIGN.md`](./docs/V1-DESIGN.md) — authoritative design (tiers, primitives, selectors, verdict set, lifecycle)
- [`docs/V1-PLAN.md`](./docs/V1-PLAN.md) — task-by-task implementation playbook (17 tasks, 9 milestones)
