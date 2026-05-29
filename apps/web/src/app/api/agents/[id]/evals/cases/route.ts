/**
 * @fileoverview Eval case collection endpoints.
 *
 * GET  /api/agents/[id]/evals/cases — list cases for the agent
 * POST /api/agents/[id]/evals/cases — create a new case
 *
 * Listing is open to any authenticated user (anyone who can view the agent).
 * Creating requires write access to the agent.
 *
 * @module web/api/agents/[id]/evals/cases
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardAgentWrite, guardAuth } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { createEvalCase, getAgentById, getEvalCases } from '@/lib/db';
import type { CreateEvalCaseRequest } from '@slackhive/shared';

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
    const statusParam = url.searchParams.get('status');
    const status =
      statusParam === 'approved' || statusParam === 'proposed' ? statusParam : undefined;

    const cases = await getEvalCases(id, { status });
    return NextResponse.json(cases);
  } catch (err) {
    return apiError('agents/[id]/evals/cases:GET', err);
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

    const body = (await req.json().catch(() => null)) as CreateEvalCaseRequest | null;
    if (!body || typeof body.question !== 'string' || !Array.isArray(body.checks)) {
      return NextResponse.json(
        { error: 'question (string) and checks (array) are required' },
        { status: 400 },
      );
    }
    if (body.checks.length === 0) {
      return NextResponse.json({ error: 'At least one check is required' }, { status: 400 });
    }

    const created = await createEvalCase(id, body, session.username);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return apiError('agents/[id]/evals/cases:POST', err);
  }
}
