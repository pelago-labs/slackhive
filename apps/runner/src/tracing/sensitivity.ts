/**
 * @fileoverview Sensitivity detection for trace spans — flags when an agent
 * touches something sensitive so the trace + audit feed can surface it.
 *
 * Four categories (all opt-in via the trace recorder, evaluated per tool call):
 *   - `tool`   — the action itself is sensitive (DB access, reading a credential
 *                /.env file, certain MCP servers).
 *   - `data`   — a configurable set of sensitive data keywords (table/column
 *                names like users.email, salary, payment) appears in the args.
 *   - `pii`    — personal data patterns (email, phone, card) in args/results.
 *   - `secret` — API keys / tokens / private keys / password assignments.
 *
 * IMPORTANT: the returned `reason` records only the *category and what kind*
 * matched (e.g. `secret:aws_key`, `pii:email`, `data:salary`) — never the
 * matched value — so the audit trail itself never stores a leaked secret.
 *
 * @module runner/tracing/sensitivity
 */

export type SensitiveCategory = 'tool' | 'pii' | 'data' | 'secret';

export interface SensitiveHit {
  categories: SensitiveCategory[];
  /** Privacy-safe tags, e.g. `["tool:redshift","pii:email"]`. No values. */
  reason: string;
}

/** Tool names / argument paths that are sensitive by nature. */
function sensitiveTool(toolName: string, argsText: string): string | null {
  const name = toolName.toLowerCase();
  if (/redshift|postgres|mysql|database|\bsql\b|bigquery|snowflake/.test(name)) return 'database';
  const extra = (process.env.SENSITIVE_TOOLS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (extra.some(p => name.includes(p))) return 'tool';
  // Credential / key material paths referenced in args (file reads, bash).
  if (/(^|[\s"'/=])(\.env|\.npmrc|credentials|secrets?|id_rsa|id_ed25519|\.pem|\.key|\.ssh\/|\.aws\/|\.kube\/|service[-_]?account)/i.test(argsText)) return 'credentials';
  return null;
}

/** Default sensitive data keywords; override/extend via SENSITIVE_DATA_KEYWORDS. */
const DEFAULT_DATA_KEYWORDS = [
  'email', 'phone', 'ssn', 'social_security', 'password', 'passwd', 'salary',
  'compensation', 'payment', 'credit_card', 'card_number', 'cvv', 'iban',
  'date_of_birth', 'dob', 'passport', 'address', 'tax_id', 'bank_account',
];

function dataKeywords(): string[] {
  const env = (process.env.SENSITIVE_DATA_KEYWORDS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return env.length ? [...DEFAULT_DATA_KEYWORDS, ...env] : DEFAULT_DATA_KEYWORDS;
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// Phone numbers must look like phone numbers — an international `+` prefix or
// separator-formatted groups. A bare run of digits (epoch-ms timestamps, order
// or account IDs, numeric columns) is NOT a phone number, so it isn't flagged.
const PHONE = /(?:\+\d[\d().\- ]{7,16}\d)|(?:\b\d{3}[.\- ]\d{3}[.\- ]\d{4}\b)|(?:\(\d{3}\)[ ]?\d{3}[.\- ]?\d{4})/;
const CARD = /\b(?:\d[ -]?){13,19}\b/;

/** Luhn check to keep card detection from firing on any long digit run. */
function luhnValid(s: string): boolean {
  const digits = s.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

function detectPii(haystack: string): string[] {
  const hits: string[] = [];
  if (EMAIL.test(haystack)) hits.push('email');
  if (PHONE.test(haystack)) hits.push('phone');
  const card = haystack.match(CARD);
  if (card && luhnValid(card[0])) hits.push('card');
  return hits;
}

const SECRET_PATTERNS: { tag: string; re: RegExp }[] = [
  { tag: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { tag: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { tag: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { tag: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { tag: 'private_key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { tag: 'bearer', re: /\bbearer\s+[A-Za-z0-9._-]{20,}/i },
  { tag: 'password', re: /\b(?:pass(?:word|wd)?|secret|api[_-]?key)\s*[=:]\s*['"]?\S{4,}/i },
];

function detectSecrets(haystack: string): string[] {
  const hits: string[] = [];
  for (const { tag, re } of SECRET_PATTERNS) if (re.test(haystack)) hits.push(tag);
  return hits;
}

/**
 * Evaluate one tool call. `args`/`result` may be undefined. Returns null when
 * nothing sensitive matched. Detection runs only when content is available;
 * it's pure (no I/O) and cheap.
 */
/** Cap how much text we scan per tool call so a huge tool result (e.g. a
 * multi-MB DB/file dump) can't stall the Slack streaming loop with regex work.
 * Secrets/PII a tool exposes appear well within the first chunk. */
const SCAN_CAP = 16_000;

export function detectSensitive(
  toolName: string,
  args: string | undefined,
  result: string | undefined,
): SensitiveHit | null {
  const argsText = (args ?? '').slice(0, SCAN_CAP);
  const haystack = `${argsText}\n${(result ?? '').slice(0, SCAN_CAP)}`;
  const categories = new Set<SensitiveCategory>();
  const tags: string[] = [];

  const tool = sensitiveTool(toolName, argsText);
  if (tool) { categories.add('tool'); tags.push(`tool:${tool}`); }

  const lowerArgs = argsText.toLowerCase();
  const dataHits = dataKeywords().filter(k => lowerArgs.includes(k));
  if (dataHits.length) { categories.add('data'); for (const k of dataHits.slice(0, 4)) tags.push(`data:${k}`); }

  const pii = detectPii(haystack);
  if (pii.length) { categories.add('pii'); for (const p of pii) tags.push(`pii:${p}`); }

  const secrets = detectSecrets(haystack);
  if (secrets.length) { categories.add('secret'); for (const s of secrets) tags.push(`secret:${s}`); }

  if (categories.size === 0) return null;
  return { categories: [...categories], reason: [...new Set(tags)].join(', ') };
}

/** Merge several hits (e.g. across a turn's tools) into one. */
export function mergeHits(hits: (SensitiveHit | null)[]): SensitiveHit | null {
  const real = hits.filter((h): h is SensitiveHit => !!h);
  if (!real.length) return null;
  const categories = new Set<SensitiveCategory>();
  const tags = new Set<string>();
  for (const h of real) { h.categories.forEach(c => categories.add(c)); h.reason.split(', ').forEach(t => t && tags.add(t)); }
  return { categories: [...categories], reason: [...tags].join(', ') };
}
