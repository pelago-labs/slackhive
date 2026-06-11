/**
 * @fileoverview Single source of truth for sensitivity detection AND highlight
 * segmentation, shared by the runner (which flags spans) and the web trace UI
 * (which highlights the matched text). Keeping one copy means a span the server
 * flags and the substring the UI highlights can never drift apart.
 *
 * Pure — no I/O, no DB — so the web client can import it without pulling node deps.
 *
 * Privacy: detection returns only category + kind tags (e.g. `pii:email`), never
 * the matched value. The UI re-derives match offsets from already-stored content.
 *
 * @module shared/sensitivity
 */

export type SensitiveCategory = 'tool' | 'pii' | 'data' | 'secret';

export interface SensitiveHit {
  categories: SensitiveCategory[];
  /** Privacy-safe tags, e.g. `pii:email, secret:aws_key`. No values. */
  reason: string;
}

/** Cap scanned length so a multi-MB dump can't stall detection/highlighting. */
export const SCAN_CAP = 16_000;

// Patterns are NON-global so the boolean detectors can use `.test()`/`.match()`
// safely; collect() clones them with the global flag for offset segmentation.
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// Phone numbers must carry a real phone signal — an international `+` country
// code or a parenthesized area code. A bare separator-grouped 10-digit number
// (`123-456-7890`) is NOT flagged: order/reference numbers look identical, so
// requiring `+`/parens avoids flagging arbitrary grouped numbers as phones.
const PHONE = /(?:\+\d[\d().\- ]{7,16}\d)|(?:\(\d{3}\)[ ]?\d{3}[.\- ]?\d{4})/;
const CARD = /\b(?:\d[ -]?){13,19}\b/;
/** Credential/key path tokens (for highlighting a path inside content). */
const CRED = /(\.env|\.npmrc|credentials|secrets?|id_rsa|id_ed25519|\.pem|\.key|\.ssh\/|\.aws\/|\.kube\/|service[-_]?account)/i;

