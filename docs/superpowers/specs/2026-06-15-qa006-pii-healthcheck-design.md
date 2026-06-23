# QA006 — PII & Secret Detection (Tier 1 healthcheck)

**Date:** 2026-06-15
**Status:** Approved — ready for implementation plan

## Problem

Agent prompts (`CLAUDE.md`) and skills are authored by anyone on the team and
can accidentally include sensitive data — leaked API keys, credit-card numbers,
SSNs, or personal contact info — either hand-written or pasted from real data.
Today nothing flags this. The Evals tab already runs a Tier 1 static healthcheck
(QA001–QA005); we want a PII/secret detector to surface the same way.

Inspired by NVIDIA skillspector, but intentionally lightweight: a focused set of
high-signal regex detectors, not a comprehensive PII engine.

## Decisions (from brainstorming)

- **Approach:** Static healthcheck check only (`QA006`). No auto-fill guard, no
  scanning of stored eval test cases — those were considered and dropped.
- **Severity:** Warning only. PII findings never block; they surface as yellow
  warnings in the Evals tab.
- **Detectors:** Secrets & API keys, Financial IDs (credit card + SSN), Contact
  PII (email + phone). Network identifiers (IP addresses) explicitly excluded as
  too noisy.
- **Scope of scan:** `CLAUDE.md` + every skill, matching QA005. Wiki sources,
  MCP descriptions, and eval cases are out of scope.

## Architecture

QA006 slots into the existing healthcheck framework with no new data flow. It
mirrors `qa005-persona-hygiene.ts` exactly: takes the shared `CheckContext`,
scans `CLAUDE.md` + skills line by line against a regex set, returns
`HealthcheckIssue[]`.

Footprint:

1. **New file** `apps/web/src/lib/evals/checks/qa006-pii.ts` — exports
   `runQA006(ctx: CheckContext): HealthcheckIssue[]`.
2. **Register** in `apps/web/src/lib/evals/run-healthcheck.ts` — import `runQA006`
   and add `...runQA006(ctx)` to the `issues` array.
3. **UI label** in `apps/web/src/app/agents/[slug]/evals-panel.tsx` — add one row
   to `CHECKS_META`:
   `{ code: 'QA006', name: 'PII & secrets', help: 'Flags possible leaked secrets (API keys, tokens), financial IDs (credit card, SSN), and contact PII (email, phone) in CLAUDE.md and skills.' }`.
   The panel groups and renders new check codes automatically.
4. **Test** `apps/web/src/lib/__tests__/evals-qa006-pii.test.ts` (vitest).

## Detectors

Each detector is `{ pattern: RegExp, label: string }` emitting `severity: 'warn'`.
Scanned per line so each issue carries a 1-indexed `line`, like QA005.

### Secrets & API keys

- AWS access key id — `AKIA[0-9A-Z]{16}`
- Private-key header — `-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----`
- OpenAI/Anthropic-style key — `sk-(?:ant-)?[A-Za-z0-9_-]{16,}`
- Bearer token / JWT — `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
- Generic secret assignment —
  `(?:api[_-]?key|secret|token|password|passwd)\s*[=:]\s*['"][^'"]{16,}['"]`
  (case-insensitive)

### Financial IDs

- Credit card — a 13–19 digit run (optionally separated by spaces/hyphens),
  **validated with the Luhn checksum**. Non-Luhn runs are ignored to cut false
  positives on long order/ticket ids.
- US SSN — `\b\d{3}-\d{2}-\d{4}\b`

### Contact PII

- Email — standard address pattern, with a **placeholder allowlist** skipped:
  domains `example.com`/`.org`/`.net`, `test.com`, `your-domain*`, and local
  parts `email@`, `user@`, `noreply@`, `no-reply@`. Allowlisted addresses do not
  fire.
- Phone — US/international shapes that **require separators or a leading `+`**
  (e.g. `+1 415-555-0100`, `(415) 555-0100`), so bare digit runs don't match.

## Behavior & edge cases

- **Masking:** issue messages never echo the full match. They show the category
  and a masked snippet (e.g. `AKIA****…****`, last 4 of a card). A small
  `mask(s)` helper keeps first/last 2–4 chars and stars the middle.
- **Dedup:** the same match string on the same `file` + `line` is reported once.
- **No blocking:** every issue is `warn`; the summary's `errors` count is
  unaffected by QA006.

## Testing

`evals-qa006-pii.test.ts` (vitest), calling `runQA006` with hand-built
`CheckContext` objects:

- One positive per detector — a realistic sample that **should** fire (AWS key,
  `sk-ant-...`, JWT, private-key header, secret assignment, Luhn-valid card,
  SSN, real-looking email, separated phone).
- False-positive guards — `someone@example.com` does **not** fire; a 16-digit
  non-Luhn order id does **not** fire; a bare 10-digit number does **not** fire
  as a phone; a clean skill yields zero issues.
- Masking — assert the full secret never appears in any issue `message`.

## Out of scope

- Auto-fill / suggest-cases PII filtering.
- Scanning stored eval test-case questions and rubrics.
- Wiki sources, MCP server descriptions.
- IP-address / network-identifier detection.
- Name / physical-address detection (too noisy for regex).
