/**
 * @fileoverview Client-side sensitive-text locator for the trace view. The
 * sensitivity monitor (runner/tracing/sensitivity.ts) records only privacy-safe
 * category tags, never the matched value — so to *show* which text in a captured
 * tool arg/result triggered the flag, we re-run the same detection patterns here
 * on the already-stored content and return labelled segments to highlight.
 *
 * Patterns are kept in sync with runner/tracing/sensitivity.ts.
 *
 * @module web/lib/sensitive-highlight
 */

export type SensCategory = 'pii' | 'secret' | 'data' | 'tool';

/** A run of text, flagged with its category when it matched a detector. */
export interface SensSegment { text: string; cat: SensCategory | null; label: string | null }

/** Cap scanned length so a multi-MB dump can't stall the render with regex work. */
const SCAN_CAP = 20_000;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(?:\+\d[\d().\- ]{7,16}\d)|(?:\b\d{3}[.\- ]\d{3}[.\- ]\d{4}\b)|(?:\(\d{3}\)[ ]?\d{3}[.\- ]?\d{4})/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const CRED = /(\.env|\.npmrc|credentials|secrets?|id_rsa|id_ed25519|\.pem|\.key|\.ssh\/|\.aws\/|\.kube\/|service[-_]?account)/gi;

const SECRET_PATTERNS: { tag: string; re: RegExp }[] = [
  { tag: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { tag: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { tag: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { tag: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { tag: 'private_key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { tag: 'bearer', re: /\bbearer\s+[A-Za-z0-9._-]{20,}/gi },
  { tag: 'password', re: /\b(?:pass(?:word|wd)?|secret|api[_-]?key)\s*[=:]\s*['"]?\S{4,}/gi },
];

const DATA_KEYWORDS = [
  'email', 'phone', 'ssn', 'social_security', 'password', 'passwd', 'salary',
  'compensation', 'payment', 'credit_card', 'card_number', 'cvv', 'iban',
  'date_of_birth', 'dob', 'passport', 'address', 'tax_id', 'bank_account',
];
const DATA_RE = new RegExp(`\\b(?:${DATA_KEYWORDS.join('|')})\\b`, 'gi');

interface Range { start: number; end: number; cat: SensCategory; label: string }

/** Luhn check so card detection doesn't fire on any long digit run. */
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

function collect(re: RegExp, cat: SensCategory, label: string, text: string, out: Range[], validate?: (m: string) => boolean): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (!validate || validate(m[0])) out.push({ start: m.index, end: m.index + m[0].length, cat, label });
    if (out.length > 2_000) break; // sanity cap
  }
}

/**
 * Split `body` into segments, flagging the substrings that match a sensitivity
 * detector. Non-overlapping; earlier/secret matches win when ranges collide.
 * Returns a single unflagged segment when nothing matches.
 */
export function markSensitive(str: string): SensSegment[] {
  const text = str.length > SCAN_CAP ? str.slice(0, SCAN_CAP) : str;
  const ranges: Range[] = [];

  // Secrets first so they outrank a weaker overlapping match (e.g. a key that
  // also looks like a card run).
  for (const { tag, re } of SECRET_PATTERNS) collect(re, 'secret', `secret:${tag}`, text, ranges);
  collect(EMAIL, 'pii', 'pii:email', text, ranges);
  collect(PHONE, 'pii', 'pii:phone', text, ranges);
  collect(CARD, 'pii', 'pii:card', text, ranges, luhnValid);
  collect(CRED, 'tool', 'tool:credentials', text, ranges);
  collect(DATA_RE, 'data', 'data', text, ranges);

  if (ranges.length === 0) return [{ text: str, cat: null, label: null }];

  // Keep non-overlapping ranges, secrets-first via stable sort on (start, secret?).
  ranges.sort((a, b) => a.start - b.start || (a.cat === 'secret' ? -1 : 1));
  const kept: Range[] = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.start >= lastEnd) { kept.push(r); lastEnd = r.end; }
  }

  const segs: SensSegment[] = [];
  let cursor = 0;
  for (const r of kept) {
    if (r.start > cursor) segs.push({ text: text.slice(cursor, r.start), cat: null, label: null });
    segs.push({ text: text.slice(r.start, r.end), cat: r.cat, label: r.label });
    cursor = r.end;
  }
  // Tail (including any content past SCAN_CAP) is shown unflagged.
  if (cursor < str.length) segs.push({ text: str.slice(cursor), cat: null, label: null });
  return segs;
}

export const SENS_COLOR: Record<SensCategory, string> = {
  pii:    '#dc2626',
  secret: '#b45309',
  data:   '#0891b2',
  tool:   '#2563eb',
};
