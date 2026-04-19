/**
 * @fileoverview POST /api/agents/[id]/start
 * Publishes a start event so the runner spins up the agent's Bolt app.
 *
 * @module web/api/agents/[id]/start
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById, updateAgentEnabled, publishAgentEvent } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/agents/[id]/start
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} 200 on success, 404 or 500 on error.
 */
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Enable first so the runner treats this as an active agent, then dispatch
    // the start event. The runner is authoritative for `status` — it will set
    // 'running' on success or 'error' on failure. Don't pre-write 'running' here
    // or we'll overwrite a legitimate failure with a phantom success.
    await updateAgentEnabled(id, true);
    await publishAgentEvent({ type: 'start', agentId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
