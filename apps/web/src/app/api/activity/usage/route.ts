/**
 * @fileoverview Token usage aggregation for the Activity/Usage page — per-agent
 * token sums, power-user leaderboard, and a rolling 5-hour current-session card.
 *
 * @module web/api/activity/usage
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getTokensByAgent,
  getTopUsers,
  getCurrentSessionUsage,
  type ActivityFilter,
} from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';

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
 * GET /api/activity/usage?window=24h&agent=
 *
 * Returns `{ byAgent, byUser, totals, currentSession }`.
 * `currentSession` always spans the rolling last 5 hours regardless of the
 * `window` param — it mirrors Claude Code's `/usage` cadence.
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
      since: windowFloor(searchParams.get('window')),
      accessibleAgentIds: accessibleAgentIds ?? undefined,
    };

    const [byAgent, byUser, currentSession] = await Promise.all([
      getTokensByAgent(filter),
      getTopUsers(filter, 10),
      getCurrentSessionUsage(accessibleAgentIds ?? undefined),
    ]);

    const totals = byAgent.reduce(
      (acc, row) => ({
        inputTokens:         acc.inputTokens         + row.inputTokens,
        outputTokens:        acc.outputTokens        + row.outputTokens,
        cacheReadTokens:     acc.cacheReadTokens     + row.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens + row.cacheCreationTokens,
        turnCount:           acc.turnCount           + row.turnCount,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turnCount: 0 },
    );

    return NextResponse.json({ byAgent, byUser, totals, currentSession });
  } catch (err) {
    return apiError('activity-usage', err);
  }
}
