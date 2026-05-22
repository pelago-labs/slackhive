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
import {
  failEvalRun,
  getAgentById,
  getEvalRun,
  getEvalRunResults,
} from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string; runId: string }> };

/**
 * If a run has been `running` for longer than this, the orchestrator
 * background promise almost certainly died (process restart, crash, etc).
 * Mark it errored on the next read so the UI stops polling forever.
 */
const STALE_RUN_THRESHOLD_MS = 10 * 60 * 1000; // 10 min

export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const denied = guardAuth(req);
    if (denied) return denied;

    const { id, runId } = await params;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    let run = await getEvalRun(runId);
    if (!run || run.agentId !== id) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // Lazy stale-run cleanup. failEvalRun is idempotent, so a race
    // between concurrent reads marking it errored is safe.
    if (run.status === 'running') {
      const elapsed = Date.now() - new Date(run.startedAt).getTime();
      if (elapsed > STALE_RUN_THRESHOLD_MS) {
        await failEvalRun(runId);
        run = (await getEvalRun(runId)) ?? run;
      }
    }

    const results = await getEvalRunResults(runId);
    return NextResponse.json({ run, results });
  } catch (err) {
    return apiError('agents/[id]/evals/runs/[runId]:GET', err);
  }
}
