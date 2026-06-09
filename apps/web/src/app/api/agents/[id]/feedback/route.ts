/**
 * @fileoverview Per-agent feedback report for the Overview score + Settings
 * report card. Agent-scoped (any authenticated user via guardAuth), mirroring
 * /api/agents/[id]/usage.
 *
 * GET → { up, down, total, scorePercent, ratingCount, recentRatings }
 * Optional `?window=7d|30d|90d` narrows to a time range (omit for all-time);
 * `?sentiment=up|down` filters the ratings list; `?limit`/`?offset` paginate
 * it (`limit=0` → counts only).
 *
 * @module web/api/agents/[id]/feedback
 */

import { NextRequest, NextResponse } from 'next/server';
import { getFeedbackReport } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { guardAuth } from '@/lib/api-guard';
import { windowFloor } from '@/lib/activity-window';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAuth(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const sp = req.nextUrl.searchParams;
    const limit = sp.get('limit') ? parseInt(sp.get('limit')!, 10) : undefined;
    const offset = sp.get('offset') ? parseInt(sp.get('offset')!, 10) : undefined;
    const since = windowFloor(sp.get('window')); // undefined for missing/invalid → all-time
    const sentimentParam = sp.get('sentiment');
    const sentiment = sentimentParam === 'up' || sentimentParam === 'down' ? sentimentParam : undefined;
    const report = await getFeedbackReport(id, { since, sentiment, limit, offset });
    return NextResponse.json(report);
  } catch (err) {
    return apiError('agents/[id]/feedback', err);
  }
}
