/**
 * @fileoverview POST /api/jobs/[id]/run — manually trigger a scheduled job.
 *
 * Fires the job immediately via the runner's internal /job-run endpoint.
 * Respects the active spoof date (clockNow() is used inside the scheduler).
 *
 * @module web/api/jobs/[id]/run
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { getJobById } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const job = await getJobById(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  try {
    const r = await fetch(`http://127.0.0.1:${port}/job-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: id }),
    });
    if (!r.ok) {
      const data = await r.json() as { error?: string };
      return NextResponse.json({ error: data.error ?? 'Runner error' }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Runner not reachable' }, { status: 503 });
  }
}
