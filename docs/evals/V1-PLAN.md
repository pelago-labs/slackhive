# QA Framework v1 — Implementation Plan

> **Read `V1-DESIGN.md` first.** That's the authoritative design (tiers, primitives, selectors, verdict set, lifecycle). This document is the **task playbook** — what to build, in what order, with what acceptance.

> **For readers in slackhive's repo:** Path examples (`agents-dev/gilfoyle/`) use Pelago's setup. The framework itself takes a path argument and works on any agent directory.

**Top-line summary:** 17 tasks across 9 milestones (M0–M8). Two verification gates (M4 and M8) — **stop and validate** before continuing. Commit per task. Solo capacity → estimated 3 weeks.

**Required sub-skill for execution:** `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## Sequencing & Milestones

```
M0  Package scaffold                        →  Task 0          (1 task)
M1  Loader (AgentConfig + Corpus)           →  Task 1          (1 task)
M2  Tier 1: 9 healthcheck checks            →  Tasks 2-10      (9 tasks)
M3  Tier 1: reporter + CLI                  →  Task 11         (1 task)
M4  ★ Tier 1 acceptance gate ★              (verification, no task)
M5  Tier 2: SSE client + corpus filter      →  Tasks 12-13     (2 tasks)
M6  Tier 2: selectors + primitives          →  Task 14         (1 task)
M7  Tier 2: judge + orchestrator + report   →  Tasks 15-16     (2 tasks)
M8  ★ Tier 2 acceptance gate ★              →  Task 17         (validation cases + run)
```

**Critical rule:** Do not start M5 until M4 acceptance gate is green. Tier 2 work is expensive (LLM calls) and assumes Tier 1 catches the cheap bugs first.

---

## File Structure

All paths relative to slackhive monorepo root.

```
packages/qa/
├── package.json                              # @slackhive/qa, version 0.1.0
├── tsconfig.json                             # mirrors packages/shared/tsconfig.json
├── README.md
├── docs/
│   ├── V1-DESIGN.md                          # this design
│   └── V1-PLAN.md                            # this plan
├── src/
│   ├── index.ts                              # public API barrel
│   ├── types.ts                              # AgentConfig, Corpus, Case, CheckConfig, Trace, ToolCall, Verdict, etc.
│   ├── loader/
│   │   ├── index.ts                          # loadAgent(dir): { config, corpus }
│   │   ├── claude-md.ts                      # parses Step 0 triggers, MCP refs, skill refs
│   │   ├── skills.ts                         # walks skills/ recursively, parses frontmatter
│   │   ├── wiki.ts                           # walks wiki/
│   │   ├── mcps-yaml.ts                      # parses mcps.yaml
│   │   └── corpus.ts                         # loads tests.yaml, filters by status
│   ├── healthcheck/
│   │   ├── index.ts                          # runHealthcheck(cfg, corpus): HealthcheckIssue[]
│   │   ├── qa001-mcp-coverage.ts
│   │   ├── qa002-cross-refs.ts
│   │   ├── qa003-trigger-conflicts.ts
│   │   ├── qa004-skill-overlap.ts
│   │   ├── qa005-persona-hygiene.ts
│   │   ├── qa006-tool-prefix.ts
│   │   ├── qa007-wiki-coverage.ts
│   │   ├── qa008-test-coverage.ts            # NEW
│   │   ├── qa009-corpus-shape.ts             # NEW
│   │   └── reporter.ts                       # eslint-style stdout, --json
│   ├── runner/
│   │   ├── index.ts                          # runCases(cfg, corpus): RunResult[]
│   │   ├── sse-client.ts                     # POST /test, stream → events
│   │   ├── trace.ts                          # SSE events → Trace
│   │   ├── selectors/
│   │   │   ├── final-reply.ts
│   │   │   └── tool-calls.ts
│   │   ├── primitives/
│   │   │   ├── substring.ts
│   │   │   ├── tool-called.ts
│   │   │   └── llm-judge.ts
│   │   ├── judge.ts                          # spawn `claude -p`, parse JSON
│   │   ├── check-runner.ts                   # composes selector + primitive
│   │   └── reporter.ts                       # writes runs/<ts>/report.{md,json}
│   └── cli.ts                                # `slackhive qa <subcmd>`
└── __tests__/
    ├── loader.test.ts
    ├── healthcheck-qa001.test.ts             # ... through qa009
    ├── runner-trace.test.ts
    ├── runner-primitives.test.ts
    └── fixtures/
        ├── good-agent/                       # synthetic clean config
        └── bad-agent/                        # synthetic config seeded with each QA001-009 issue
