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
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface SensitiveHit {
  categories: SensitiveCategory[];
  /** Parsed `category:detail` tags (deduped). */
  tags: string[];
  /** Privacy-safe tags joined, e.g. `pii:email, secret:aws_key`. No values. */
  reason: string;
  /** Highest severity across this hit's tags. */
  severity: Severity;
}

/** Cap scanned length so a multi-MB dump can't stall detection/highlighting. */
export const SCAN_CAP = 16_000;

// ── Severity model (skillspector-style scoring) ──────────────────────────────

export const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#0891b2',
};

// Specific tag overrides; everything else falls back to its category severity.
const TAG_SEVERITY: Record<string, Severity> = {
  'pii:card': 'high', 'pii:ssn': 'high', 'pii:iban': 'high',
  'pii:email': 'medium', 'pii:phone': 'medium',
  'tool:credentials': 'medium',
};
const CATEGORY_SEVERITY: Record<SensitiveCategory, Severity> = {
  secret: 'critical', pii: 'medium', data: 'low', tool: 'low',
};

/** Severity for a single `category:detail` tag. */
export function severityForTag(tag: string): Severity {
  return TAG_SEVERITY[tag] ?? CATEGORY_SEVERITY[tag.split(':')[0] as SensitiveCategory] ?? 'low';
}

/** Highest severity across a set of tags. */
export function maxSeverity(tags: string[]): Severity {
  let best: Severity = 'low';
  for (const t of tags) { const s = severityForTag(t); if (SEVERITY_RANK[s] > SEVERITY_RANK[best]) best = s; }
  return best;
}

function buildHit(categories: Set<SensitiveCategory>, tags: string[]): SensitiveHit | null {
  if (categories.size === 0) return null;
  const uniq = [...new Set(tags)];
  return { categories: [...categories], tags: uniq, reason: uniq.join(', '), severity: maxSeverity(uniq) };
}

// ── Patterns ─────────────────────────────────────────────────────────────────
// Patterns are NON-global so the boolean detectors can use `.test()`/`.match()`
// safely; collect() clones them with the global flag for offset segmentation.

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// Phone numbers must carry a real phone signal — an international `+` country
// code or a parenthesized area code. A bare separator-grouped 10-digit number
// (`123-456-7890`) is NOT flagged: order/reference numbers look identical.
const PHONE = /(?:\+\d[\d().\- ]{7,16}\d)|(?:\(\d{3}\)[ ]?\d{3}[.\- ]?\d{4})/;
const CARD = /\b(?:\d[ -]?){13,19}\b/;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
/** Credential/key path tokens (for highlighting a path inside content). */
const CRED = /(\.env|\.npmrc|credentials|secrets?|id_rsa|id_ed25519|\.pem|\.key|\.ssh\/|\.aws\/|\.kube\/|service[-_]?account)/i;

