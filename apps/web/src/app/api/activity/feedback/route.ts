/**
 * @fileoverview Paginated 👍/👎 feedback feed for the Observability "Feedback"
 * tab. Serves ratings across the caller's accessible agents (or one agent),
 * newest-first, with limit/offset paging so the tab can "Load more" without
 * refetching the whole insights snapshot. Same auth/RBAC + window scoping as the
 * insights route.
 *
 * @module web/api/activity/feedback
 */

import { NextRequest, NextResponse } from 'next/server';
import { getFeedbackFeed } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { windowBounds } from '@/lib/activity-window';

export const dynamic = 'force-dynamic';

const FEEDBACK_PAGE_SIZE = 20;

/**
 * GET /api/activity/feedback?agent=&window=&from=&to=&sentiment=up|down&offset=
 * Returns `{ items, total, nextOffset }` — one page (newest-first).
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
    const sentimentRaw = searchParams.get('sentiment');
    const sentiment = sentimentRaw === 'up' || sentimentRaw === 'down' ? sentimentRaw : undefined;
    const offset = Math.max(Number(searchParams.get('offset')) || 0, 0);

    // A restricted caller asking for an agent they can't access → empty page.
    if (agentId && accessibleAgentIds !== null && !accessibleAgentIds.includes(agentId)) {
      return NextResponse.json({ items: [], total: 0, nextOffset: null, summary: { up: 0, down: 0 } });
    }

    const page = await getFeedbackFeed(
      { agentId, accessibleAgentIds: accessibleAgentIds ?? undefined, sentiment, since, until },
      FEEDBACK_PAGE_SIZE,
      offset,
    );
    return NextResponse.json(page);
  } catch (err) {
    return apiError('activity-feedback', err);
  }
}
