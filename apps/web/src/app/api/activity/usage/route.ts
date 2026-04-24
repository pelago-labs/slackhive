/**
 * @fileoverview Token-usage aggregation for the Activity/Usage page —
 * per-agent token sums, power-user leaderboard, and a rolled-up totals strip.
 * All three are scoped by the same `window` param so the UI stays consistent.
 *
 * @module web/api/activity/usage
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getTokensByAgent,
  getTopUsers,
  type ActivityFilter,
} from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { windowFloor } from '@/lib/activity-window';

export const dynamic = 'force-dynamic';

/**
 * GET /api/activity/usage?window=5h&agent=
 *
 * Returns `{ byAgent, byUser, totals }` — all three scoped by `window`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    // Token usage + power-user leaderboard are billing-adjacent — superadmin only.
    if (session.role !== 'superadmin') {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const accessibleAgentIds = await listAccessibleAgentIds(session.username, session.role);

    const { searchParams } = new URL(req.url);
    const filter: ActivityFilter = {
      agentId: searchParams.get('agent') ?? undefined,
      since: windowFloor(searchParams.get('window')),
      accessibleAgentIds: accessibleAgentIds ?? undefined,
    };

    const [byAgent, byUser] = await Promise.all([
      getTokensByAgent(filter),
      getTopUsers(filter, 10),
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

    return NextResponse.json({ byAgent, byUser, totals });
  } catch (err) {
    return apiError('activity-usage', err);
  }
}
