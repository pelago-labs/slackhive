/**
 * @fileoverview Eval runs collection endpoints.
 *
 * GET  /api/agents/[id]/evals/runs?limit=N — list past runs (newest first)
 * POST /api/agents/[id]/evals/runs         — start a new run
 *
 * POST returns immediately with the just-created EvalRun (status='running').
 * The orchestrator runs in a background promise; UI polls
 * /runs/[runId] for completion.
 *
 * @module web/api/agents/[id]/evals/runs
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardAgentWrite, guardAuth } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import {
  createEvalRun,
  failEvalRun,
  finalizeEvalRun,
  getAgentById,
  getEvalRuns,
  insertEvalRunResult,
} from '@/lib/db';
import {
  caseExecutionToRunResult,
  runApprovedCases,
  summarize,
} from '@/lib/evals/run-regression';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const denied = guardAuth(req);
    if (denied) return denied;

    const { id } = await params;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const url = new URL(req.url);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 10, 1), 50) : 10;

    const runs = await getEvalRuns(id, limit);
    return NextResponse.json(runs);
  } catch (err) {
    return apiError('agents/[id]/evals/runs:GET', err);
  }
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;

    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const session = getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const run = await createEvalRun(id, session.username);

    // Fire-and-forget — orchestrator runs in the background.
    // The HTTP response returns immediately with the running run id.
    void (async () => {
      try {
        const executions = await runApprovedCases(id);
        for (const exec of executions) {
          try {
            await insertEvalRunResult(caseExecutionToRunResult(exec, run.id));
          } catch (insertErr) {
            console.error('[evals:run] insertEvalRunResult failed', insertErr);
          }
        }
        const summary = summarize(executions);
        const totalMs = executions.reduce((acc, e) => acc + e.timeMs, 0);
        await finalizeEvalRun(run.id, summary, totalMs);
      } catch (err) {
        console.error('[evals:run] orchestrator failed', err);
        try {
          await failEvalRun(run.id);
        } catch {
          // best-effort
        }
      }
    })();

    return NextResponse.json(run, { status: 202 });
  } catch (err) {
    return apiError('agents/[id]/evals/runs:POST', err);
  }
}
