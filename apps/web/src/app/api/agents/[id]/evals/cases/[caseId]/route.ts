/**
 * @fileoverview Single eval case endpoints.
 *
 * PATCH  /api/agents/[id]/evals/cases/[caseId] — update fields, toggle approval
 * DELETE /api/agents/[id]/evals/cases/[caseId] — hard delete
 *
 * Both require write access to the agent. The PATCH approval flow:
 *   status: proposed → approved  ⇒  sets approved_by + approved_at
 *   status: approved → proposed  ⇒  clears approved_by + approved_at
 *
 * @module web/api/agents/[id]/evals/cases/[caseId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardAgentWrite } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import {
  deleteEvalCase,
  getAgentById,
  getEvalCase,
  updateEvalCase,
} from '@/lib/db';
import type { UpdateEvalCaseRequest } from '@slackhive/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string; caseId: string }> };

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id, caseId } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;

    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const existing = await getEvalCase(caseId);
    if (!existing || existing.agentId !== id) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    const session = getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as UpdateEvalCaseRequest | null;
    if (!body) {
      return NextResponse.json({ error: 'Request body required' }, { status: 400 });
    }
    if (body.checks !== undefined && (!Array.isArray(body.checks) || body.checks.length === 0)) {
      return NextResponse.json(
        { error: 'checks must be a non-empty array if provided' },
        { status: 400 },
      );
    }

    const updated = await updateEvalCase(caseId, body, session.username);
    return NextResponse.json(updated);
  } catch (err) {
    return apiError('agents/[id]/evals/cases/[caseId]:PATCH', err);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id, caseId } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;

    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const existing = await getEvalCase(caseId);
    if (!existing || existing.agentId !== id) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    await deleteEvalCase(caseId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError('agents/[id]/evals/cases/[caseId]:DELETE', err);
  }
}
