/**
 * @fileoverview Single job API — get, update, delete.
 *
 * GET    /api/jobs/[id] — get a job.
 * PATCH  /api/jobs/[id] — update a job.
 * DELETE /api/jobs/[id] — delete a job.
 *
 * @module web/api/jobs/[id]
 */

import { NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { getJobById, updateJob, deleteJob, publishAgentEvent } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Returns a single job by ID.
 */
export async function GET(_req: Request, { params }: Ctx): Promise<NextResponse> {
  const { id } = await params;
  const job = await getJobById(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(job);
}

/**
 * Updates a scheduled job.
 */
export async function PATCH(req: Request, { params }: Ctx): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const { id } = await params;
  const body = await req.json();
  const job = await updateJob(id, body);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await publishAgentEvent({ type: 'reload-jobs' });
  return NextResponse.json(job);
}

/**
 * Deletes a scheduled job.
 */
export async function DELETE(req: Request, { params }: Ctx): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const { id } = await params;
  await deleteJob(id);
  await publishAgentEvent({ type: 'reload-jobs' });
  return new NextResponse(null, { status: 204 });
}
