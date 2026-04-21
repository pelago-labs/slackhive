/**
 * @fileoverview DELETE /api/agents/[id]/skills/[skillId]
 * Removes a skill file and triggers a reload event.
 *
 * @module web/api/agents/[id]/skills/[skillId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { deleteSkill, publishAgentEvent, getAgentById, getAgentSkills, getAgentPermissions, getAgentMcpServers, createSnapshot } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { skillToSnapshotSkill } from '@/lib/compile';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string; skillId: string }> };

/**
 * DELETE /api/agents/[id]/skills/[skillId]
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} 204 No Content or error.
 */
export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id, skillId } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;

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
      agent?.claudeMd ?? '',
    ).catch(() => {});

    await deleteSkill(skillId);
    await publishAgentEvent({ type: 'reload', agentId: id });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return apiError('agents/[id]/skills/[skillId]', err);
  }
}
