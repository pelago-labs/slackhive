/**
 * @fileoverview Replay a failed activity — re-feeds its original message
 * through the agent's live MessageHandler, resuming the existing session.
 *
 * POST /api/activity/[taskId]/replay
 *   Body: { activityId: string }
 *   Returns: 200 { ok: true } or 4xx/502 on error.
 *
 * @module web/api/activity/[taskId]/replay
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { runnerBase } from '@/lib/runner';
import { getTaskWithDetails } from '@slackhive/shared';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { taskId } = await params;
  // activityId is optional. Either way, ONLY the last turn is replayable (and only
  // if it errored) — replaying an older error mid-session is unsafe since the
  // conversation already moved on. A provided activityId must BE the last turn.
  const body = await req.json().catch(() => null) as { activityId?: string } | null;

  const details = await getTaskWithDetails(taskId);
  if (!details) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  // Scope to the caller's accessible agents (admins: null = all). This matches the
  // access-scoped trace the UI renders — so "the last turn" means the same thing on
  // both sides — and stops an editor replaying a turn on an agent outside their scope.
  const accessibleAgentIds = await listAccessibleAgentIds(session.username, session.role);
  const allowed = accessibleAgentIds === null ? null : new Set(accessibleAgentIds);
  const visible = allowed === null
    ? details.activities
    : details.activities.filter(a => allowed.has(a.agentId));
  if (visible.length === 0) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  // activities are chronological (oldest first) → the last accessible one is the latest turn.
  const last = visible[visible.length - 1];
  if (last.status !== 'error') {
    return NextResponse.json({ error: 'Only the last turn can be replayed, and it is not an error' }, { status: 400 });
  }
  if (body?.activityId && body.activityId !== last.id) {
    return NextResponse.json({ error: 'Only the last turn can be replayed' }, { status: 400 });
  }
  const activityId = last.id;

  const upstream = await fetch(`${runnerBase()}/replay-activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activityId }),
  }).catch((err: unknown) => {
    console.error('[api:activity/replay] runner unreachable', err);
    return null;
  });

  if (!upstream) {
    return NextResponse.json({ error: 'runner unreachable' }, { status: 502 });
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => 'upstream failed');
    return NextResponse.json({ error: text }, { status: upstream.status || 502 });
  }

  return NextResponse.json({ ok: true });
}
