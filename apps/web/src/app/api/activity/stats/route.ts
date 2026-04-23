/**
 * @fileoverview Aggregate stats for the activity dashboard —
 * per-column counts and per-agent in-progress counts.
 *
 * Cheap enough to compute on each request for now; no caching.
 *
 * @module web/api/activity/stats
 */

import { NextRequest, NextResponse } from 'next/server';
import { listTasks, countInProgressByAgent, type ActivityFilter } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

const VALID_WINDOWS = new Set(['1h', '24h', '7d', '30d']);

function windowFloor(w: string | null): string | undefined {
  if (!w || !VALID_WINDOWS.has(w)) return undefined;
  const ms =
    w === '1h'  ? 60 * 60 * 1000 :
    w === '24h' ? 24 * 60 * 60 * 1000 :
    w === '7d'  ? 7 * 24 * 60 * 60 * 1000 :
                  30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * GET /api/activity/stats?window=24h&agent=&user=
 *
 * Returns `{ counts: {active, recent, errored}, inProgressByAgent }`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url);
    const filter: ActivityFilter = {
      agentId: searchParams.get('agent') ?? undefined,
      userId: searchParams.get('user') ?? undefined,
      since: windowFloor(searchParams.get('window')),
    };

    // Fetch up to 500 per column — plenty for the badge number. Filters apply
    // so the count matches the kanban the user is looking at.
    const [active, recent, errored, inProgressByAgent] = await Promise.all([
      listTasks('active', filter, 500, null),
      listTasks('recent', filter, 500, null),
      listTasks('errored', filter, 500, null),
      countInProgressByAgent(),
    ]);

    return NextResponse.json({
      counts: {
        active: active.tasks.length,
        recent: recent.tasks.length,
        errored: errored.tasks.length,
      },
      inProgressByAgent,
    });
  } catch (err) {
    return apiError('activity-stats', err);
  }
}
