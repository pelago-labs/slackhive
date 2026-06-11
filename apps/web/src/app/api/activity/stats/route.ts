/**
 * @fileoverview Aggregate stats for the activity dashboard —
 * per-column counts and per-agent in-progress counts.
 *
 * Cheap enough to compute on each request for now; no caching.
 *
 * @module web/api/activity/stats
 */

import { NextRequest, NextResponse } from 'next/server';
import { listTasks, countInProgressByAgent, getAgentRollup, type ActivityFilter } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { windowFloor } from '@/lib/activity-window';

export const dynamic = 'force-dynamic';

/**
 * GET /api/activity/stats?window=24h&agent=&user=
 *
 * Returns `{ counts: {active, recent, errored}, inProgressByAgent }`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    if (session.role === 'viewer') {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const accessibleAgentIds = await listAccessibleAgentIds(session.username, session.role);

    const { searchParams } = new URL(req.url);
    const filter: ActivityFilter = {
      agentId: searchParams.get('agent') ?? undefined,
      userId: searchParams.get('user') ?? undefined,
      since: windowFloor(searchParams.get('window')),
      accessibleAgentIds: accessibleAgentIds ?? undefined,
    };

    // Fetch up to 500 per column — plenty for the badge number. Filters apply
    // so the count matches the kanban the user is looking at.
    // Per-agent aggregate analytics — only when a single agent is selected
    // (and the caller can access it). Powers the analytics panel on /activity.
    const agentId = filter.agentId;
    const canSeeAgent = !!agentId && (accessibleAgentIds === null || accessibleAgentIds.includes(agentId));

    const [active, recent, errored, inProgressByAgent, agentRollup] = await Promise.all([
      listTasks('active', filter, 500, null),
      listTasks('recent', filter, 500, null),
      listTasks('errored', filter, 500, null),
      countInProgressByAgent(accessibleAgentIds ?? undefined),
      canSeeAgent ? getAgentRollup({ agentId: agentId!, since: filter.since }) : Promise.resolve(null),
    ]);

    return NextResponse.json({
      counts: {
        active: active.tasks.length,
        recent: recent.tasks.length,
        errored: errored.tasks.length,
      },
      inProgressByAgent,
      agentRollup,
    });
  } catch (err) {
    return apiError('activity-stats', err);
  }
}
