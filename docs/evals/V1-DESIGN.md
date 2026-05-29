# QA Framework v1 — Design

**One-line summary:** An agent-agnostic test framework for **any Claude Code agent** built on slackhive, providing (Tier 1) deterministic static healthcheck of `CLAUDE.md` / `skills/` / `wiki/` / `mcps.yaml`, and (Tier 2) test-case creation tooling + regression-eval runner via composable primitives. Reuses slackhive's `/test` SSE endpoint and invokes `claude -p` as judge.

> **For readers in slackhive's repo:** This document uses **Pelago's agents** as concrete examples throughout — Gilfoyle (NLQ→SQL), Nelson (incident debugging), Dinesh (PR writer). The framework itself is agent-agnostic. Wherever you see specific MCP tool names (`mcp__redshift-mcp__query`, `mcp__datadog__search_logs`) or paths (`agents-dev/gilfoyle/`), treat them as **Pelago's reference implementation**, not framework requirements. You'll configure the framework for your own agent's shape via the corpus YAML.

---

## Problem

Agent configurations drift, and Claude Code agents are no different — a CLAUDE.md edit or a new skill can silently break behavior that worked yesterday. Today, evaluating an agent typically requires:

- Reading hundreds of lines of `CLAUDE.md`, `skills/`, `wiki/`, `mcps.yaml` by hand
- Hand-running scenarios to see what regressed
- No automated way to catch config bugs (dangling skill refs, undeclared MCPs, overlapping triggers, untested skills)
- No way to know if test cases still pass after a config change — without writing per-agent Python scripts that don't share infrastructure

Most agent teams either skip eval (and ship regressions silently) or build one-off eval scripts per agent (and can't share infra across teams). This framework fills the gap with: (1) deterministic static checks, (2) a composable YAML-based regression runner against the live agent in slackhive's `/test` sandbox.

**Pelago's specific context** (drives v1 priorities — others' will differ):
- Three agents with different correctness shapes: Gilfoyle (SQL output), Nelson (RCA narrative), Dinesh (PR diff — deferred)
- Gilfoyle has an existing Python eval (`eval/run.py`) that's SQL-specific and doesn't generalize
- A peer "QA-agent" is planned to review work products at runtime — its own eval must be ready before it ships
- v1 must not block on a not-yet-ready sandbox env — runs against local slackhive today

---

## Approach

Two tiers sharing one loader, one corpus format, one verdict set:

```
agent dir (CLAUDE.md, skills/, wiki/, mcps.yaml)
       │
       ▼
   ┌──────────┐
   │  Loader  │  → typed AgentConfig + corpus
   └────┬─────┘
        │
        ├──────▶ Tier 1: Healthcheck   (no LLM, no infra, ~5s)
        │         9 deterministic linters → eslint-style report
        │
        └──────▶ Tier 2: Regression eval  (uses slackhive /test, ~30s/case)
                  POST /test → SSE trace → composable check primitives → verdict
```

**No per-agent adapter classes.** The framework ships generic *check primitives* (`substring`, `tool_called`, `llm_judge`) and *trace selectors* (`final_reply`, `tool_calls`). Each agent's `tests.yaml` declares which primitives apply and how — pure YAML composition, no agent names in framework code.

Tier 1 is the cheap layer. Runs on every CLAUDE.md save. Catches boring bugs that would otherwise burn Tier 2's expensive LLM calls.

Tier 2 is the rigorous layer. Runs on-demand at deploy time, eventually nightly in CI.

---

## Prerequisites

To run this framework, a slackhive consumer needs:

| Requirement | Why | Verify |
|---|---|---|
| Slackhive ≥ TBD (with `/test` SSE endpoint) | Tier 2 invokes `POST /test` to run the agent in its sandbox | `curl localhost:3002/test -X POST` returns expected error shape |
| Node ≥ 20 | TypeScript runtime + native `fetch` for SSE | `node --version` |
| `claude` CLI installed and authenticated | Tier 2's `llm_judge` primitive spawns `claude -p` as subprocess | `claude --version` |
| Filesystem access to an agent directory | Loader reads `CLAUDE.md` / `skills/` / `wiki/` / `mcps.yaml` + the corpus | Just `ls` the dir |

No DB, no auth tokens beyond what `claude` CLI already needs, no Slack API credentials (unless using v1.5 Slack mining). Standalone package.

