/**
 * @fileoverview REST API route for a single agent resource.
 *
 * GET    /api/agents/[id] — Get agent by ID
 * PATCH  /api/agents/[id] — Update agent config
 * DELETE /api/agents/[id] — Remove agent
 *
 * @module web/api/agents/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { rm } from 'fs/promises';
import path from 'path';
import { getAgentById, updateAgent, deleteAgent, publishAgentEvent, applyLiveStatus } from '@/lib/db';
import type { UpdateAgentRequest } from '@slackhive/shared';
import { regenerateBossRegistry } from '@/lib/boss-registry';
import { guardAgentWrite, guardUserAdmin } from '@/lib/api-guard';

const AGENTS_TMP_DIR = process.env.AGENTS_TMP_DIR ?? (
  process.env.DATABASE_TYPE === 'sqlite'
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.slackhive', 'agents')
    : '/tmp/agents'
);

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/agents/[id]
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} Agent JSON or 404.
 */
export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(applyLiveStatus(agent));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * PATCH /api/agents/[id]
 * Updates mutable agent fields and triggers a reload event.
 *
 * @param {NextRequest} req - Partial UpdateAgentRequest body.
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} Updated agent JSON or error.
 */
export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;
    const body = (await req.json()) as Partial<UpdateAgentRequest>;
    const updated = await updateAgent(id, body);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await publishAgentEvent({ type: 'reload', agentId: id });
    await regenerateBossRegistry().catch(() => {});
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/[id]
 * Removes an agent and publishes a stop event before deletion.
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} 204 No Content or error.
 */
export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const denied = guardUserAdmin(req);
    if (denied) return denied;
    const agent = await getAgentById(id);
    await publishAgentEvent({ type: 'stop', agentId: id });
    await deleteAgent(id);
    if (agent?.slug) {
      await rm(path.join(AGENTS_TMP_DIR, agent.slug), { recursive: true, force: true });
    }
    await regenerateBossRegistry().catch(() => {});
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
