/**
 * @fileoverview Scheduled jobs API — list and create jobs.
 *
 * GET  /api/jobs — list all jobs with last run info.
 * POST /api/jobs — create a new scheduled job.
 *
 * @module web/api/jobs
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { getAllJobs, createJob, publishAgentEvent, listAccessibleAgentIds, userCanWriteAgent } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Lists scheduled jobs. Superadmins see all; everyone else sees only their own.
 *
 * @returns {Promise<NextResponse>} JSON array of jobs.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const agentIds = await listAccessibleAgentIds(session.username, session.role);
  const jobs = await getAllJobs(agentIds);
  return NextResponse.json(jobs);
}

/**
 * Creates a new scheduled job.
 *
 * @param {Request} req - JSON body with job fields.
 * @returns {Promise<NextResponse>} Created job.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const session = getSessionFromRequest(req)!;

  const body = await req.json();
  if (!body.name || !body.prompt || !body.cronSchedule || !body.targetId || !body.agentId) {
    return NextResponse.json({ error: 'agentId, name, prompt, cronSchedule, and targetId are required' }, { status: 400 });
  }

  // A job makes the agent run a prompt on a schedule — require edit access to that
  // agent (superadmin/admin pass automatically). Mirrors the form's writable filter.
  if (!(await userCanWriteAgent(body.agentId, session.username, session.role))) {
    return NextResponse.json({ error: 'You need edit access to this agent to schedule a job for it.' }, { status: 403 });
  }

  const job = await createJob({ ...body, createdBy: session.username });
  await publishAgentEvent({ type: 'reload-jobs' });
  return NextResponse.json(job, { status: 201 });
}