---

## Tier 1 — Static healthcheck (the linter)

Pure file reads + parse + string checks. **No LLM. No infra.** Same role ESLint plays for JavaScript.

### The 9 checks

| Code | Catches |
|---|---|
| **QA001** | MCP coverage — CLAUDE.md/skills reference an MCP tool not declared in `mcps.yaml` |
| **QA002** | Cross-refs — links to `wiki/X.md` or `skills/Y.md` that doesn't exist |
| **QA003** | Trigger conflicts — two Step 0 triggers match the same Slack input |
| **QA004** | Skill overlap — two skills have ≥0.7 Jaccard similarity on description |
| **QA005** | Persona hygiene — banned patterns (`force-push`, `--no-verify`, `rm -rf`, "ignore previous", system-override markers, "always agree") |
| **QA006** | Tool prefix correctness — `notion-fetch` should be `mcp__notion__notion-fetch` |
| **QA007** | Wiki coverage — skill cites a wiki entity that has no corresponding file |
| **QA008** | Test coverage — every skill and Step 0 trigger has ≥1 case in `tests.yaml` |
| **QA009** | Corpus shape — `checks:` block fields match case fields (e.g., `contains_from: must_contain` requires every case to have a `must_contain` field) |

**Output:** eslint-style — `severity / code / file:line / message`. Exit code 1 if any ERROR. `--json` flag for CI consumers.

---

## Tier 2 — Regression eval (the integration test)

Takes a `tests.yaml` corpus, POSTs each case to slackhive's `/test` SSE endpoint, parses the response trace, applies composable check primitives, writes a report.

```
tests.yaml ──► runner ──► POST /test (slackhive)
                              │
                              ▼
                       SSE trace (reply + tool calls)
                              │
                              ▼
                  ┌──────── check pipeline ────────┐
                  │ each `checks:` entry:          │
                  │  • selector → grabs text/list  │
                  │  • primitive → returns verdict │
                  └────────────────┬───────────────┘
                                   ▼
                          verdict (worst of all checks)
                                   │
                                   ▼
                         runs/<ts>/report.{md,json}
```

### Verdict set

`PASS / FAIL / SUSPECT / INFRA`

- **PASS** — all checks clean
- **FAIL** — any deterministic check failed OR judge says diverged with citable reason
- **SUSPECT** — judge had nothing to judge (selector empty), or judge flagged uncertain
- **INFRA** — tool errored, runner died, /test unreachable. Not the agent's fault.

Case verdict = **worst of all checks**. All checks must PASS for case to PASS.

### Static FAIL beats judge PASS

If any deterministic primitive (`substring`, `tool_called`) fails, the case is FAIL — regardless of judge verdict. High-confidence substring beats LLM flake. Same convention as Gilfoyle's `eval/run.py`.

### Empty-selector handling

| Primitive | Selector empty → |
|---|---|
| `substring` | **FAIL** — agent didn't produce the artifact we wanted to check |
| `tool_called` | **FAIL** — agent didn't do any tool work |
| `llm_judge` | **SUSPECT** — judge had nothing to judge; needs human review |

### Test case lifecycle

Test cases are **human-curated artifacts**, not auto-generated outputs. Two states, one field:

```yaml
- id: T001
  status: approved        # or "proposed"
  question: ...
  must_contain: [...]
  groundtruth_sql: ...
  approved_by: kai
  approved_at: 2026-05-15
```

Rules:
- `slackhive qa run` executes **only `approved`** cases by default; `--include-proposed` overrides for debugging
- Once `status: approved`, the file is **immutable to tooling** — humans edit, framework never does
- Future Slack-mining (v1.5) writes new cases as `proposed`; human review flips to `approved`
- Config change invalidating an approved case → framework **warns**, does not silently rewrite
- The framework treats the **YAML file at its path as the source of truth at run time**. How that file gets there — manual edit, version-controlled in a repo, materialized from slackhive's DB, synced from somewhere — is the consumer's choice. Pelago happens to version-control via git in `agents-dev/`; an open-source slackhive user might manage agents entirely through the web UI

### Auto-update behavior

