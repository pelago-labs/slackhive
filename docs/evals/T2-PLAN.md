# Tier 2 — Implementation plan

Builds on `V1-DESIGN.md`. Tier 1 (static healthcheck, 7 checks) shipped as the
Evals tab in `apps/web/src/lib/evals/`. This doc plans Tier 2 — the regression
eval runner, the test-case CRUD, and the UI that replaces the current "Coming
soon" placeholder.

## Phases

| Phase | What | Effort | Blocks |
|-------|------|--------|--------|
| **T0** Foundation — DB schema | New tables: `eval_cases`, `eval_runs`, `eval_run_results`. Migrations + `@slackhive/shared` type additions. | 0.5d | everything |
| **T1** Test-case CRUD UI | Drawer with case list + add/edit form. 4 API routes (`/api/agents/[id]/evals/cases[/:caseId]`). Re-enables QA008/QA009 in Tier 1. | 1d | T0 |
| **T2** Per-case runner — SSE | Server-side fetch to runner `localhost:3002/test`, parse SSE stream → `{ finalReply, toolCalls[] }`. Module `apps/web/src/lib/evals/run-case.ts`. | 0.5d | none |
| **T3** Check primitives | `substring`, `tool_called`, `llm_judge`. Static FAIL beats judge PASS. | 1d | T2 |
| **T4** Orchestrator | `runRegression(agentId)` — fetches approved cases, runs them sequentially, aggregates results, persists. | 0.5d | T1, T2, T3 |
| **T5** UI — Tier 2 panel | Replaces placeholder card. 4 stat cards, Run button, failure list, expand-to-detail drawer. Streaming progress via polling. | 1.5d | T4 |
| **T6** Run history | Drawer showing last N runs with filter + click-to-load past results. | 0.5d | T4 |

Total: **~5–6 days** of focused work.

## Test case CRUD — UX

Users never write YAML. The drawer form abstracts the framework's
`primitive + flag` shape into 5 plain-English check types.

### Form layout (Add / Edit case)

```
Question                ← textarea, "the Slack message a user would send"

─── Checks ───  the agent's response must satisfy ALL

[ Check 1 ]
  Type:  ▾  Reply must contain text
            Reply must NOT contain text
            Agent must call this MCP tool
            Agent must NOT call this MCP tool
            LLM judges against rubric

  (fields vary by type — see below)
  [Remove]

[ + Add check ]

Status   ▾  approved | proposed
```

### Inputs per check type

| Type | UI affordance |
|------|---------------|
| **Reply must contain text** | Chips multi-input. User adds phrases, hits Enter to commit, × to remove. Case-insensitive substring match. |
| **Reply must NOT contain text** | Same chips multi-input. |
| **Agent must call this MCP tool** | Dropdown auto-populated from the agent's linked MCPs (no typing → no typos). Example: `mcp__redshift-mcp__query`. |
| **Agent must NOT call this MCP tool** | Same dropdown. |
| **LLM judges against rubric** | Two textareas: rubric (instructions to the judge) + optional groundtruth (labeled example answer). Tooltip warns about per-call cost. |

### Mapping to framework primitives

| User picks | Framework shape |
|------------|-----------------|
| Reply must contain text | `{ primitive: substring, target: final_reply, must_contain: [...] }` |
| Reply must NOT contain text | `{ primitive: substring, target: final_reply, must_not_contain: [...] }` |
| Agent must call this MCP tool | `{ primitive: tool_called, must_call: [...] }` |
| Agent must NOT call this MCP tool | `{ primitive: tool_called, must_not_call: [...] }` |
| LLM judges against rubric | `{ primitive: llm_judge, target: final_reply, rubric: "...", groundtruth: "..." }` |

A case can stack multiple checks; case verdict = worst of all checks.

### Onboarding aids

Three layers of help to keep users from staring at a blank form:

1. **Inline hint per field** — "*The Slack message a user would send to the agent.*"
2. **Hover tooltips per check type** — same `?` pattern shipped for Tier 1.
3. **Seed sample cases on agent creation** — 1–2 `proposed` (not `approved`)
   cases pre-filled. User reviews, edits, approves. Empty-state worked example.

## DB schema (T0)

```sql
CREATE TABLE eval_cases (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('approved', 'proposed')),
  question      TEXT NOT NULL,
  checks        TEXT NOT NULL,          -- JSON array of check configs
  approved_by   TEXT,
  approved_at   TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE eval_runs (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  triggered_by  TEXT NOT NULL,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK(status IN ('running', 'done', 'cancelled', 'error')),
  pass_count    INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  suspect_count INTEGER NOT NULL DEFAULT 0,
  infra_count   INTEGER NOT NULL DEFAULT 0,
  total_ms      INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE eval_run_results (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  case_id       TEXT NOT NULL,
  verdict       TEXT NOT NULL CHECK(verdict IN ('PASS', 'FAIL', 'SUSPECT', 'INFRA')),
  time_ms       INTEGER NOT NULL,
  final_reply   TEXT,
  tool_calls    TEXT,                   -- JSON array
  check_results TEXT NOT NULL,          -- JSON per-check results
  judge_reasoning TEXT,
  FOREIGN KEY (run_id)  REFERENCES eval_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (case_id) REFERENCES eval_cases(id) ON DELETE CASCADE
);
```

## Design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Test case storage | **DB tables** | UI-first means DB-first; matches slackhive's existing model |
| LLM judge | **Anthropic SDK directly** (`@anthropic-ai/sdk`) | Cleaner than `claude -p` subprocess; easier deploy, no process management |
| Run mode | **Async** — start a run, UI polls status | Runs can take 30s+; sync would time out / look frozen |
| Concurrency | **Sequential** (v1) | Simpler to debug; can parallelize later if runs are slow |
| Auto-run on config change | **No** | Approved cases are frozen artifacts. Config drift surfaces as warning, never silent re-run |

## Cost safeguards (T3 design)

Each `llm_judge` call hits Claude. Roughly **$0.005–0.05 per case**.
A 20-case all-judge run = **$0.10–1**, per agent per run.

Mitigations:
- **Static FAIL beats judge PASS** — skip judge if a substring or tool_called
  check already failed. Saves money on guaranteed-fail cases.
- **Rubric token cap** — refuse to save cases whose rubric exceeds ~2000 tokens.
- **Per-agent rate limit** (post-v1) — N runs per hour to prevent runaway loops.

## Acceptance criteria

Tier 2 ships when:
1. User can add a test case via the form, with any combination of the 5 check types.
2. Cases persist in DB; survive agent reload.
3. Clicking **Run regression** runs all approved cases, streams progress, persists results.
4. Each failed/suspect case is click-to-expand showing reply + tool trace + judge reasoning.
5. Run history drawer shows past runs; clicking one loads its results into the current view.
6. QA008 + QA009 re-enabled in Tier 1 against the DB-backed corpus.

## Out of scope (v1.5+ deferred)

- Common-rubric presets ("SQL rubric", "RCA rubric")
- Common-substring presets ("don't use SELECT *")
- Parallel case execution
- Slack-mining for auto-`proposed` cases
- Trajectory eval (DeepEval-style sequence assertions)
