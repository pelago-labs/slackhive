/**
 * @fileoverview Restore an agent to a previous snapshot.
 *
 * POST /api/agents/[id]/snapshots/[sid]/restore
 *
 * Replaces the agent's current skills, permissions, and MCP assignments
 * with the state captured in the snapshot, then triggers a runner reload.
 *
 * @module web/api/agents/[id]/snapshots/[sid]/restore
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import {
  getSnapshotById,
  deleteSkillsByAgent,
  upsertSkill,
  upsertPermissions,
  setAgentMcps,
  publishAgentEvent,
} from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

/**
 * POST /api/agents/[id]/snapshots/[sid]/restore
 * Restores an agent to the state captured in a snapshot.
 *
 * @returns {Promise<NextResponse>} 200 { ok: true } or error.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sid: string }> }
): Promise<NextResponse> {
  try {
    const { id, sid } = await params;
    const denied = await guardAgentWrite(request, id);
    if (denied) return denied;

    const snapshot = await getSnapshotById(sid);
    if (!snapshot) return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    if (snapshot.agentId !== id) return NextResponse.json({ error: 'Snapshot does not belong to this agent' }, { status: 400 });

    // Replace skills
    await deleteSkillsByAgent(id);
    for (const s of snapshot.skillsJson) {
      await upsertSkill(id, s.category, s.filename, s.content, s.sort_order);
    }

    // Replace permissions
    await upsertPermissions(id, snapshot.allowedTools, snapshot.deniedTools);

    // Replace MCP assignments
    await setAgentMcps(id, snapshot.mcpIds);

    // Trigger runner reload
    await publishAgentEvent({ type: 'reload', agentId: id });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError('agents/[id]/snapshots/[sid]/restore', err);
  }
}