```

**Per-agent corpora** (Pelago):
- `agents-dev/gilfoyle/eval/tests.yaml` (refactor to new shape — see Task 17)
- `agents-dev/nelson/eval/tests.yaml` (new — see Task 17)

For OSS consumers, the corpus lives wherever they keep their agent directory.

---

## Task 0: Package scaffold

**Goal:** Create the `@slackhive/qa` package skeleton.

**Files:**
- `packages/qa/package.json` (name: `@slackhive/qa`, private: true, MIT, tsc build)
- `packages/qa/tsconfig.json` (extends shared config)
- `packages/qa/README.md` (one paragraph + pointer to `docs/V1-DESIGN.md`)
- `packages/qa/src/index.ts` (empty barrel)
- `packages/qa/src/types.ts` (skeleton types, all exported)

**Steps:**
- [ ] Add `packages/qa` to root `package.json` workspaces array (if not auto-detected)
- [ ] Define skeleton types: `AgentConfig`, `Corpus`, `Case`, `CheckConfig`, `Trace`, `ToolCall`, `Verdict`, `HealthcheckIssue`
- [ ] `npm install` from monorepo root succeeds
- [ ] `npm run build -w @slackhive/qa` succeeds and emits `dist/`

**Acceptance:** Build green, importable as `@slackhive/qa` from a sibling package.

---

## Task 1: Loader (AgentConfig + Corpus)

**Goal:** Read an agent directory into typed structures.

**Files:**
- `loader/index.ts` — `loadAgent(dir): { config: AgentConfig, corpus: Corpus | null }`
- `loader/claude-md.ts` — parses Step 0 triggers, MCP tool references, skill references
- `loader/skills.ts` — walks `skills/` recursively, parses frontmatter (`name`, `description`)
- `loader/wiki.ts` — walks `wiki/`, extracts entity names from filenames
- `loader/mcps-yaml.ts` — parses `mcps.yaml` → typed list of `mcp__<server>__<tool>` ids
- `loader/corpus.ts` — parses `eval/tests.yaml` → `Corpus { checks: CheckConfig[], cases: Case[] }`; **filters cases by `status: 'approved'`** by default, accepts `includeProposed: true` option

**Types** (in `types.ts`):
```typescript
type AgentConfig = {
  dir: string;
  claudeMd: ClaudeMdData;
  skills: Skill[];
  wikiEntities: string[];
  mcps: string[];  // tool ids like "mcp__notion__notion-fetch"
};

type Corpus = {
  filePath: string;
  fileMtime: number;  // for immutability assertion in Task 17
  checks: CheckConfig[];
  cases: Case[];
};

type CheckConfig = {
  primitive: 'substring' | 'tool_called' | 'llm_judge';
  target?: 'final_reply' | 'tool_calls';
  contains_from?: string;
  not_contains_from?: string;
  must_call_from?: string;
  must_not_call_from?: string;
  rubric?: string;
  case_fields?: string[];
};

