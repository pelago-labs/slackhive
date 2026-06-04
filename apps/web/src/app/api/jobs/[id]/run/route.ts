/**
 * @fileoverview Manual job trigger — POST /api/jobs/[id]/run.
 *
 * Fires a one-off "run-job" event the runner's JobScheduler picks up to execute
 * the job immediately (for testing), independent of its cron schedule.
 *
 * @module web/api/jobs/[id]/run
 */

import { NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { getJobById, publishAgentEvent } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Triggers an immediate run of the job.
 */
export async function POST(req: Request, { params }: Ctx): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const session = getSessionFromRequest(req)!;
  const { id } = await params;
  const job = await getJobById(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (session.role !== 'superadmin' && job.createdBy !== session.username) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  await publishAgentEvent({ type: 'run-job', jobId: id });
  return NextResponse.json({ ok: true });
}