| Layer | Re-runs on CLAUDE.md/skills/wiki change | Why |
|---|---|---|
| **Tier 1** (healthcheck) | ✅ Yes, automatically | Reads files only — re-running shows current state. Ship as pre-commit hook + CI on PR + `--watch` flag |
| **Tier 2** (regression eval) | ❌ Never auto-runs | Approved cases are frozen artifacts. Config drift surfaces as warning — human resolves |

---

## The check primitive model (how one runner evals many agents)

**No named adapters.** The framework ships generic primitives; each agent's corpus composes them.

### Selectors (2 in v1)

Stable identifiers, not position-dependent:

| Selector | What it returns |
|---|---|
| `final_reply` | The agent's last user-facing message |
| `tool_calls` | The full list of tool calls in order |

Why only two: position-based selectors (`last_query`, `last_tool_input`) are brittle — adding an unrelated "post to Slack" call at the end of an agent's flow would break them. The two above are always present, always stable.

Most artifacts authors care about end up in `final_reply`: SQL blocks (Gilfoyle quotes its query), PR URLs (Dinesh's reply links), Notion ticket links, RCA narratives (Nelson's whole output). `tool_calls` covers "did agent X call tool Y?" trajectory checks.

### Primitives (3 in v1)

| Primitive | Use | Verdict shape |
|---|---|---|
| `substring` | "selected text must contain X / must not contain Y" | PASS/FAIL deterministic |
| `tool_called` | "tool_calls must include T (or must not include U)" | PASS/FAIL deterministic |
| `llm_judge` | "selected text semantically matches groundtruth per rubric" | PASS/FAIL/SUSPECT via `claude -p` |

### Example — Pelago's Gilfoyle agent (SQL-shape)

The agent emits a SQL query; the framework checks substrings on the reply and asks the judge to compare semantically against canonical SQL.

```yaml
# agents-dev/gilfoyle/eval/tests.yaml  ← Pelago path; your path is wherever you keep your agent dir
checks:
  - primitive: substring
    target: final_reply
    contains_from: must_contain          # pull from each case
    not_contains_from: must_not_contain

  - primitive: llm_judge
    target: final_reply
    rubric: ./rubric.md
    case_fields: [question, groundtruth_sql, must_contain, must_not_contain, note]

cases:
  - id: T001
    status: approved
    approved_by: kai
    approved_at: 2026-05-15
    question: How many engaged sessions in May 2025?
    must_contain:
      - "session_duration_s > 10"
      - "unique_pvid > 1"
    must_not_contain:
      - "session_flag_view_pdp"
    groundtruth_sql: |
      SELECT COUNT(DISTINCT CASE
                 WHEN session_duration_s > 10 OR unique_pvid > 1
                 THEN ds_session_id
               END) AS engaged_sessions
      FROM core.t1_bi_session_events_unified_view
      WHERE session_time_start_utc8 >= '2025-05-01'
        AND session_time_start_utc8 <  '2025-06-01';
```

### Example — Pelago's Nelson agent (trajectory-shape)

Different agent shape entirely: the framework verifies which tools the agent called, what its RCA narrative mentions, and asks the judge to evaluate the narrative against a canonical RCA.

```yaml
# agents-dev/nelson/eval/tests.yaml  ← Pelago path
checks:
  - primitive: tool_called
    must_call_from: expected_tools

  - primitive: substring
    target: final_reply
    contains_from: expected_substrings

  - primitive: llm_judge
    target: final_reply
    rubric: ./rubric.md
    case_fields: [question, expected_tools, expected_substrings, groundtruth_rca]

cases:
  - id: N001
    status: approved
    approved_by: oncall
    approved_at: 2026-05-15
    question: Why did booking BKG-xyz123 fail at 14:23 UTC yesterday?
    expected_tools:
      - mcp__datadog__search_logs
      - mcp__redshift-mcp__query
    expected_substrings:
      - "payment service timeout"
      - "BKG-xyz123"
    groundtruth_rca: |
      Payment service timed out at 14:23 UTC...
```

Same framework, same primitives, two completely different agent shapes. **New agent shape = compose primitives in YAML. No framework change.**

### Schema-aware judge via rubric files

Each `llm_judge` check references a rubric markdown file. The rubric is the judge's system prompt and explicitly documents the corpus schema so the judge knows what each case field means.

