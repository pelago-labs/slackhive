/**
 * @fileoverview Per-tool stats + error-message aggregation for the tool
 * drill-down (opened from the dashboard's "Top tools"). Scoped to the caller's
 * accessible agents.
 *
 * @module web/api/activity/tools
 */

import { NextRequest, NextResponse } from 'next/server';
import { getToolStats } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { windowFloor } from '@/lib/activity-window';

export const dynamic = 'force-dynamic';

/** GET /api/activity/tools?window=24h&agent= → { tools } */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    if (session.role === 'viewer') return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });

    const accessibleAgentIds = await listAccessibleAgentIds(session.username, session.role);
    const { searchParams } = new URL(req.url);

    const tools = await getToolStats({
      since: windowFloor(searchParams.get('window')),
      agentId: searchParams.get('agent') ?? undefined,
      accessibleAgentIds: accessibleAgentIds ?? undefined,
    });

    return NextResponse.json({ tools });
  } catch (err) {
    return apiError('activity-tools', err);
  }
}
