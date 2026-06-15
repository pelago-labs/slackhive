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

/**
 * Mask a match so the secret/PII is never echoed into an issue. Reveals
 * only the last 4 characters (enough to locate it alongside the file +
 * line) — short structured ids like SSNs must not be reconstructable.
 */
function mask(s: string): string {
  const t = s.trim();
  if (t.length <= 4) return '****';
  return `****…${t.slice(-4)}`;
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

// Allowlist placeholder addresses. Domain branches are anchored to the
// end of the (full) email match so `bob@example.com.evil.io` and
// `bob@your-domain-is-real.com` are NOT suppressed — only the literal
// placeholder domains are. Local-part branch is anchored to the start.
const EMAIL_ALLOW = /(@(example\.(com|org|net)|test\.com|your-domain(\.[a-z]+)?)$|^(email|user|noreply|no-reply)@)/i;

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
    // Constrained to the US 3-3-4 shape (or a parenthesized area code),
    // optionally with a `+<country>` prefix. Looser group sizes matched
    // ISO dates (`2026-06-15`) and dotted versions (`12.34.56`).
    label: 'phone number',
    pattern: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?\d{3}[ .-]?\d{4}|\d{3}[ .-]\d{3}[ .-]\d{4})\b/g,
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
      // Track claimed [start, end) spans on this line. Detectors run in
      // priority order (secrets → financial → SSN → email → phone); a
      // later, lower-signal detector skips any span already claimed, so a
      // credit card or SSN isn't also reported as a phone number.
      const claimed: Array<[number, number]> = [];
      for (const det of DETECTORS) {
        for (const m of lines[i].matchAll(det.pattern)) {
          const value = m[0];
          if (det.valid && !det.valid(value)) continue;
          const start = m.index ?? 0;
          const end = start + value.length;
          if (claimed.some(([s, e]) => start < e && end > s)) continue;
          claimed.push([start, end]);
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
