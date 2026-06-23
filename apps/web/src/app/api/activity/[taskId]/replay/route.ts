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
import { getTaskWithDetails } from '@slackhive/shared';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const { taskId } = await params;
  const body = await req.json().catch(() => null) as { activityId?: string } | null;
  if (!body?.activityId) {
    return NextResponse.json({ error: 'activityId required' }, { status: 400 });
  }

  const details = await getTaskWithDetails(taskId);
  if (!details) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const activity = details.activities.find(a => a.id === body.activityId);
  if (!activity) return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
  if (activity.status !== 'error') {
    return NextResponse.json({ error: 'Only error activities can be replayed' }, { status: 400 });
  }

  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  const upstream = await fetch(`http://127.0.0.1:${port}/replay-activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activityId: body.activityId }),
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
