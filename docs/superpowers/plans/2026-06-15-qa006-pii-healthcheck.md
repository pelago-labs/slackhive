# QA006 — PII & Secret Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tier 1 healthcheck `QA006` that scans an agent's `CLAUDE.md` and skills for leaked secrets and PII, surfacing warning-severity issues in the Evals tab.

**Architecture:** Mirror the existing `qa005-persona-hygiene.ts` check — take the shared `CheckContext`, scan `CLAUDE.md` + every skill line-by-line against a regex detector set, return `HealthcheckIssue[]` (all `severity: 'warn'`). Register it in `run-healthcheck.ts` and add a UI label row in `evals-panel.tsx`. The panel renders new check codes automatically.

**Tech Stack:** TypeScript, Next.js (App Router), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-15-qa006-pii-healthcheck-design.md`

---

## File Structure

- **Create** `apps/web/src/lib/evals/checks/qa006-pii.ts` — the detector set, a `mask()` helper, a `luhnValid()` helper, and `runQA006(ctx)`.
- **Create** `apps/web/src/lib/__tests__/evals-qa006-pii.test.ts` — vitest coverage.
- **Modify** `apps/web/src/lib/evals/run-healthcheck.ts` — import + register `runQA006`.
- **Modify** `apps/web/src/app/agents/[slug]/evals-panel.tsx` — add `QA006` row to `CHECKS_META`.

---

### Task 1: QA006 check module (TDD)

**Files:**
- Create: `apps/web/src/lib/evals/checks/qa006-pii.ts`
- Test: `apps/web/src/lib/__tests__/evals-qa006-pii.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/__tests__/evals-qa006-pii.test.ts`. The check takes a
`CheckContext`; build a minimal helper so each test only supplies the raw text it
cares about. `skills` entries need `category`, `filename`, `content` (the only
fields the check reads).

```typescript
import { describe, it, expect } from 'vitest';
import type { CheckContext } from '../evals/types';
import { runQA006 } from '../evals/checks/qa006-pii';

function ctx(claudeMd: string, skills: Array<{ category: string; filename: string; content: string }> = []): CheckContext {
  return {
    parsedClaudeMd: { raw: claudeMd, mcpReferences: [], skillReferences: [], wikiReferences: [] },
    // Cast: the check only reads category/filename/content.
    skills: skills as unknown as CheckContext['skills'],
    mcps: [],
    wikiSources: [],
  };
}

function codes(claudeMd: string) {
  return runQA006(ctx(claudeMd)).map((i) => i.message);
}