const SECRET_PATTERNS: { tag: string; re: RegExp }[] = [
  { tag: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { tag: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { tag: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { tag: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { tag: 'slack_webhook', re: /\bhooks\.slack\.com\/services\/[A-Za-z0-9_/]+/ },
  { tag: 'stripe_key', re: /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { tag: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { tag: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  // Require a 2nd service-account marker near the type field so arbitrary JSON
  // that merely contains "type":"service_account" isn't flagged. Bounded window,
  // both field orders; the literal anchors keep it ReDoS-safe.
  { tag: 'gcp_sa', re: /"type"\s*:\s*"service_account"[\s\S]{0,500}"(?:private_key|client_email)"\s*:|"(?:private_key|client_email)"\s*:[\s\S]{0,500}"type"\s*:\s*"service_account"/ },
  { tag: 'private_key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { tag: 'bearer', re: /\bbearer\s+[A-Za-z0-9._-]{20,}/i },
  // Credentials embedded in a URL: scheme://user:password@host — DB protocols
  // (postgres/mysql/mongodb/redis/amqp/…) AND http(s) basic-auth.
  { tag: 'connection_string', re: /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/i },
  // password=/pwd=/secret=/api_key= assignments, incl. JSON ("password":"…") and
  // env-style keys (DB_PASSWORD, MYSQL_PWD, PGPASSWORD). The key segment must end
  // at a real boundary — start, or a `_`/`-` separator — so ordinary words that
  // merely END in a trigger token (bypass, compass, encompass, surpass) are NOT
  // flagged. PGPASSWORD is letter-joined like those, so it's listed explicitly.
  { tag: 'password', re: /(?<![a-z0-9])(?:pgpassword|(?:[a-z0-9]+[_-])?(?:pass(?:word|wd)?|pwd|secret|api[-_]?key))["']?\s*[=:]\s*['"]?\S{4,}/i },
];

// Generic high-entropy token (random API tokens). Candidate then entropy-validated
// so it doesn't fire on prose, hex hashes, or single-case strings.
const HIGH_ENTROPY = /[A-Za-z0-9+/_=-]{40,}/;
function shannon(s: string): number {
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  let e = 0;
  for (const k in freq) { const p = freq[k] / s.length; e -= p * Math.log2(p); }
  return e;
}
function looksHighEntropy(tok: string): boolean {
  if (tok.length < 40) return false;
  const hasLower = /[a-z]/.test(tok), hasUpper = /[A-Z]/.test(tok), hasDigit = /[0-9]/.test(tok), hasB64 = /[+/_=-]/.test(tok);
  // Skip low-variety tokens (pure-hex hashes, single-case ids): require base64
  // special chars OR a mixed-case-with-digit token.
  if (!(hasB64 || (hasLower && hasUpper && hasDigit))) return false;
  return shannon(tok) >= 4.2;
}
function hasHighEntropyToken(hay: string): boolean {
  const re = /[A-Za-z0-9+/_=-]{40,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hay)) !== null) { if (looksHighEntropy(m[0])) return true; }
  return false;
}

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
  if (SSN.test(haystack)) hits.push('ssn');
  if (IBAN.test(haystack)) hits.push('iban');
  return hits;
}

function detectSecrets(haystack: string): string[] {
  const hits: string[] = [];
  for (const { tag, re } of SECRET_PATTERNS) if (re.test(haystack)) hits.push(tag);
  if (hasHighEntropyToken(haystack)) hits.push('high_entropy');
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

/**
 * Classify a tool call as an outbound **sink** (where data leaves the agent) and
 * return its kind, else null. Used for exfiltration flows (Phase: deep tracing):
 * sensitive data appearing in a sink's ARGS is data leaving the agent.
 * - `web`   — WebFetch / WebSearch
 * - `tool`  — a tool whose NAME carries an outbound action verb (send/post/upload/create/…)
 * - `shell` — Bash/exec whose command runs a network client (curl/wget/nc/ssh/scp/rsync)
 *
 * Heuristic: classified by an outbound *verb*, not by being an MCP tool. A blanket
 * `mcp__*` rule (or matching bare platform names like "slack") flagged read-only
 * tools (`mcp__db__query`, `get_slack_thread`) as sinks, producing spurious
 * exfiltration flows. The trade-off: an egress MCP tool whose name lacks a known
 * verb won't be detected as a sink.
 */
export function egressKind(toolName: string, argsText = ''): 'web' | 'tool' | 'shell' | null {
  const n = (toolName || '').toLowerCase();
  const a = argsText.toLowerCase();
  if (/^web_?fetch$|^web_?search$/.test(n)) return 'web';
  if (/\b(bash|shell|exec|terminal|command|run_command)\b/.test(n) && /\b(curl|wget|nc|netcat|ssh|scp|rsync|telnet)\b/.test(a)) return 'shell';
  if (/(^|[._-])(http|fetch|request|upload|send|post|email|mail|webhook|sms|notify|publish|create|update|insert|write|dispatch)/.test(n)) return 'tool';
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

  return buildHit(categories, tags);
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

  return buildHit(categories, tags);
}

/** Merge several hits (e.g. across a turn's tools + generations) into one. */
export function mergeHits(hits: (SensitiveHit | null)[]): SensitiveHit | null {
  const real = hits.filter((h): h is SensitiveHit => !!h);
  if (!real.length) return null;
  const categories = new Set<SensitiveCategory>();
  const tags = new Set<string>();
  for (const h of real) { h.categories.forEach(c => categories.add(c)); h.tags.forEach(t => tags.add(t)); }
  return buildHit(categories, [...tags]);
}

// ── Highlight segmentation (web trace UI) ────────────────────────────────────

/** A run of text, flagged with its category when it matched a detector. */
export interface SensSegment { text: string; cat: SensitiveCategory | null; label: string | null; llm?: boolean }

/** An extra substring to highlight (e.g. an excerpt the Smart/LLM detector found
 *  that regex can't match). `label` is the kind tag (e.g. `pii:phone`). */
export interface ExtraMark { text: string; cat: SensitiveCategory; label: string }

/** Highlight scope: `all` for tool I/O (matches detectSensitive); `text` for the
 *  model's own output (PII + secrets only — matches detectInText). */
export type SensScope = 'all' | 'text';

interface Range { start: number; end: number; cat: SensitiveCategory; label: string; llm?: boolean }

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
  return markSensitiveWith(str, scope, []);
}

/** Escape a literal string for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Like {@link markSensitive}, but also highlights each `extras` substring (e.g. an
 * excerpt the Smart/LLM detector flagged that regex can't match). Extra marks take
 * priority on overlap so an LLM finding is never hidden by a weaker regex match.
 */
export function markSensitiveWith(str: string, scope: SensScope, extras: ExtraMark[]): SensSegment[] {
  const text = str.length > SCAN_CAP ? str.slice(0, SCAN_CAP) : str;
  const kept = scanRanges(text, scope, extras);
  if (kept.length === 0) return [{ text: str, cat: null, label: null }];

  const segs: SensSegment[] = [];
  let cursor = 0;
  for (const r of kept) {
    if (r.start > cursor) segs.push({ text: text.slice(cursor, r.start), cat: null, label: null });
    segs.push({ text: text.slice(r.start, r.end), cat: r.cat, label: r.label, llm: r.llm });
    cursor = r.end;
  }
  // Note: for highlighting, the tail past SCAN_CAP is shown unflagged (display only).
  // Redaction must NOT do this — it uses collectRangesFull to scan the whole string.
  if (cursor < str.length) segs.push({ text: str.slice(cursor), cat: null, label: null });
  return segs;
}

/** Collect the kept (non-overlapping, priority-resolved) match ranges in `text`.
 *  Callers bound `text` to SCAN_CAP; {@link collectRangesFull} windows longer input. */
function scanRanges(text: string, scope: SensScope, extras: ExtraMark[]): Range[] {
  const ranges: Range[] = [];
  for (const { tag, re } of SECRET_PATTERNS) collect(re, 'secret', `secret:${tag}`, text, ranges);
  collect(HIGH_ENTROPY, 'secret', 'secret:high_entropy', text, ranges, looksHighEntropy);
  collect(EMAIL, 'pii', 'pii:email', text, ranges);
  collect(PHONE, 'pii', 'pii:phone', text, ranges);
  collect(CARD, 'pii', 'pii:card', text, ranges, luhnValid);
  collect(SSN, 'pii', 'pii:ssn', text, ranges);
  collect(IBAN, 'pii', 'pii:iban', text, ranges);
  if (scope === 'all') {
    collect(CRED, 'tool', 'tool:credentials', text, ranges);
    collect(HL_DATA_RE, 'data', m => `data:${m.toLowerCase()}`, text, ranges);
  }
  // LLM excerpts: literal, case-insensitive; flagged `llm` so the UI can mark them.
  for (const ex of extras) {
    if (!ex.text) continue;
    const before = ranges.length;
    collect(new RegExp(escapeRe(ex.text), 'gi'), ex.cat, ex.label, text, ranges);
    for (let i = before; i < ranges.length; i++) ranges[i].llm = true;
  }
  if (ranges.length === 0) return [];

  // Extra (llm) marks win overlap ties so an LLM finding is never masked by regex.
  ranges.sort((a, b) => a.start - b.start || (b.llm ? 1 : 0) - (a.llm ? 1 : 0) || PRIO[b.cat] - PRIO[a.cat] || (b.end - b.start) - (a.end - a.start));
  const kept: Range[] = [];
  let lastEnd = -1;
  for (const r of ranges) if (r.start >= lastEnd) { kept.push(r); lastEnd = r.end; }
  return kept;
}

/** Kept ranges over the FULL string (no SCAN_CAP truncation), windowing long input
 *  so a match near a boundary is still caught. Used by redaction, which must never
 *  emit an unscanned tail verbatim. A match can appear truncated in one window and
 *  whole in the next (and high-entropy/URL matches are unbounded in length), so
 *  overlapping ranges are UNIONed — never dropped — to cover the full extent. */
function collectRangesFull(str: string, scope: SensScope): Range[] {
  if (str.length <= SCAN_CAP) return scanRanges(str, scope, []);
  // Windows overlap so a match crossing a boundary is caught whole in ≥1 window;
  // the union-merge then stitches the truncated copy from the adjacent window.
  const STEP = Math.max(1, Math.floor(SCAN_CAP / 2));
  const all: Range[] = [];
  for (let i = 0; i < str.length; i += STEP) {
    for (const r of scanRanges(str.slice(i, i + SCAN_CAP), scope, [])) all.push({ ...r, start: r.start + i, end: r.end + i });
    if (i + SCAN_CAP >= str.length) break;
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const merged: Range[] = [];
  for (const r of all) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) { if (r.end > last.end) last.end = r.end; } // overlap → extend, don't drop the tail
    else merged.push({ ...r });
  }
  return merged;
}

/** How much an agent's outbound reply is masked when redaction is on. */
export type RedactionLevel = 'secrets' | 'pii' | 'all';

/**
 * Mask sensitive values in `text`, replacing each match with `[redacted:<label>]`.
 * The `level` controls scope:
 *  - `secrets` — secrets + high/critical values (keys, cards, SSNs); emails/phones kept.
 *  - `pii`     — the above PLUS all PII (emails, phones, …).
 *  - `all`     — every flagged value (also data keywords / tool/cred paths).
 * Returns text unchanged when nothing qualifies.
 */
export function redactSensitive(text: string, scope: SensScope = 'text', level: RedactionLevel = 'secrets'): string {
  if (!text) return text;
  // Scan the WHOLE string (collectRangesFull windows past SCAN_CAP) so a value
  // beyond the highlight cap is never emitted unmasked.
  const ranges = collectRangesFull(text, scope);
  if (ranges.length === 0) return text;
  let out = '', cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) out += text.slice(cursor, r.start);
    const sev = severityForTag(r.label);
    // high_entropy is a heuristic guess, not a confirmed secret — auto-stripping it
    // from replies corrupts benign long tokens (data URIs, hashes), so only mask it
    // at the explicit `all` level.
    const heuristic = r.label === 'secret:high_entropy';
    const masked =
      level === 'all' ? true :
      level === 'pii' ? (!heuristic && (r.cat === 'secret' || r.cat === 'pii' || sev === 'critical' || sev === 'high')) :
      /* secrets */     (!heuristic && (r.cat === 'secret' || sev === 'critical' || sev === 'high'));
    out += masked ? `[redacted:${humanizeTag(r.label).label}]` : text.slice(r.start, r.end);
    cursor = r.end;
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
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
  'pii:ssn':            'Social Security number',
  'pii:iban':           'IBAN',
  'secret:openai_key':  'OpenAI key',
  'secret:aws_key':     'AWS key',
  'secret:github_token':'GitHub token',
  'secret:slack_token': 'Slack token',
  'secret:slack_webhook':'Slack webhook',
  'secret:stripe_key':  'Stripe key',
  'secret:google_api_key':'Google API key',
  'secret:jwt':         'JWT',
  'secret:gcp_sa':      'GCP service account',
  'secret:private_key': 'Private key',
  'secret:bearer':      'Bearer token',
  'secret:password':    'Password / secret',
  'secret:connection_string': 'Credentials in URL',
  'secret:high_entropy': 'High-entropy secret',
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
