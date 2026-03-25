/**
 * @fileoverview DELETE /api/agents/[id]/skills/[skillId]
 * Removes a skill file and triggers a reload event.
 *
 * @module web/api/agents/[id]/skills/[skillId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteSkill, publishAgentEvent } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';

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
    await deleteSkill(skillId);
    await publishAgentEvent({ type: 'reload', agentId: id });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