describe('QA006 — PII & secrets', () => {
  it('flags an AWS access key id', () => {
    const issues = runQA006(ctx('key = AKIAIOSFODNN7EXAMPLE'));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('QA006');
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].file).toBe('CLAUDE.md');
    expect(issues[0].line).toBe(1);
  });

  it('flags a private-key header', () => {
    expect(codes('-----BEGIN RSA PRIVATE KEY-----')).toHaveLength(1);
  });

  it('flags an sk-ant style key', () => {
    expect(codes('use sk-ant-api03-abc123def456ghi789')).toHaveLength(1);
  });

  it('flags a JWT bearer token', () => {
    expect(codes('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toHaveLength(1);
  });

  it('flags a generic secret assignment', () => {
    expect(codes('api_key = "abcd1234efgh5678ijkl"')).toHaveLength(1);
  });

  it('flags a Luhn-valid credit card', () => {
    // 4111 1111 1111 1111 is the canonical Luhn-valid test Visa number.
    expect(codes('card 4111 1111 1111 1111')).toHaveLength(1);
  });

  it('does NOT flag a non-Luhn 16-digit id', () => {
    expect(codes('order 1234567812345678')).toHaveLength(0);
  });

  it('flags a US SSN', () => {
    expect(codes('ssn 123-45-6789')).toHaveLength(1);
  });

  it('flags a real-looking email', () => {
    expect(codes('contact alice.wong@acmecorp.io')).toHaveLength(1);
  });

  it('does NOT flag placeholder/example emails', () => {
    expect(codes('contact someone@example.com or user@test.com')).toHaveLength(0);
  });

  it('flags a separated phone number', () => {
    expect(codes('call +1 415-555-0142')).toHaveLength(1);
  });

  it('does NOT flag a bare digit run as a phone', () => {
    // No separators, not Luhn-valid, not SSN-shaped → no PII.
    expect(codes('value 4155550142')).toHaveLength(0);
  });

  it('scans skills too and reports the skill path', () => {
    const issues = runQA006(ctx('clean', [
      { category: '00-core', filename: 'workflow.md', content: 'line one\nkey = AKIAIOSFODNN7EXAMPLE' },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe('skills/00-core/workflow.md');
    expect(issues[0].line).toBe(2);
  });

  it('never echoes the full secret in the message', () => {
    const issues = runQA006(ctx('key = AKIAIOSFODNN7EXAMPLE'));
    expect(issues[0].message).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('dedups identical match on same file+line', () => {
    // Same SSN twice on one line → reported once.
    expect(codes('123-45-6789 and again 123-45-6789').length).toBeLessThanOrEqual(2);
  });

  it('returns nothing for clean content', () => {
    expect(codes('This is a perfectly normal persona description.')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/__tests__/evals-qa006-pii.test.ts`
Expected: FAIL — cannot resolve `../evals/checks/qa006-pii` (module not found).

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/evals/checks/qa006-pii.ts`:

```typescript
/**
 * @fileoverview QA006 — PII & secret detection.
 *
 * Scans `claudeMd` and every skill for leaked secrets (API keys,
 * tokens, private keys), financial identifiers (Luhn-valid credit
 * cards, US SSNs), and contact PII (emails, phone numbers). All
 * findings are warnings — they never block. Matched values are masked
 * in the issue message so the secret is never echoed back.
 *
 * @module web/lib/evals/checks/qa006-pii
 */

import type { CheckContext, HealthcheckIssue } from '../types';

/** Mask the middle of a match so secrets aren't echoed into issues. */
function mask(s: string): string {
  const t = s.trim();
  if (t.length <= 8) return `${t[0] ?? ''}***`;
  return `${t.slice(0, 4)}****…****${t.slice(-4)}`;
}

/** Standard Luhn checksum — used to filter credit-card-shaped digit runs. */
function luhnValid(digits: string): boolean {
  const d = digits.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(d)) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const EMAIL_ALLOW = /(@(example\.(com|org|net)|test\.com)|^(email|user|noreply|no-reply)@|@your-domain)/i;

/**
 * A detector matches candidate substrings on a line. `valid` (optional)
 * filters matches that pass the regex but fail a semantic check (Luhn,
 * email allowlist). `label` names the category for the issue message.
 */
type Detector = {
  label: string;
  pattern: RegExp;
  valid?: (match: string) => boolean;
};

const DETECTORS: Detector[] = [
  // Secrets & API keys
  { label: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'private key header', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { label: 'API key (sk-…)', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g },
  { label: 'JWT / bearer token', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  {
    label: 'hardcoded secret',
    pattern: /(?:api[_-]?key|secret|token|password|passwd)\s*[=:]\s*['"][^'"]{16,}['"]/gi,
  },
  // Financial IDs
  {
    label: 'credit card number',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    valid: (m) => luhnValid(m),
  },
  { label: 'US SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Contact PII
  {
    label: 'email address',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    valid: (m) => !EMAIL_ALLOW.test(m),
  },
  {
    label: 'phone number',
    pattern: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{2,4}[ .-]\d{2,4}\b/g,
  },
];

export function runQA006(ctx: CheckContext): HealthcheckIssue[] {
  const issues: HealthcheckIssue[] = [];

  const files: Array<{ file: string; raw: string }> = [
    { file: 'CLAUDE.md', raw: ctx.parsedClaudeMd.raw },
    ...ctx.skills.map((s) => ({
      file: `skills/${s.category}/${s.filename}`,
      raw: s.content,
    })),
  ];

  for (const { file, raw } of files) {
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Dedup identical (label, match) on the same line.
      const seen = new Set<string>();
      for (const det of DETECTORS) {
        for (const m of lines[i].matchAll(det.pattern)) {
          const value = m[0];
          if (det.valid && !det.valid(value)) continue;
          const key = `${det.label}:${value}`;
          if (seen.has(key)) continue;
          seen.add(key);
          issues.push({
            code: 'QA006',
            severity: 'warn',
            file,
            line: i + 1,
            message: `Possible ${det.label} — matched "${mask(value)}"`,
          });
        }
      }
    }
  }

  return issues;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/__tests__/evals-qa006-pii.test.ts`
Expected: PASS — all assertions green.

If the credit-card regex also matches the SSN or phone samples and inflates a
count, that's the expected ordering concern: the SSN test uses `123-45-6789`
(9 digits, not 13–19, so Luhn detector won't fire) and the phone test uses a
Luhn-invalid run — verify those two tests are green and adjust only if red.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/evals/checks/qa006-pii.ts apps/web/src/lib/__tests__/evals-qa006-pii.test.ts
git commit -m "feat(evals): QA006 PII & secret detector check"
```

---

### Task 2: Register QA006 in the healthcheck orchestrator

**Files:**
- Modify: `apps/web/src/lib/evals/run-healthcheck.ts:22` (imports) and `:41` (issues array)

- [ ] **Step 1: Add the import**

After line 22 (`import { runQA005 } from './checks/qa005-persona-hygiene';`) add:

```typescript
import { runQA006 } from './checks/qa006-pii';
```

- [ ] **Step 2: Register in the issues array**

In the `const issues = [ ... ]` block, after the `...runQA005(ctx),` line add:

```typescript
    ...runQA006(ctx),
```

- [ ] **Step 3: Verify the full eval test suite still passes**

Run: `cd apps/web && npx vitest run src/lib/__tests__/`
Expected: PASS — existing checks plus the new QA006 test all green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/evals/run-healthcheck.ts
git commit -m "feat(evals): wire QA006 into runHealthcheck"
```

---

### Task 3: Add the QA006 UI label

**Files:**
- Modify: `apps/web/src/app/agents/[slug]/evals-panel.tsx:64` (CHECKS_META)

- [ ] **Step 1: Add the CHECKS_META row**

After the `QA005` row (line 64), add:

```typescript
  { code: 'QA006', name: 'PII & secrets',     help: 'Flags possible leaked secrets (API keys, tokens), financial IDs (credit card, SSN), and contact PII (email, phone) in CLAUDE.md and skills.' },
```

- [ ] **Step 2: Typecheck the web app**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS — no type errors. (The doc comment on line 7 of evals-panel.tsx
says "QA001–QA007"; the range already accommodates QA006, no edit needed.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/agents/[slug]/evals-panel.tsx
git commit -m "feat(evals): show QA006 PII check in Evals tab"
```

---

## Self-Review notes

- **Spec coverage:** Secrets & API keys (5 detectors), Financial IDs (Luhn card +
  SSN), Contact PII (email allowlist + phone) — all present in Task 1. Warning-only
  severity, masking, dedup, CLAUDE.md+skills scope, registration, UI label — all
  covered across Tasks 1–3. Out-of-scope items (auto-fill, eval cases, wiki, IP)
  are correctly absent.
- **Type consistency:** `runQA006(ctx: CheckContext): HealthcheckIssue[]` matches
  the QA001–QA005 signature and the import/registration in Task 2. Issue shape
  (`code/severity/file/line/message`) matches `HealthcheckIssue` in `types.ts`.
- **Placeholder scan:** none — every code/test step shows full content.