const SECRET_PATTERNS: { tag: string; re: RegExp }[] = [
  { tag: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { tag: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { tag: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { tag: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { tag: 'private_key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { tag: 'bearer', re: /\bbearer\s+[A-Za-z0-9._-]{20,}/i },
  // Credentials embedded in a connection string: scheme://user:password@host
  // (postgres/mysql/mongodb/redis/amqp/…). Captures the user:pass pair.
  { tag: 'connection_string', re: /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/i },
  // password=/pwd=/secret=/api_key= assignments — `[\w-]*` prefix so env-style
  // keys (DB_PASSWORD, PGPASSWORD, MYSQL_PWD) are caught despite the underscore.
  { tag: 'password', re: /\b[\w-]*(?:pass(?:word|wd)?|pwd|secret|api[_-]?key)\s*[=:]\s*['"]?\S{4,}/i },
];

const DEFAULT_DATA_KEYWORDS = [
  'email', 'phone', 'ssn', 'social_security', 'password', 'passwd', 'salary',
  'compensation', 'payment', 'credit_card', 'card_number', 'cvv', 'iban',
  'date_of_birth', 'dob', 'passport', 'address', 'tax_id', 'bank_account',
];

/** Data keywords incl. operator-configured ones (server only — reads env). */
function dataKeywords(): string[] {
  const env = (process.env.SENSITIVE_DATA_KEYWORDS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return env.length ? [...DEFAULT_DATA_KEYWORDS, ...env] : DEFAULT_DATA_KEYWORDS;
}

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

function detectPii(haystack: string): string[] {
  const hits: string[] = [];
  if (EMAIL.test(haystack)) hits.push('email');
  if (PHONE.test(haystack)) hits.push('phone');
  const card = haystack.match(CARD);
  if (card && luhnValid(card[0])) hits.push('card');
  return hits;
}

function detectSecrets(haystack: string): string[] {
  const hits: string[] = [];
  for (const { tag, re } of SECRET_PATTERNS) if (re.test(haystack)) hits.push(tag);
  return hits;
}

/** Tool names / argument paths that are sensitive by nature. */
function sensitiveTool(toolName: string, argsText: string): string | null {
  const name = toolName.toLowerCase();
  if (/redshift|postgres|mysql|database|\bsql\b|bigquery|snowflake/.test(name)) return 'database';
  const extra = (process.env.SENSITIVE_TOOLS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (extra.some(p => name.includes(p))) return 'tool';
  if (/(^|[\s"'/=])(\.env|\.npmrc|credentials|secrets?|id_rsa|id_ed25519|\.pem|\.key|\.ssh\/|\.aws\/|\.kube\/|service[-_]?account)/i.test(argsText)) return 'credentials';
  return null;
}

/** Evaluate one tool call (name + args + result). Returns null when nothing matched. */
export function detectSensitive(toolName: string, args: string | undefined, result: string | undefined): SensitiveHit | null {
  const argsText = (args ?? '').slice(0, SCAN_CAP);
  const haystack = `${argsText}\n${(result ?? '').slice(0, SCAN_CAP)}`;
  const categories = new Set<SensitiveCategory>();
  const tags: string[] = [];

  const tool = sensitiveTool(toolName, argsText);
  if (tool) { categories.add('tool'); tags.push(`tool:${tool}`); }

  // Data-keyword scan is scoped to ARGS (column/table names) — meaningful there,
  // noisy in free text (see detectInText).
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

/**
 * Detect sensitive DATA in free text — the model's own output / final answer.
 * Scans only the VALUE-based detectors (PII + secrets). Data-keyword substring
 * matching is intentionally NOT applied to prose: words like "email" or "address"
 * appear constantly in normal answers and would flood the audit feed with false
 * positives. (The web highlighter mirrors this via the `text` scope.)
 */
export function detectInText(text: string | undefined): SensitiveHit | null {
  const hay = (text ?? '').slice(0, SCAN_CAP);
  if (!hay) return null;
  const categories = new Set<SensitiveCategory>();
  const tags: string[] = [];

  const pii = detectPii(hay);
  if (pii.length) { categories.add('pii'); for (const p of pii) tags.push(`pii:${p}`); }

  const secrets = detectSecrets(hay);
  if (secrets.length) { categories.add('secret'); for (const s of secrets) tags.push(`secret:${s}`); }

  if (categories.size === 0) return null;
  return { categories: [...categories], reason: [...new Set(tags)].join(', ') };
}

/** Merge several hits (e.g. across a turn's tools + generations) into one. */
export function mergeHits(hits: (SensitiveHit | null)[]): SensitiveHit | null {
  const real = hits.filter((h): h is SensitiveHit => !!h);
  if (!real.length) return null;
  const categories = new Set<SensitiveCategory>();
  const tags = new Set<string>();
  for (const h of real) { h.categories.forEach(c => categories.add(c)); h.reason.split(', ').forEach(t => t && tags.add(t)); }
  return { categories: [...categories], reason: [...tags].join(', ') };
}

// ── Highlight segmentation (web trace UI) ────────────────────────────────────

/** A run of text, flagged with its category when it matched a detector. */
export interface SensSegment { text: string; cat: SensitiveCategory | null; label: string | null }

/** Highlight scope: `all` for tool I/O (matches detectSensitive); `text` for the
 *  model's own output (PII + secrets only — matches detectInText). */
export type SensScope = 'all' | 'text';

interface Range { start: number; end: number; cat: SensitiveCategory; label: string }

/** On overlap the higher-priority category wins (secret > pii > tool > data). */
const PRIO: Record<SensitiveCategory, number> = { secret: 3, pii: 2, tool: 1, data: 0 };

// Highlight uses the DEFAULT keyword list (the client can't see server env), with
// word boundaries so a keyword can be span-highlighted.
const HL_DATA_RE = new RegExp(`\\b(?:${DEFAULT_DATA_KEYWORDS.join('|')})\\b`, 'gi');

function collect(re: RegExp, cat: SensitiveCategory, label: string | ((m: string) => string), text: string, out: Range[], validate?: (m: string) => boolean): void {
  const g = re.global ? re : new RegExp(re.source, re.flags + 'g');
  g.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (m[0].length === 0) { g.lastIndex++; continue; }
    if (!validate || validate(m[0])) out.push({ start: m.index, end: m.index + m[0].length, cat, label: typeof label === 'function' ? label(m[0]) : label });
    if (out.length > 2_000) break; // sanity cap
  }
}

/**
 * Split `str` into segments, flagging substrings that match a detector. Mirrors
 * detectSensitive/detectInText so the highlight matches what the server flagged:
 * `all` scope = PII + secrets + data + cred (tool I/O); `text` scope = PII +
 * secrets only (the model's prose). Non-overlapping; higher-priority wins on tie.
 */
export function markSensitive(str: string, scope: SensScope = 'all'): SensSegment[] {
  const text = str.length > SCAN_CAP ? str.slice(0, SCAN_CAP) : str;
  const ranges: Range[] = [];

  for (const { tag, re } of SECRET_PATTERNS) collect(re, 'secret', `secret:${tag}`, text, ranges);
  collect(EMAIL, 'pii', 'pii:email', text, ranges);
  collect(PHONE, 'pii', 'pii:phone', text, ranges);
  collect(CARD, 'pii', 'pii:card', text, ranges, luhnValid);
  if (scope === 'all') {
    collect(CRED, 'tool', 'tool:credentials', text, ranges);
    collect(HL_DATA_RE, 'data', m => `data:${m.toLowerCase()}`, text, ranges);
  }

  if (ranges.length === 0) return [{ text: str, cat: null, label: null }];

  ranges.sort((a, b) => a.start - b.start || PRIO[b.cat] - PRIO[a.cat] || (b.end - b.start) - (a.end - a.start));
  const kept: Range[] = [];
  let lastEnd = -1;
  for (const r of ranges) if (r.start >= lastEnd) { kept.push(r); lastEnd = r.end; }

  const segs: SensSegment[] = [];
  let cursor = 0;
  for (const r of kept) {
    if (r.start > cursor) segs.push({ text: text.slice(cursor, r.start), cat: null, label: null });
    segs.push({ text: text.slice(r.start, r.end), cat: r.cat, label: r.label });
    cursor = r.end;
  }
  if (cursor < str.length) segs.push({ text: str.slice(cursor), cat: null, label: null });
  return segs;
}

export const SENS_COLOR: Record<SensitiveCategory, string> = {
  pii:    '#dc2626',
  secret: '#b45309',
  data:   '#0891b2',
  tool:   '#2563eb',
};

/** Broad category → display word (for the chip/popover header). */
export const CAT_LABEL: Record<string, string> = {
  pii: 'Personal info', secret: 'Secret', data: 'Sensitive data', tool: 'Sensitive action',
};

// Human-readable labels for the privacy-safe `category:detail` tags.
const DETAIL_LABELS: Record<string, string> = {
  'tool:database':      'Database access',
  'tool:credentials':   'Credential / key file',
  'tool:tool':          'Sensitive tool',
  'pii:email':          'Email address',
  'pii:phone':          'Phone number',
  'pii:card':           'Card number',
  'secret:openai_key':  'OpenAI key',
  'secret:aws_key':     'AWS key',
  'secret:github_token':'GitHub token',
  'secret:slack_token': 'Slack token',
  'secret:private_key': 'Private key',
  'secret:bearer':      'Bearer token',
  'secret:password':    'Password / secret',
  'secret:connection_string': 'DB connection string',
};
const DATA_ACRONYMS = new Set(['ssn', 'dob', 'cvv', 'iban', 'tax_id']);

/** Turn a `category:detail` tag into a category (for color/icon) + readable label. */
export function humanizeTag(tag: string): { category: string; label: string } {
  const [category, ...rest] = tag.split(':');
  const detail = rest.join(':');
  if (DETAIL_LABELS[tag]) return { category, label: DETAIL_LABELS[tag] };
  if (category === 'data' && detail) {
    const label = DATA_ACRONYMS.has(detail)
      ? detail.toUpperCase().replace('_', ' ')
      : detail.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    return { category, label };
  }
  return { category, label: detail || category };
}
