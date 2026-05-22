/**
 * @fileoverview Single eval run endpoint.
 *
 * GET /api/agents/[id]/evals/runs/[runId] — fetch the run row + all
 *   per-case results. Used by the UI's polling loop while a run is
 *   in progress and to load a past run for inspection.
 *
 * @module web/api/agents/[id]/evals/runs/[runId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardAuth } from '@/lib/api-guard';
import { getAgentById, getEvalRun, getEvalRunResults } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string; runId: string }> };

export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const denied = guardAuth(req);
    if (denied) return denied;

    const { id, runId } = await params;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const run = await getEvalRun(runId);
    if (!run || run.agentId !== id) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const results = await getEvalRunResults(runId);
    return NextResponse.json({ run, results });
  } catch (err) {
    return apiError('agents/[id]/evals/runs/[runId]:GET', err);
  }
}
