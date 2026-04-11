/**
 * @fileoverview REST API routes for agent MCP assignments.
 *
 * GET /api/agents/[id]/mcps — List MCPs assigned to this agent
 * PUT /api/agents/[id]/mcps — Replace all MCP assignments, then trigger reload
 *
 * @module web/api/agents/[id]/mcps
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById, getAgentSkills, getAgentPermissions, getAgentMcpServers, setAgentMcps, publishAgentEvent, createSnapshot } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { skillToSnapshotSkill } from '@/lib/compile';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/agents/[id]/mcps
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} JSON array of assigned McpServer objects.
 */
export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const mcps = await getAgentMcpServers(id);
    return NextResponse.json(mcps);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * PUT /api/agents/[id]/mcps
 * Replaces all MCP assignments for an agent and triggers a reload.
 *
 * @param {NextRequest} req - Body: { mcpIds: string[] }
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} 200 ok or error.
 */
export async function PUT(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;
    const { mcpIds } = (await req.json()) as { mcpIds: string[] };

    // Snapshot before mutation — only if MCP assignments actually changed
    const [agent, currentSkills, perms, currentMcps] = await Promise.all([
      getAgentById(id),
      getAgentSkills(id),
      getAgentPermissions(id),
      getAgentMcpServers(id),
    ]);
    const oldMcpIds = JSON.stringify([...currentMcps.map(m => m.id)].sort());
    const newMcpIds = JSON.stringify([...(mcpIds ?? [])].sort());
    if (oldMcpIds !== newMcpIds) {
      const session = getSessionFromRequest(req);
      await createSnapshot(
        id, 'mcps', session?.username ?? 'system', null,
        currentSkills.map(skillToSnapshotSkill),
        perms?.allowedTools ?? [],
        perms?.deniedTools ?? [],
        currentMcps.map(m => m.id),
        agent?.claudeMd ?? '',
      ).catch(() => {});
    }

    await setAgentMcps(id, mcpIds ?? []);
    await publishAgentEvent({ type: 'reload', agentId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