**Example rubric — SQL evaluation (used by Pelago's Gilfoyle):**

```markdown
# SQL Judge Rubric

You evaluate an agent's SQL response against a canonical answer.
The case includes:
- `groundtruth_sql`: human-verified canonical SQL
- `must_contain`: substrings that MUST appear (already checked statically)
- `must_not_contain`: substrings that MUST NOT appear (already checked statically)
- `note`: human context — why this case exists

Compare semantically: same table? same filters? same aggregation?
Don't execute either SQL — data drifts daily.

Return JSON: {"verdict": "PASS"|"FAIL", "reasoning": "..."}.
Static `must_*` failures are reported separately — don't double-count them here.
```

Rubrics live with the agent (e.g. `<your-agent-dir>/eval/rubric.md`), not in the framework. Authors tune rubrics without touching TypeScript.

---

## Where this fits with the peer QA-agent

This framework is **(b)** in the two-track picture:

|  | (b) This framework | (a) Peer QA-agent |
|---|---|---|
| Subject under test | The agent itself | The work product the agent produced |
| When it runs | Deploy time / on-demand / nightly | Runtime, per PR / per output |
| Form | TypeScript package | Real Claude agent (peer to Gilfoyle/Nelson/Dinesh) |
| Status | This plan | Separate workstream |

(b) lands first because (a)'s verdicts cannot be trusted in production without (b) evaluating (a) the same way (b) evaluates everyone else.

---

## Future web UI (v1.5+)

Slackhive's web app gets a **new per-agent "QA" tab**, distinct from the existing "Test" tab. Test mode is exploratory; QA mode is structured regression. Different mental model → different surface.

Three primary flows (full design in `V1.5-UX.md`, to be written):

1. **Run eval** — pick agent → click run → SSE-streamed progress → verdict summary
2. **Triage failure** — case detail view: question + trace + check results + judge verdict + actions (*"mark expected"*, *"file bug"*, *"mark flaky"*)
3. **Approve proposed case** (depends on Slack mining v2.5) — review mined Q&A → enter groundtruth → preview run → approve → backend writes YAML to repo

Plus an **org-level QA dashboard** later (v2): cross-agent pass rates, coverage trends, calibration log.

What this implies for the v1 framework:
- Runner exposes progress as SSE — so web can stream Flow 1
- Verdict report must be machine-parseable JSON (`--json` flag)
- Status flips need a programmatic write path — decision deferred to v2.5

---

## Key design decisions

| Decision | Choice | Why we rejected the alternative |
|---|---|---|
| Repo placement | `slackhive/packages/qa/` (monorepo package) | Standalone repo creates import-boundary problems when slackhive's runner/web embeds QA later |
| Language | TypeScript | Python (Gilfoyle's eval) — but slackhive is TS, runner imports this directly later |
| LLM judge transport | `claude -p` subprocess | Anthropic SDK adds dep + auth plumbing; subprocess is Gilfoyle's proven pattern |
| **Adapter design** | **Generic primitives, no named adapters** | **Named adapters (`gilfoyle.ts`, `nelson.ts`) hardcode agent shapes into framework — bad open-source story** |
| Selector set | 2: `final_reply` + `tool_calls` | Position-based (`last_query`, `last_tool_input`) are brittle to behavior changes |
| Skill overlap detection | Jaccard on tokenized descriptions | Embedding similarity needs API call; Jaccard is sufficient |
| Healthcheck output | eslint-style + `--json` | Custom format — eslint is the lingua franca CI parses |
| Verdict set | PASS / FAIL / SUSPECT / INFRA | Binary PASS/FAIL — SUSPECT captures "judge inconclusive"; INFRA prevents flake polluting agent verdicts |
| Static vs judge precedence | Static FAIL beats judge PASS | Judge wins → LLM flake creates false PASS that ship regressions |
| Case status storage | YAML field at a filesystem path | DB-backed v1 — premature; slackhive consumers may not have a DB. Web UI in v1.5+ can write the same YAML shape via an HTTP API |
| Per-check severity | **Dropped for v1** | Every check FAILs on violation; simpler. Re-add if "informational checks" become real need |
| Corpus format | YAML | JSON — too verbose for human authoring |
| Agent invocation | Reuse slackhive `/test` SSE | Build own harness → duplicates session/MCP plumbing |
| Testing infra | Reuse slackhive's vitest config + SSE test helpers | Bespoke setup — would diverge from rest of monorepo |
| Trigger model v1 | On-demand CLI | Nightly cron — depends on a not-yet-ready sandbox env (Pelago context) |
| Web UI placement | New per-agent "QA" tab (v1.5) | Bolted into "Test" — different mental model, would confuse both |

---

## What's in v1 / what's not

### In v1
- All 9 Tier 1 healthcheck checks (QA001–QA009)
- Tier 2 end-to-end: SSE client, trace parser, 2 selectors, 3 primitives, judge subprocess, report writer (md + json)
- Composable corpus shape — primitives configured per-corpus in `tests.yaml`
- Test case state machine — `status: approved | proposed`
- Per-agent rubric files (`./rubric.md` referenced from corpus)
- One proof case each: T001 for Gilfoyle, N001 for Nelson
- CLI: `slackhive qa healthcheck <dir>` and `slackhive qa run <dir>`
- Reuses slackhive's vitest config + shared SSE test infra

### Not in v1 (and why)

| Excluded | Why |
|---|---|
| Web UI ("QA" tab) | v1.5 — full UX in `V1.5-UX.md`. Framework v1 exposes JSON + SSE so web can be built without rewrite |
| Peer QA-agent itself | Separate plan, consumes this harness for its own eval |
| Position-based selectors (`last_query`, `last_tool_input`) | Brittle to agent behavior changes; add if/when a real case requires them |
| Per-check severity field | Dropped for v1 simplicity; re-add when "informational checks" become a real need |
| Slack mining → `proposed` cases | **v1.5**. Generates draft cases from real Slack threads where the agent was tagged. Human still authors groundtruth. Reduces cold-start friction when authoring a corpus for a new agent. |
| Trajectory eval (DeepEval / Ragas style sequence assertions) | Tier 3; needs Tier 1+2 to prove out first |
| Synthetic test-case generation from CLAUDE.md/skills | Tier 4 |
| Org-level QA dashboard | v2 — after per-agent QA tab lands |
| Nightly cron + Slack digest channel | Depends on sandbox; wrap CLI as scheduled job once available |
| Embedding-based skill overlap | Jaccard first; revisit if false-positive rate is high |
| Boss-agent / multi-turn eval | Out of scope — different problem shape |
| Programmatic status-flip API (proposed → approved via backend) | Deferred to v2.5 with Slack mining; v1 status changes happen via git PR |

---

## Acceptance criteria

V1 is done when the **Pelago validation harness** passes — i.e. the framework is exercised end-to-end against Pelago's two reference agents (`agents-dev/gilfoyle/` and `agents-dev/nelson/`). The same shape of acceptance run will work for any OSS consumer with their own two reference agents.

Specifically:

1. `slackhive qa healthcheck` reports **0 issues** on clean configs.
2. `slackhive qa healthcheck` reports **≥1 issue** on a seeded `bad-agent/` fixture for each of QA001–QA009.
3. `slackhive qa run` produces **PASS** on Gilfoyle T001 (composable `checks:` block in corpus).
4. `slackhive qa run` produces **PASS** on Nelson N001 (composable `checks:` block in corpus).
5. `runs/<ts>/report.md` is human-readable and contains 5 fields per case: `id / verdict / static signal / judge verdict / judge reasoning`.
6. `slackhive qa healthcheck --json | jq` and `slackhive qa run --json | jq` work for CI / future web consumers.
7. **Approved cases are never auto-modified** — framework warns on config drift but never edits a case file directly. Verified by inspecting `tests.yaml` mtime after a run.
8. The two reference cases (T001, N001) use **only** the 2 selectors + 3 primitives shipped in v1 — no special-case framework code.

---

## Where to read next

**Generic (any reader):**
- **To execute:** `V1-PLAN.md` — task-by-task implementation, 16 tasks across 8 milestones (to be refreshed for this design)
- **For the web UI design:** `V1.5-UX.md` (to be written after this design is locked)
- **For the two-track (b) vs (a) context:** the "Where this fits" section above

**Pelago-specific (internal context):**
- **Existing Gilfoyle Python eval as inspiration:** `agents-dev/gilfoyle/eval/README.md` and `eval/run.py` — the SQL-shape eval pattern this framework generalizes
- **Pelago agents under test:** `agents-dev/gilfoyle/`, `agents-dev/nelson/`, `agents-dev/dinesh/`
