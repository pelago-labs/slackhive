/**
 * @fileoverview Smart (LLM) stage for agents in `smart` mode — two cheap-model
 * passes that run ONCE per turn, off the hot path (after the reply is sent):
 *   1. verify — confirms the deterministic (regex) hits and downgrades false
 *      positives in the audit feed (`verifySmartFindings`).
 *   2. detect — independently scans the turn's content for sensitive data the
 *      regex stage MISSES (obfuscated PII, secrets in prose) and flags those
 *      spans `sensitive_llm = 1` so the UI marks them "caught by LLM"
 *      (`detectSmartFindings`). Report-only: never blocks, never redacts.
 *
 * Privacy: the verifier receives only a short redacted sample; the detector must
 * see real content to catch obfuscation, but that content is never persisted —
 * only the privacy-safe category tag + severity are stored on the span.
 *
 * @module runner/tracing/smart-verify
 */

import { getDb, DEFAULT_EVAL_JUDGE_MODEL } from '@slackhive/shared';
import { generateText } from '../backends/generate-text';
import { logger } from '../logger';
import type { SmartCandidate, SmartScanTarget } from './turn-tracer';

const SYSTEM = `You are a security reviewer judging whether flagged items are GENUINELY sensitive (real PII, secrets, or credentials) versus false positives from pattern matching. Reply with ONE line per id in the form "<id>: yes" or "<id>: no". "no" = false positive (e.g. an example/placeholder, a format that isn't actually a secret, a benign keyword). Be conservative: when unsure, answer "yes".`;

/**
 * Parse the model's "<n>: yes|no" verdicts → spanIds the model judged false
 * positive (answered "no"). Conservative: anything not explicitly "no" is kept.
 */
export function parseFalsePositives(reply: string, candidates: SmartCandidate[]): string[] {
  const fps: string[] = [];
  for (const m of reply.matchAll(/(\d+)\s*[:\-]\s*(yes|no)/gi)) {
    if (m[2].toLowerCase() === 'no') {
      const c = candidates[Number(m[1]) - 1];
      if (c) fps.push(c.spanId);
    }
  }
  return fps;
}

/**
 * Verify the turn's flagged findings with one batched LLM call; clear the
 * `sensitive` flag on any the model rules a false positive. Best-effort: any
 * error leaves the deterministic result untouched. Fire-and-forget from the caller.
 */
export async function verifySmartFindings(candidates: SmartCandidate[]): Promise<void> {
  if (candidates.length === 0) return;
  try {
    const list = candidates.map((c, i) => `${i + 1}. [${c.reason}] sample: ${c.sample || '(none)'}`).join('\n');
    const prompt = `Findings:\n${list}\n\nReply one line per number: "<n>: yes" or "<n>: no".`;
    const reply = await generateText(prompt, {
      systemPrompt: SYSTEM,
      claudeModel: DEFAULT_EVAL_JUDGE_MODEL,   // Haiku 4.5 — cheapest/fastest Claude
      // Codex: inherits the configured Codex model (resolveCodexModel) — already a cheap tier.
    });

    const falsePositives = parseFalsePositives(reply, candidates);
    if (falsePositives.length === 0) return;

    const ph = falsePositives.map((_, i) => `$${i + 1}`).join(', ');
    await getDb().query(
      `UPDATE spans SET sensitive = 0, sensitive_severity = NULL WHERE span_id IN (${ph})`,
      falsePositives,
    );
    logger.info('smart-verify: downgraded false positives', { count: falsePositives.length, of: candidates.length });
  } catch (err) {
    logger.warn('smart-verify failed; keeping deterministic flags', { error: (err as Error).message });
  }
}

// ─── Smart detector — finds sensitive data regex MISSES, reports "caught by LLM" ──

const DETECT_SYSTEM = `You are a privacy scanner that finds sensitive data a regex/pattern scanner would MISS. Focus on OBFUSCATED or natural-language forms: phone numbers spelled out ("five five five, oh one two six"), emails written as "name at host dot com", SSNs/card numbers in words, secrets or credentials described in prose, or PII split across a sentence. Ignore values already in a standard machine format (a regex stage handles those).

For each numbered item, reply on ONE line per finding:
  <id> | <kind> | <severity> | <exact excerpt>
where <exact excerpt> is the smallest verbatim substring from that item that contains the sensitive data (copy it EXACTLY as written so it can be located in the text). If an item has nothing, reply "<id> | none". An item may have multiple findings — one line each.
kind ∈ {pii:phone, pii:email, pii:ssn, pii:card, pii:name, pii:address, secret, credential, financial, other}.
severity ∈ {critical, high, medium, low} (secrets/credentials=critical; ssn/card=high; phone/email/name/address=medium).
Be precise — only flag genuine sensitive data.`;

const VALID_SEVERITY = new Set(['critical', 'high', 'medium', 'low']);

export interface SmartFinding { spanId: string; category: string; severity: string; excerpt: string }

/** Top-level category (for color/grouping) from the LLM's fine-grained kind. */
function topCategory(kind: string): 'secret' | 'pii' | 'data' {
  if (kind === 'secret' || kind === 'credential') return 'secret';
  if (kind.startsWith('pii') || kind === 'financial') return 'pii';
  return 'data';
}

