/**
 * @fileoverview POST /api/agents/[id]/reload
 * Publishes a reload event: runner stops the agent, recompiles CLAUDE.md, and restarts it.
 *
 * @module web/api/agents/[id]/reload
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById, publishAgentEvent } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/agents/[id]/reload
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} 200 on success, 404 or 500 on error.
 */
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await publishAgentEvent({ type: 'reload', agentId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
