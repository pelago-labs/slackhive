/**
 * @fileoverview POST /api/agents/[id]/stop
 * Publishes a stop event so the runner tears down the agent's Bolt app.
 *
 * @module web/api/agents/[id]/stop
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById, updateAgentStatus, publishAgentEvent } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/agents/[id]/stop
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
    await publishAgentEvent({ type: 'stop', agentId: id });
    await updateAgentStatus(id, 'stopped');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
