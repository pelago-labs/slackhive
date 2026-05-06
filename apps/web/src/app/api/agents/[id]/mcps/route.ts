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
import { guardAgentWrite, guardAuth } from '@/lib/api-guard';
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
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAuth(req);
  if (denied) return denied;
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

    // Editors can only add/remove MCPs they own; admins/superadmins bypass.
    // Only check MCPs being changed (added or removed), not already-assigned ones.
    const isAdmin = session.role === 'admin' || session.role === 'superadmin';
    const existingMcps = await getAgentMcpServers(id);
    if (!isAdmin) {
      const currentIds = new Set(existingMcps.map(m => m.id));
      const newIdSet = new Set(normalizedIds);
      const changedIds = [
        ...normalizedIds.filter(mid => !currentIds.has(mid)),  // newly added
        ...[...currentIds].filter(mid => !newIdSet.has(mid)),  // removed
      ];
      const changedMcps = await Promise.all(changedIds.map(mid => getMcpServerById(mid)));
      const unauthorized = changedMcps.find(m => m && m.createdBy !== session.username);
      if (unauthorized) {
        return NextResponse.json(
          { error: `Only the MCP owner or an admin can assign "${unauthorized.name}"` },
          { status: 403 },
        );
      }
    }

    // Snapshot before mutation — only if MCP assignments actually changed
    const [agent, currentSkills, perms] = await Promise.all([
      getAgentById(id),
      getAgentSkills(id),
      getAgentPermissions(id),
    ]);
    const currentMcps = existingMcps;
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
