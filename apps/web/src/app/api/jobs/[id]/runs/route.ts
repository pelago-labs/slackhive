/**
 * @fileoverview Job runs API — execution history for a scheduled job.
 *
 * GET /api/jobs/[id]/runs — paginated run history.
 *
 * @module web/api/jobs/[id]/runs
 */

import { NextResponse } from 'next/server';
import { getJobRuns } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Returns paginated run history for a job.
 */
export async function GET(req: Request, { params }: Ctx): Promise<NextResponse> {
  const { id } = await params;
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const runs = await getJobRuns(id, limit, offset);
  return NextResponse.json(runs);
}
