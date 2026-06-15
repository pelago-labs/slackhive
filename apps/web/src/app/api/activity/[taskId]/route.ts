/**
 * @fileoverview Detail endpoint for one task — returns the task, the full LLM
 * trace (turns → span tree of reasoning / generations / tools / final answer),
 * and session-level rollup analytics for the session/trace view.
 *
 * @module web/api/activity/[taskId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskWithDetails, getSessionTrace, deepLinkForTask, redactSensitive, humanizeTag, type TraceTurn, type SessionRollup } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/activity/[taskId]
 * Returns `{ task, turns: [{ ...turn, spans }], rollup, deepLink }`
 * or 404 if the id is unknown.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<NextResponse> {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    if (session.role === 'viewer') {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const { taskId } = await params;
    const details = await getTaskWithDetails(taskId);
    if (!details) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    // Non-admins can only see tasks that touched an agent they can access.
    const accessibleAgentIds = await listAccessibleAgentIds(session.username, session.role);
    if (accessibleAgentIds !== null) {
      const allowed = new Set(accessibleAgentIds);
      const hasOverlap = details.activities.some(a => allowed.has(a.agentId));
      if (!hasOverlap) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
    }

    // Scope the trace to the caller's accessible agents — a delegated session can
    // span agents the user can't see, so don't return the whole thing on overlap.
    const trace = await getSessionTrace(taskId, accessibleAgentIds);

    // Only admins/superadmins may see raw sensitive values. For everyone else,
    // redact every flagged value in the content server-side (not just visually),
    // so the real value never reaches a non-admin's browser.
    const canSeeRaw = session.role === 'admin' || session.role === 'superadmin';
    const turns = (trace?.turns ?? []).map(t => canSeeRaw ? t : redactTurn(t));

    // Token/cost are billing-adjacent — superadmin only (matches /api/activity/usage).
    const billing = session.role === 'superadmin';

    return NextResponse.json({
      task: details.task,
      turns: billing ? turns : turns.map(stripTurnBilling),
      rollup: billing ? (trace?.rollup ?? null) : stripRollupBilling(trace?.rollup ?? null),
      flows: trace?.flows ?? [],
      deepLink: deepLinkForTask(details.task),
    });
  } catch (err) {
    return apiError('activity-detail', err);
  }
}

/** Redact every flagged value in a turn's content for non-admin viewers — both the
 *  regex matches AND the excerpts the Smart (LLM) detector flagged (which regex
 *  can't re-match), so an obfuscated value never reaches a non-admin's browser. */
function redactTurn(t: TraceTurn): TraceTurn {
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
  const r = (s: string | null) => (s == null ? s : redactSensitive(stripLlm(s), 'all', 'all'));
  return {
    ...t,
    finalAnswer: r(t.finalAnswer),
    spans: t.spans.map(sp => ({ ...sp, input: r(sp.input), output: r(sp.output), reasoning: r(sp.reasoning), sensitiveLlmHits: [] })),
  };
}

/** Zero out billing-adjacent fields (tokens + cost) on a turn + its spans for
 *  non-superadmins. The UI hides token/cost chips when the value is 0/null. */
function stripTurnBilling(t: TraceTurn): TraceTurn {
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
function stripRollupBilling(r: SessionRollup | null): SessionRollup | null {
  if (!r) return r;
  return {
    ...r,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalTokens: 0, costUsd: 0,
    models: r.models.map(m => ({ ...m, tokens: 0 })),
  };
}
