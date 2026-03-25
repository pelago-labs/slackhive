/**
 * @fileoverview REST API routes for agent tool permissions.
 *
 * GET /api/agents/[id]/permissions — Get current permissions
 * PUT /api/agents/[id]/permissions — Replace permissions, then trigger reload
 *
 * @module web/api/agents/[id]/permissions
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentPermissions, upsertPermissions, publishAgentEvent } from '@/lib/db';
import type { UpdatePermissionsRequest } from '@slack-agent-team/shared';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/agents/[id]/permissions
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} Permission object or null.
 */
export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const perms = await getAgentPermissions(id);
    return NextResponse.json(perms ?? { allowedTools: [], deniedTools: [] });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * PUT /api/agents/[id]/permissions
 * Replaces all tool permissions for an agent.
 *
 * @param {NextRequest} req - Body: { allowedTools: string[], deniedTools: string[] }
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} 200 ok or error.
 */
export async function PUT(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const body = (await req.json()) as UpdatePermissionsRequest;
    await upsertPermissions(id, body.allowedTools ?? [], body.deniedTools ?? []);
    await publishAgentEvent({ type: 'reload', agentId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