type Case = {
  id: string;
  status: 'approved' | 'proposed';
  question: string;
  approved_by?: string;
  approved_at?: string;
  [key: string]: any;  // case-specific fields (must_contain, expected_tools, groundtruth_sql, etc.)
};
```

**Acceptance:**
- [ ] Loads Pelago's Gilfoyle dir without error
- [ ] Round-trips: parsed YAML matches written YAML
- [ ] `status: 'proposed'` cases excluded by default
- [ ] `__tests__/loader.test.ts` covers happy path + 3 edge cases (missing file, bad YAML, missing required field)

---

## Tasks 2–10: Tier 1 healthcheck checks (9 checks)

**Pattern for each task:**
- File: `healthcheck/qa00N-<name>.ts`
- Exports: `runQA00N(config, corpus): HealthcheckIssue[]`
- Test: `__tests__/healthcheck-qa00N.test.ts` (uses `fixtures/good-agent/` for zero issues, `fixtures/bad-agent/` for seeded violations)

Per check details below.

### Task 2: QA001 — MCP coverage

Walk `CLAUDE.md` + every `skills/*.md` for `mcp__<server>__<tool>` references. Cross-check against the parsed `mcps.yaml`. Report each reference that points to an undeclared tool.

**Severity:** `error`. **File pointer:** line of the offending reference.

### Task 3: QA002 — Cross-refs

Parse markdown links in `CLAUDE.md` + `skills/*.md`. For each `[...](wiki/X.md)` or `[...](skills/Y.md)`, confirm the file exists. Report dangling refs.

**Severity:** `error`.

### Task 4: QA003 — Trigger conflicts

Parse Step 0 triggers from `CLAUDE.md`. If two triggers match overlapping Slack inputs (use regex equivalence or substring containment heuristic), report.

**Severity:** `error`. v1 heuristic: trigger phrases are equal-or-prefix.

### Task 5: QA004 — Skill overlap

Tokenize each skill's frontmatter `description` (lowercase, strip punctuation, split on whitespace). Compute Jaccard similarity between every pair. Report pairs with similarity ≥ 0.7.

**Severity:** `warn` (high false-positive rate possible — start conservative).

### Task 6: QA005 — Persona hygiene

Scan `CLAUDE.md` + every skill for banned patterns:
- `force-push`, `--no-verify`
- `rm -rf`
- `"ignore previous"`, `"ignore prior"`
- `"system override"`, `"system-override"`
- `"always agree"`

Each match → issue with location.

**Severity:** `error`.

### Task 7: QA006 — Tool prefix correctness

For every tool reference matching `[a-z][a-z0-9-]+-[a-z][a-z0-9-]+` (bare tool name pattern), check if there's a matching `mcp__<server>__<tool>` in declared MCPs. If bare reference exists but no qualified form, report it.

**Severity:** `error`. (Common authoring mistake — easy fix.)

### Task 8: QA007 — Wiki coverage

For every wiki entity reference in skills (e.g., `[product X](wiki/product-x.md)` or named mentions), check that a corresponding wiki file exists.

**Severity:** `error`.

### Task 9: QA008 — Test coverage (**new**)

For every skill in `skills/` and every Step 0 trigger in `CLAUDE.md`, check whether at least one case in `corpus.cases` covers it. Coverage heuristics:
- Skill is covered if any case's `question` mentions a token from the skill's frontmatter `description` or filename
- Trigger is covered if any case's `question` matches the trigger pattern

Report uncovered items.

**Severity:** `warn` (informational; agents under active development always have gaps).

**Why this check matters:** see `V1-DESIGN.md` § *"Auto-update behavior"* — when a new skill is added without a test case, this is the immediate signal.

### Task 10: QA009 — Corpus shape (**new**)

Validate that the corpus's `checks:` block is internally consistent with the per-case fields. Specifically:
- Every `contains_from: X` / `not_contains_from: X` / `must_call_from: X` / `case_fields: [X, ...]` referenced field must exist on at least the schema of cases (warn) or on every case (error)
- Every `target:` value is one of `final_reply` or `tool_calls`
- Every `primitive:` is one of the v1 three
- Every `rubric:` path resolves to an existing file (relative to corpus directory)

**Severity:** mixed — `error` for missing primitives/targets/rubrics, `warn` for partial field coverage.

---

## Task 11: Healthcheck reporter + CLI

**Goal:** Wire the 9 checks into a runnable CLI.

**Files:**
- `healthcheck/index.ts` — `runHealthcheck(config, corpus): HealthcheckIssue[]` (calls all 9 checks, concatenates)
- `healthcheck/reporter.ts` — formats output: eslint-style (`severity / code / file:line / message`) or JSON
- `cli.ts` — adds subcommand `slackhive qa healthcheck <dir> [--json]`

**Acceptance:**
- [ ] `slackhive qa healthcheck <pelago-agent-dir>` runs end-to-end, prints eslint-style
- [ ] `--json` produces machine-parseable output
- [ ] Exit code 1 if any `error`-severity issue; exit 0 otherwise (warnings don't fail)
- [ ] `__tests__/healthcheck-reporter.test.ts` covers format + exit codes

---

## ★ M4 Verification Milestone ★ — Tier 1 acceptance gate (no task, but blocks Tier 2)

Before starting Tier 2 (M5+), verify:

- [ ] `slackhive qa healthcheck` runs against Pelago's `agents-dev/gilfoyle/` and reports **0 errors** (warnings are OK and expected for QA008 if Gilfoyle's corpus doesn't cover every skill yet)
- [ ] Same for `agents-dev/nelson/` (when the corpus exists from Task 17 prep)
- [ ] `fixtures/bad-agent/` triggers **at least one issue per QA001–QA009**
- [ ] `--json` output parses with `jq`

**If any of the above fails**, fix Tier 1 before continuing. Tier 2 builds on a working Tier 1 — pushing forward with broken healthcheck = wasted LLM time downstream.

---

## Task 12: SSE client + trace parser

**Goal:** Drive slackhive's `/test` endpoint and parse the response into a `Trace`.

**Files:**
- `runner/sse-client.ts` — `POST localhost:3002/test`, parse SSE events as `{event, data}` stream
- `runner/trace.ts` — accumulate SSE events into `Trace { final_reply: string, tool_calls: ToolCall[] }`

**Reference:** `apps/runner/src/test-handler-server.ts` for the expected request/response shape.

**Acceptance:**
- [ ] Given a mock SSE stream fixture, parser produces correct `Trace`
- [ ] Connection error / 5xx → returns sentinel that downstream maps to **INFRA** verdict
- [ ] Timeout configurable (default 60s/case)
- [ ] `__tests__/runner-trace.test.ts` covers happy path + 3 error modes

---

## Task 13: Corpus loader extensions (already mostly in Task 1, extend here)

**Goal:** Add status filtering + mtime tracking already started in Task 1.

**Files:**
- `loader/corpus.ts` — extend with `filterByStatus(corpus, { includeProposed })` and ensure `fileMtime` is recorded at load time

**Acceptance:**
- [ ] Default load returns only `approved` cases
- [ ] `--include-proposed` returns both
- [ ] `corpus.fileMtime` is set
- [ ] `__tests__/loader.test.ts` extended to cover both filtering modes

---

## Task 14: Selectors + Primitives

**Goal:** Implement the 2 selectors + 3 primitives that compose into checks.

**Files:**
- `runner/selectors/final-reply.ts` — `(trace: Trace) => string`
- `runner/selectors/tool-calls.ts` — `(trace: Trace) => ToolCall[]`
- `runner/primitives/substring.ts` — `(selected: string, case: Case, config: CheckConfig) => PrimitiveVerdict`
- `runner/primitives/tool-called.ts` — `(toolCalls: ToolCall[], case: Case, config: CheckConfig) => PrimitiveVerdict`
- `runner/primitives/llm-judge.ts` — stub for now; body in Task 15
- `runner/check-runner.ts` — `runCheck(config, case, trace): PrimitiveVerdict` (looks up selector + primitive, composes)

**Empty-selector handling** (per V1-DESIGN.md):
- `substring` on empty string → **FAIL** with reason `"final_reply was empty"`
- `tool_called` on empty array → **FAIL** with reason `"agent did not call any tools"`
- `llm_judge` on empty → **SUSPECT** (handled in Task 15)

**Acceptance:**
- [ ] Unit test each selector with a mock trace
- [ ] Unit test each primitive with synthetic input/case/config
- [ ] Unit test `check-runner.ts` composition end-to-end with all selector × primitive combinations used by Gilfoyle and Nelson
- [ ] Empty-selector handling verified per spec

---

## Task 15: Judge subprocess + rubric loading

**Goal:** The `llm_judge` primitive body — spawn `claude -p`, pass rubric as system prompt + case as user prompt, parse JSON verdict.

**Files:**
- `runner/judge.ts` — `judge({ rubricPath, caseFields, target, selectedText }): JudgeVerdict`
- `runner/primitives/llm-judge.ts` — wraps `judge.ts` into the primitive interface

**Flow:**
1. Read rubric file from `rubricPath` (resolved relative to corpus dir)
2. Build user prompt: JSON containing `{ target_text: selectedText, case_fields: { question, groundtruth_*, ... } }`
3. Spawn `claude -p --model sonnet --system <rubric>` and pipe user prompt
4. Parse stdout as JSON `{ verdict: "PASS"|"FAIL", reasoning: string }`
5. Map verdict to `PrimitiveVerdict`. Empty selected text → **SUSPECT** (don't invoke judge — saves cost)
6. Timeout (default 60s), retry once on parse failure

**Acceptance:**
- [ ] Given a mock rubric + mock claude binary, judge invokes correctly
- [ ] JSON parse error → retry; second parse error → SUSPECT verdict + log raw output
- [ ] Empty selected text → SUSPECT verdict without invoking claude
- [ ] `__tests__/runner-judge.test.ts` covers happy path + 4 failure modes

---

## Task 16: Orchestrator + reporter

**Goal:** Tie everything together. Run a corpus end-to-end, aggregate verdicts, write reports.

**Files:**
- `runner/index.ts` — `runCases(config, corpus, opts): RunResult[]` — the main loop
- `runner/reporter.ts` — writes `runs/<ts>/report.md` and `runs/<ts>/report.json`
- `cli.ts` — adds subcommand `slackhive qa run <dir> [--include-proposed] [--json] [--case <id>]`

**Per-case execution:**
1. POST question to `/test` (with fresh `sessionId` to avoid context contamination)
2. Parse SSE → `Trace`
3. For each `CheckConfig` in corpus: run via `check-runner.ts` → `PrimitiveVerdict`
4. Aggregate case verdict:
   - **Static FAIL beats judge PASS**: if any deterministic primitive (`substring`, `tool_called`) is FAIL, case is FAIL regardless of judge
   - Otherwise, case verdict = worst-of all primitives
5. Record: `RunResult { caseId, verdict, primitiveVerdicts: [], trace }`

**Reporter output (md):**
- Per-case row: `id / verdict / static signal / judge verdict / judge reasoning`
- Summary: PASS/FAIL/SUSPECT/INFRA counts

**Reporter output (json):**
- Full structured `RunResult[]` for CI / future web UI

**Acceptance:**
- [ ] `slackhive qa run <dir>` runs end-to-end against a real slackhive `/test`
- [ ] `report.md` is human-readable, matches Gilfoyle's existing eval `report.md` shape
- [ ] `report.json` parses with `jq`
- [ ] Static FAIL beats judge PASS verified with a synthetic case
- [ ] `__tests__/runner-orchestrator.test.ts` covers verdict aggregation + report write

---

## Task 17: End-to-end proof — validation cases ★ M8 ★

**Goal:** Write the actual reference cases and prove the framework works on both Pelago agents.

**Files** (Pelago repo, not slackhive):
- `agents-dev/gilfoyle/eval/tests.yaml` — refactor existing file to new shape (`checks:` block + cases with `status: approved`); start with T001 only; existing T002–T013 follow later
- `agents-dev/gilfoyle/eval/rubric.md` — SQL judge rubric (port from existing `judge-prompt.md`)
- `agents-dev/nelson/eval/tests.yaml` — new, single case N001 (real incident, ID picked from Datadog)
- `agents-dev/nelson/eval/rubric.md` — RCA judge rubric

**Run from slackhive checkout:**
```bash
slackhive qa run /path/to/agents-dev/gilfoyle/   # against T001
slackhive qa run /path/to/agents-dev/nelson/     # against N001
```

**Acceptance (M8 gate):**
- [ ] T001 returns **PASS**
- [ ] N001 returns **PASS**
- [ ] `tests.yaml` mtime is **unchanged** after each run (immutability rule from V1-DESIGN.md acceptance #7)
- [ ] `runs/<ts>/report.json` parses with `jq`
- [ ] `runs/<ts>/report.md` is human-readable and contains all 5 fields per case
- [ ] Both cases use **only** the 2 selectors + 3 primitives shipped in v1 — no special-case framework code (V1-DESIGN.md acceptance #8)

If both pass — V1 is done. Open the PR.

---

## What's NOT in v1

See `V1-DESIGN.md` § *"What's in v1 / what's not"* for the full table. Highlights of what is **explicitly deferred**:

- **Web UI** (per-agent QA tab) → v1.5; spec in `V1.5-UX.md` (to be written)
- **Slack mining → proposed cases** → v1.5; reduces case-authoring cold-start
- **Peer QA-agent itself** → separate workstream; consumes this framework for its own eval
- **Dinesh adapter (PR diff judge)** → v2.5; needs richer LLM judge primitive
- **Trajectory eval** (DeepEval/Ragas-style sequence assertions) → Tier 3
- **Synthetic case generation** → Tier 4
- **Org-level QA dashboard** → v2 (after per-agent QA tab lands)
- **Nightly cron + Slack digest** → blocked on sandbox env (Pelago context); CLI works today

---

## Risks & open questions

1. **`claude -p` reliability under load.** Gilfoyle's existing `eval/run.py` reports occasional flake (JSON parse failures, timeouts). Task 15 builds in retry + SUSPECT fallback to avoid masking these as agent regressions. If the rate climbs >5%, switch transport to the Anthropic SDK (Task 15 leaves the door open).

2. **`/test` endpoint and agent identification.** The CLI currently takes a path; slackhive's `/test` may expect an agentId UUID. Resolve in Task 12 — either by adding an agent lookup helper or accepting the UUID via flag. (Note for OSS: end users may run slackhive in modes where the agent's path *is* its identifier; framework should work either way.)

3. **Per-case context contamination** (the T010/T008 issue documented in Gilfoyle's self-eval). Tier 2 design uses a fresh `sessionId` per case → fresh slackhive participant → mitigates. If still observed, force `DELETE /test` between cases.

4. **Nelson corpus depends on real production booking IDs** still being available in Datadog. Datadog retention is finite. Plan to refresh N001 monthly. (Once sandbox env exists, seed with synthetic IDs.)

5. **Rubric drift.** Rubric files live with the agent, not the framework. If a rubric needs frequent tuning, the agent's behavior or the test case's groundtruth is probably wrong — investigate before re-tuning.

6. **Solo capacity → parallel workstreams.** Peer QA-agent (a) is planned to start in parallel after Tier 1 lands. If (a) ships without its own eval cases passing this framework, its verdicts become noise. **Mitigation:** gate (a)'s v0 production deploy on ≥5 of its own cases passing here.

---

## Self-review checklist

Before marking V1 done:

- [ ] All 9 Tier 1 checks have unit tests with positive + negative fixtures
- [ ] All 5 runner subsystems (sse-client, trace, selectors, primitives, judge) have unit tests
- [ ] Both reference cases (T001, N001) pass end-to-end
- [ ] `tests.yaml` mtime unchanged after any framework operation
- [ ] No `gilfoyle.ts` / `nelson.ts` / `dinesh.ts` files exist in the framework (no named adapters)
- [ ] V1-DESIGN.md and V1-PLAN.md are up-to-date and live in `packages/qa/docs/`
- [ ] README.md points to V1-DESIGN.md as authoritative
- [ ] `npm run build` and `npm test` both green from monorepo root