/**
 * Parse the detector's "<id> | kind | severity | excerpt" lines into findings
 * keyed back to the scanned span. "none" / unparseable lines are dropped; an id
 * may repeat (multiple findings per item). Severity falls back to `medium`.
 */
export function parseSmartFindings(reply: string, targets: SmartScanTarget[]): SmartFinding[] {
  const out: SmartFinding[] = [];
  for (const line of reply.split('\n')) {
    const m = line.match(/^\s*(\d+)\s*[|:\-]\s*(.+?)\s*$/);
    if (!m) continue;
    const target = targets[Number(m[1]) - 1];
    if (!target) continue;
    const rest = m[2].trim();
    if (/^none\b/i.test(rest) || !rest) continue;
    const parts = rest.split('|').map(p => p.trim());
    const category = (parts[0] || 'other').toLowerCase();
    const severity = VALID_SEVERITY.has((parts[1] || '').toLowerCase()) ? parts[1].toLowerCase() : 'medium';
    const excerpt = parts.slice(2).join(' | ').trim();
    out.push({ spanId: target.spanId, category, severity, excerpt });
  }
  return out;
}

/** Persisted per-span LLM hit: the excerpt + how to display it. */
interface LlmHit { text: string; category: string; label: string; severity: string }

/**
 * Smart detector — scans the turn's content with one batched cheap-model call to
 * catch sensitive data the regex stage missed (obfuscated PII, secrets in prose).
 * For each finding it flags the span `sensitive_llm = 1` (UI: "caught by LLM") and
 * stores the excerpt + type in `sensitive_llm_hits` so the trace can highlight
 * WHICH part is sensitive and of WHAT type. Report-only: never blocks, never
 * redacts. Best-effort — any error is a no-op. Fire-and-forget from the caller.
 *
 * The excerpt is only stored when content capture is on (TRACE_CAPTURE_CONTENT
 * !== '0'); the span content it points into is already persisted under the same
 * flag and governed by the same admin-only reveal.
 */
export async function detectSmartFindings(targets: SmartScanTarget[], guidance?: string): Promise<void> {
  if (targets.length === 0) return;
  try {
    const list = targets.map((t, i) => `${i + 1}. [${t.kind}] ${t.content}`).join('\n\n');
    // Per-agent guidance lets an owner define what counts as sensitive for THIS
    // agent (e.g. "internal project codenames", "patient identifiers").
    const guide = guidance && guidance.trim()
      ? `\n\nFor THIS agent, also treat the following as sensitive when present:\n${guidance.trim()}\n`
      : '';
    const prompt = `Scan each item for sensitive data a regex scanner would miss.${guide}\n\n${list}\n\nReply per the format.`;
    const reply = await generateText(prompt, {
      systemPrompt: DETECT_SYSTEM,
      claudeModel: DEFAULT_EVAL_JUDGE_MODEL,   // Haiku 4.5 — cheapest/fastest Claude
      // Codex: inherits the configured Codex model (already a cheap tier).
    });

    const findings = parseSmartFindings(reply, targets);
    if (findings.length === 0) return;

    const storeExcerpts = process.env.TRACE_CAPTURE_CONTENT !== '0';
    // Group findings per span so each span gets one consolidated update.
    const bySpan = new Map<string, SmartFinding[]>();
    for (const f of findings) {
      const arr = bySpan.get(f.spanId) ?? [];
      arr.push(f);
      bySpan.set(f.spanId, arr);
    }

    const db = getDb();
    for (const [spanId, fs] of bySpan) {
      const reason = [...new Set(fs.map(f => f.category))].join(',');
      const categories = [...new Set(fs.map(f => topCategory(f.category)))].join(',');
      const severity = ['critical', 'high', 'medium', 'low'].find(s => fs.some(f => f.severity === s)) ?? 'medium';
      const hits: LlmHit[] = storeExcerpts
        ? fs.filter(f => f.excerpt).map(f => ({ text: f.excerpt, category: topCategory(f.category), label: f.category, severity: f.severity }))
        : [];
      // Keep any regex tags already present; only fill gaps. Always set the
      // sensitive + sensitive_llm flags so the span surfaces as caught-by-LLM.
      await db.query(
        `UPDATE spans
            SET sensitive = 1,
                sensitive_llm = 1,
                sensitive_categories = COALESCE(NULLIF(sensitive_categories, ''), $1),
                sensitive_reason     = COALESCE(NULLIF(sensitive_reason, ''), $2),
                sensitive_severity   = COALESCE(NULLIF(sensitive_severity, ''), $3),
                sensitive_llm_hits   = $4
          WHERE span_id = $5`,
        [categories, reason, severity, hits.length ? JSON.stringify(hits) : null, spanId],
      );
    }
    logger.info('smart-detect: flagged LLM-only findings', { findings: findings.length, spans: bySpan.size, scanned: targets.length });
  } catch (err) {
    logger.warn('smart-detect failed; deterministic flags unchanged', { error: (err as Error).message });
  }
}
