/**
 * @fileoverview Smart (LLM) verification of sensitivity findings — the optional
 * second stage for agents in `smart` mode. Deterministic detection already ran
 * inline and flagged spans; this runs ONCE per turn, off the hot path (after the
 * reply is sent), batching all of the turn's findings into a single cheap-model
 * call to confirm them and downgrade false positives in the audit feed.
 *
 * Privacy: the model receives only a short redacted sample (first chars + length)
 * and the category tags — never the full value.
 *
 * @module runner/tracing/smart-verify
 */

import { getDb, DEFAULT_EVAL_JUDGE_MODEL } from '@slackhive/shared';
import { generateText } from '../backends/generate-text';
import { logger } from '../logger';
import type { SmartCandidate } from './turn-tracer';

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
