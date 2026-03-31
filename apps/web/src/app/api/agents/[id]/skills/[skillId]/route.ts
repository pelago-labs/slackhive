/**
 * @fileoverview DELETE /api/agents/[id]/skills/[skillId]
 * Removes a skill file and triggers a reload event.
 *
 * @module web/api/agents/[id]/skills/[skillId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteSkill, publishAgentEvent, getAgentById, getAgentSkills, getAgentPermissions, getAgentMcpServers, createSnapshot } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { compileSkillsOnly, skillToSnapshotSkill } from '@/lib/compile';

type RouteParams = { params: Promise<{ id: string; skillId: string }> };

/**
 * DELETE /api/agents/[id]/skills/[skillId]
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} 204 No Content or error.
 */
export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  try {
    const { id, skillId } = await params;

    // Snapshot before deletion
    const session = getSessionFromRequest(req);
    const [agent, currentSkills, perms, mcps] = await Promise.all([
      getAgentById(id),
      getAgentSkills(id),
      getAgentPermissions(id),
      getAgentMcpServers(id),
    ]);
    await createSnapshot(
      id, 'skills', session?.username ?? 'system', null,
      currentSkills.map(skillToSnapshotSkill),
      perms?.allowedTools ?? [],
      perms?.deniedTools ?? [],
      mcps.map(m => m.id),
      compileSkillsOnly(currentSkills, agent ?? undefined),
    ).catch(() => {});

    await deleteSkill(skillId);
    await publishAgentEvent({ type: 'reload', agentId: id });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
