/**
 * @fileoverview Scheduled jobs API — list and create jobs.
 *
 * GET  /api/jobs — list all jobs with last run info.
 * POST /api/jobs — create a new scheduled job.
 *
 * @module web/api/jobs
 */

import { NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { getAllJobs, createJob, publishAgentEvent } from '@/lib/db';

/**
 * Lists all scheduled jobs with their most recent run.
 *
 * @returns {Promise<NextResponse>} JSON array of jobs.
 */
export async function GET(): Promise<NextResponse> {
  const jobs = await getAllJobs();
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

  const body = await req.json();
  if (!body.name || !body.prompt || !body.cronSchedule || !body.targetId || !body.agentId) {
    return NextResponse.json({ error: 'agentId, name, prompt, cronSchedule, and targetId are required' }, { status: 400 });
  }

  const job = await createJob(body);
  await publishAgentEvent({ type: 'reload-jobs' });
  return NextResponse.json(job, { status: 201 });
}
