/**
 * @fileoverview Per-skill API routes.
 *
 * PATCH  /api/agents/[id]/skills/[skillId] — Description-only update.
 *   - Body `{ description: string }` saves a manual edit.
 *   - Body `{ regenerate: true }` clears the description and asks the runner to regenerate.
 * DELETE /api/agents/[id]/skills/[skillId] — Removes a skill and triggers a reload.
 *
 * @module web/api/agents/[id]/skills/[skillId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { deleteSkill, publishAgentEvent, getAgentById, getAgentSkills, getAgentPermissions, getAgentMcpServers, createSnapshot, getSkillById, updateSkillDescription } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { skillToSnapshotSkill } from '@/lib/compile';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string; skillId: string }> };

/**
 * PATCH /api/agents/[id]/skills/[skillId]
 *
 * Body shape:
 *   { description: string | null } — set the description directly (manual edit).
 *   { regenerate: true }           — clear the description and emit a skill-saved
 *                                     event so the runner re-summarizes.
 */
export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id, skillId } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;

    const skill = await getSkillById(skillId);
    if (!skill || skill.agentId !== id) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }

    const body = (await req.json()) as { description?: string | null; regenerate?: boolean };

    if (body.regenerate) {
      const cleared = await updateSkillDescription(skillId, null);
      await publishAgentEvent({ type: 'skill-saved', agentId: id, skillId });
      return NextResponse.json(cleared ?? skill);
    }

    if (body.description !== undefined) {
      const updated = await updateSkillDescription(skillId, body.description);
      // Reload so the new description shows up in the agent's CLAUDE.md.
      await publishAgentEvent({ type: 'reload', agentId: id });
      return NextResponse.json(updated ?? skill);
    }

    return NextResponse.json({ error: 'description or regenerate required' }, { status: 400 });
  } catch (err) {
    return apiError('agents/[id]/skills/[skillId]', err);
  }
}

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
