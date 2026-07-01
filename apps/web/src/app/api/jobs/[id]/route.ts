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
import { getJobById, updateJob, deleteJob, publishAgentEvent, userCanWriteAgent } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

function canAccessJob(session: { username: string; role: string }, job: { createdBy: string }): boolean {
  return session.role === 'superadmin' || job.createdBy === session.username;
}

/**
 * Returns a single job by ID.
 */
export async function GET(req: Request, { params }: Ctx): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const session = getSessionFromRequest(req)!;
  const { id } = await params;
  const job = await getJobById(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canAccessJob(session, job)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return NextResponse.json(job);
}

/**
 * Updates a scheduled job.
 */
export async function PATCH(req: Request, { params }: Ctx): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const session = getSessionFromRequest(req)!;
  const { id } = await params;
  const existing = await getJobById(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canAccessJob(session, existing)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json();
  // Re-pointing a job at a *different* agent requires edit access to that agent.
  // (Editing other fields of an existing job is gated by canAccessJob above.)
  if (body.agentId && body.agentId !== existing.agentId
      && !(await userCanWriteAgent(body.agentId, session.username, session.role))) {
    return NextResponse.json({ error: 'You need edit access to that agent.' }, { status: 403 });
  }
  const job = await updateJob(id, body);
  await publishAgentEvent({ type: 'reload-jobs' });
  return NextResponse.json(job);
}

/**
 * Deletes a scheduled job.
 */
export async function DELETE(req: Request, { params }: Ctx): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const session = getSessionFromRequest(req)!;
  const { id } = await params;
  const existing = await getJobById(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canAccessJob(session, existing)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  await deleteJob(id);
  await publishAgentEvent({ type: 'reload-jobs' });
  return new NextResponse(null, { status: 204 });
}
