/**
 * @fileoverview Sensitive-access audit feed — recent tool calls flagged by the
 * sensitivity monitor (credential/DB access, PII, secrets, sensitive data),
 * scoped to the caller's accessible agents.
 *
 * @module web/api/activity/sensitive
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSensitiveEvents } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { windowFloor } from '@/lib/activity-window';

export const dynamic = 'force-dynamic';

/** GET /api/activity/sensitive?window=24h&agent= → { events } */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    if (session.role === 'viewer') return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });

    const accessibleAgentIds = await listAccessibleAgentIds(session.username, session.role);
    const { searchParams } = new URL(req.url);

    const events = await getSensitiveEvents({
      since: windowFloor(searchParams.get('window')),
      agentId: searchParams.get('agent') ?? undefined,
      accessibleAgentIds: accessibleAgentIds ?? undefined,
      limit: 200,
    });

    return NextResponse.json({ events });
  } catch (err) {
    return apiError('activity-sensitive', err);
  }
}
