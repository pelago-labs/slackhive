/**
 * @fileoverview REST API routes for agent MCP assignments.
 *
 * GET /api/agents/[id]/mcps — List MCPs assigned to this agent
 * PUT /api/agents/[id]/mcps — Replace all MCP assignments, then trigger reload
 *
 * @module web/api/agents/[id]/mcps
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getAgentById, getAgentSkills, getAgentPermissions, getAgentMcpServers, setAgentMcps, publishAgentEvent, createSnapshot, getMcpServerById } from '@/lib/db';
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
    return apiError('agents/[id]/mcps', err);
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
    const session = getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    // Must have write access to the agent itself
    const agentDenied = await guardAgentWrite(req, id);
    if (agentDenied) return agentDenied;

    const { mcpIds } = (await req.json()) as { mcpIds: string[] };
    const normalizedIds: string[] = mcpIds ?? [];

    // Admin/superadmin can assign any MCP. Others can only assign MCPs they own.
    // Check both additions (new ids) and removals (ids being dropped) against ownership.
    const isAdmin = session.role === 'admin' || session.role === 'superadmin';
    if (!isAdmin) {
      // All ids in the new set must be owned by the caller
      if (normalizedIds.length) {
        const mcps = await Promise.all(normalizedIds.map(mid => getMcpServerById(mid)));
        const unauthorized = mcps.find(m => m && m.createdBy !== session.username);
        if (unauthorized) {
          return NextResponse.json(
            { error: `Only the MCP owner or an admin can assign "${unauthorized.name}"` },
            { status: 403 }
          );
        }
      }
      // Ids being removed must also be owned by the caller (can't remove others' MCPs)
      const currentMcpsForCheck = await getAgentMcpServers(id);
      const currentIdSet = new Set(normalizedIds);
      const removed = currentMcpsForCheck.filter(m => !currentIdSet.has(m.id));
      const unauthorizedRemoval = removed.find(m => m.createdBy !== session.username);
      if (unauthorizedRemoval) {
        return NextResponse.json(
          { error: `Only the MCP owner or an admin can remove "${unauthorizedRemoval.name}"` },
          { status: 403 }
        );
      }
    }

    // Snapshot before mutation — only if MCP assignments actually changed
    const [agent, currentSkills, perms, currentMcps] = await Promise.all([
      getAgentById(id),
      getAgentSkills(id),
      getAgentPermissions(id),
      // Non-admins already fetched this above; re-fetch is cheap and keeps the code simple
      getAgentMcpServers(id),
    ]);
    const oldMcpIds = JSON.stringify([...currentMcps.map(m => m.id)].sort());
    const newMcpIds = JSON.stringify([...normalizedIds].sort());
    if (oldMcpIds !== newMcpIds) {
      await createSnapshot(
        id, 'mcps', session?.username ?? 'system', null,
        currentSkills.map(skillToSnapshotSkill),
        perms?.allowedTools ?? [],
        perms?.deniedTools ?? [],
        currentMcps.map(m => m.id),
        agent?.claudeMd ?? '',
      ).catch(() => {});
    }

    await setAgentMcps(id, normalizedIds);
    await publishAgentEvent({ type: 'reload', agentId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError('agents/[id]/mcps', err);
  }
}
