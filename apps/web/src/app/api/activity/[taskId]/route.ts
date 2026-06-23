/**
 * @fileoverview Detail endpoint for one task — returns the task, the full LLM
 * trace (turns → span tree of reasoning / generations / tools / final answer),
 * and session-level rollup analytics for the session/trace view.
 *
 * @module web/api/activity/[taskId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskWithDetails, getSessionTrace, deepLinkForTask } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { redactTurn } from '@/lib/activity-redact';

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

    // Tokens/cost are shown to anyone who can open the trace (editor+): they only
    // reach a session that touched an agent they can access.
    return NextResponse.json({
      task: details.task,
      turns,
      rollup: trace?.rollup ?? null,
      flows: trace?.flows ?? [],
      deepLink: deepLinkForTask(details.task),
    });
  } catch (err) {
    return apiError('activity-detail', err);
  }
}

