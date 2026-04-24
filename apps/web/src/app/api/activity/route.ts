/**
 * @fileoverview List tasks for the activity dashboard, one kanban column at
 * a time. Middleware-authenticated (any role); writes live on the runner
 * side, so this is read-only.
 *
 * @module web/api/activity
 */

import { NextRequest, NextResponse } from 'next/server';
import { listTasks, type TaskListColumn, type ActivityFilter } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { windowFloor } from '@/lib/activity-window';

export const dynamic = 'force-dynamic';

const VALID_COLUMNS: TaskListColumn[] = ['active', 'recent', 'errored'];

/**
 * GET /api/activity?column=active|recent|errored&window=24h&agent=&user=&cursor=&limit=
 *
 * Returns `{ tasks, nextCursor }`. Active has no pagination (Strict lifecycle
 * keeps the column tiny). Recent + Errored paginate on `last_activity_at DESC`
 * via `{lastActivityAt}|{taskId}` cursor.
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

    const { searchParams } = new URL(req.url);
    const column = searchParams.get('column') as TaskListColumn | null;
    if (!column || !VALID_COLUMNS.includes(column)) {
      return NextResponse.json({ error: `column must be one of ${VALID_COLUMNS.join(', ')}` }, { status: 400 });
    }

    // Admins/superadmins see everything; others are scoped to agents they
    // created or have explicit access to.
    const accessibleAgentIds = await listAccessibleAgentIds(session.username, session.role);

    const filter: ActivityFilter = {
      agentId: searchParams.get('agent') ?? undefined,
      userId: searchParams.get('user') ?? undefined,
      since: windowFloor(searchParams.get('window')),
      accessibleAgentIds: accessibleAgentIds ?? undefined,
    };

    const limit = column === 'active'
      ? 200
      : Math.max(1, Math.min(100, Number(searchParams.get('limit') ?? 20)));
    const cursor = column === 'active' ? null : searchParams.get('cursor');

    const result = await listTasks(column, filter, limit, cursor);
    return NextResponse.json(result);
  } catch (err) {
    return apiError('activity-list', err);
  }
}
