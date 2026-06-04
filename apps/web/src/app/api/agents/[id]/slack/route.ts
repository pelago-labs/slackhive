/**
 * @fileoverview Disconnect an agent from Slack.
 *
 * DELETE /api/agents/[id]/slack — removes the agent's Slack integration entirely
 * (bot token, app token, signing secret, resolved bot identity), then reloads
 * the agent so the runner tears down its live Slack connection and parks it in
 * the "Slack not configured" state.
 *
 * @module web/api/agents/[id]/slack
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getAgentById, deleteSlackIntegration, publishAgentEvent } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;

    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await deleteSlackIntegration(id);
    // Reload: stops the running Slack adapter; restart finds no integration and
    // parks the agent as 'stopped' (Slack not configured).
    await publishAgentEvent({ type: 'reload', agentId: id });

    const updated = await getAgentById(id);
    return NextResponse.json(updated ?? agent);
  } catch (err) {
    return apiError('agents/[id]/slack', err);
  }
}
