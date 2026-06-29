/**
 * @fileoverview Server-side redaction + billing-gating helpers for the session
 * trace detail endpoint. Kept out of the route file so they can be unit-tested
 * (Next.js route modules may only export HTTP handlers / config).
 *
 * @module web/lib/activity-redact
 */

import { redactSensitive, humanizeTag, type TraceTurn, type SessionRollup } from '@slackhive/shared';

/** Redact every flagged value in a turn's content for non-admin viewers — both the
 *  regex matches AND the excerpts the Smart (LLM) detector flagged (which regex
 *  can't re-match), so an obfuscated value never reaches a non-admin's browser. */
export function redactTurn(t: TraceTurn): TraceTurn {
  // All LLM excerpts across the turn — redacted from every field (the offending
  // value may also appear in the final answer / a sibling span).
  const llmHits = t.spans.flatMap(sp => sp.sensitiveLlmHits ?? []);
  const stripLlm = (s: string) => llmHits.reduce(
    (acc, h) => (h.text ? acc.split(h.text).join(`[redacted:${humanizeTag(h.label).label}]`) : acc),
    s,
  );
  // Strip the verbatim LLM excerpts FIRST, then run regex redaction. If regex ran
  // first it could rewrite part of an excerpt to [redacted:…], so the excerpt would
  // no longer match verbatim and its remainder would leak.
  // Level 'all' masks every flagged range — including the high_entropy heuristic and
  // any range a >16KB window-merge mislabeled — so no value reaches a non-admin. (The
  // noise of masking keyword/path LABELS is acceptable here; the admin-side UI, which
  // sees raw content, separately renders those labels as plain text in SensitiveMark.)
  const r = (s: string | null) => (s == null ? s : redactSensitive(stripLlm(s), 'all', 'all'));
  return {
    ...t,
    finalAnswer: r(t.finalAnswer),
    // Redact every served text field — incl. statusMessage (tool error text), which
    // can carry a flagged value or an LLM-only excerpt just like input/output.
    spans: t.spans.map(sp => ({ ...sp, input: r(sp.input), output: r(sp.output), reasoning: r(sp.reasoning), statusMessage: r(sp.statusMessage), sensitiveLlmHits: [] })),
  };
}

/** Zero out billing-adjacent fields (tokens + cost) on a turn + its spans for
 *  non-superadmins. The UI hides token/cost chips when the value is 0/null. */
export function stripTurnBilling(t: TraceTurn): TraceTurn {
  return {
    ...t,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    spans: t.spans.map(sp => ({
      ...sp,
      inputTokens: null, outputTokens: null, reasoningTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
    })),
  };
}

/** Same for the session rollup (drops per-model token counts too). */
export function stripRollupBilling(r: SessionRollup | null): SessionRollup | null {
  if (!r) return r;
  return {
    ...r,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalTokens: 0, costUsd: 0,
    models: r.models.map(m => ({ ...m, tokens: 0 })),
  };
}
