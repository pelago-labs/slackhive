/**
 * @fileoverview Detail endpoint for one task — returns the task plus its
 * activities (with nested tool_calls) for the dashboard's drilldown view.
 *
 * @module web/api/activity/[taskId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskWithDetails, deepLinkForTask } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/activity/[taskId]
 * Returns `{ task, activities: [{ ...activity, toolCalls }], deepLink }`
 * or 404 if the id is unknown.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<NextResponse> {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    if (session.role === 'viewer') {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const { taskId } = await params;
    const details = await getTaskWithDetails(taskId);
    if (!details) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    // Non-admins can only see tasks that touched an agent they can access.
    const accessibleAgentIds = await listAccessibleAgentIds(session.username, session.role);
    if (accessibleAgentIds !== null) {
      const allowed = new Set(accessibleAgentIds);
      const hasOverlap = details.activities.some(a => allowed.has(a.agentId));
      if (!hasOverlap) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
    }

    return NextResponse.json({
      ...details,
      deepLink: deepLinkForTask(details.task),
    });
  } catch (err) {
    return apiError('activity-detail', err);
  }
}
