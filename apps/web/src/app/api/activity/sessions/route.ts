/**
 * @fileoverview Paginated sessions feed for the LLMOps "Sessions" table. The
 * composed /api/activity/insights returns the first page; this endpoint serves the
 * subsequent pages via a keyset cursor so "Load more" doesn't refetch the whole
 * insights snapshot. Same auth/RBAC + window scoping as the insights route.
 *
 * @module web/api/activity/sessions
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionSummaries } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { windowBounds } from '@/lib/activity-window';

export const dynamic = 'force-dynamic';

const SESSIONS_PAGE_SIZE = 50;

/**
 * GET /api/activity/sessions?agent=&window=&from=&to=&cursor=
 * Returns `{ sessions, nextCursor }` — one page after `cursor` (newest-first).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    if (session.role === 'viewer') return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });

    const accessibleAgentIds = await listAccessibleAgentIds(session.username, session.role);
    const { searchParams } = new URL(req.url);
    const { since, until } = windowBounds(searchParams.get('window'), searchParams.get('from'), searchParams.get('to'));
    const agentId = searchParams.get('agent') ?? undefined;
    const cursor = searchParams.get('cursor') ?? undefined;

    // A restricted caller asking for an agent they can't access → empty page.
    if (agentId && accessibleAgentIds !== null && !accessibleAgentIds.includes(agentId)) {
      return NextResponse.json({ sessions: [], nextCursor: null });
    }

    const filter = {
      agentId,
      since,
      until,
      accessibleAgentIds: accessibleAgentIds ?? undefined,
    };
    const page = await getSessionSummaries(filter, SESSIONS_PAGE_SIZE, cursor);
    return NextResponse.json(page);
  } catch (err) {
    return apiError('activity-sessions', err);
  }
}
