/**
 * @fileoverview Paginated cross-session turn feed for the Observability "Audit" →
 * Turn view. Each page is a keyset window of turns (newest-first) with the full span
 * tree, authorship, result and sensitivity. Same auth/RBAC + window scoping as the
 * insights route, and the same admin-only raw-sensitive rule as the trace detail
 * route: non-admins get every flagged value redacted server-side before it ships.
 *
 * @module web/api/activity/turns
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTurnFeed, type TurnFeedFilter } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { windowBounds } from '@/lib/activity-window';
import { redactTurn } from '@/lib/activity-redact';

export const dynamic = 'force-dynamic';

const TURNS_PAGE_SIZE = 50;

/**
 * GET /api/activity/turns?agent=&window=&from=&to=&initiator=&sensitive=&errors=&cursor=
 * Returns `{ turns, nextCursor }` — one page after `cursor` (newest-first).
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
      return NextResponse.json({ turns: [], nextCursor: null });
    }

    const filter: TurnFeedFilter = {
      agentId,
      since,
      until,
      accessibleAgentIds: accessibleAgentIds ?? undefined,
      initiator: searchParams.get('initiator') ?? undefined,
      sensitiveOnly: searchParams.get('sensitive') === '1',
      errorsOnly: searchParams.get('errors') === '1',
    };
    const page = await getTurnFeed(filter, TURNS_PAGE_SIZE, cursor);

    // Only admins/superadmins may see raw sensitive values; redact for everyone else
    // (server-side, so the real value never reaches a non-admin's browser).
    const canSeeRaw = session.role === 'admin' || session.role === 'superadmin';
    const turns = canSeeRaw
      ? page.turns
      : page.turns.map(t => ({ ...redactTurn(t), sessionId: t.sessionId, sessionSummary: t.sessionSummary }));

    return NextResponse.json({ turns, nextCursor: page.nextCursor });
  } catch (err) {
    return apiError('activity-turns', err);
  }
}
