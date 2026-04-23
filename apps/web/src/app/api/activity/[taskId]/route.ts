/**
 * @fileoverview Detail endpoint for one task — returns the task plus its
 * activities (with nested tool_calls) for the dashboard's drilldown view.
 *
 * @module web/api/activity/[taskId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskWithDetails, deepLinkForTask } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

/**
 * GET /api/activity/[taskId]
 * Returns `{ task, activities: [{ ...activity, toolCalls }], deepLink }`
 * or 404 if the id is unknown.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<NextResponse> {
  try {
    const { taskId } = await params;
    const details = await getTaskWithDetails(taskId);
    if (!details) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    return NextResponse.json({
      ...details,
      deepLink: deepLinkForTask(details.task),
    });
  } catch (err) {
    return apiError('activity-detail', err);
  }
}
