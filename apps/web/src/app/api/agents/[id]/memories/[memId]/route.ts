/**
 * @fileoverview DELETE /api/agents/[id]/memories/[memId]
 * Removes a single memory entry for an agent.
 *
 * @module web/api/agents/[id]/memories/[memId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { deleteMemory, updateMemoryTier } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string; memId: string }> };

/**
 * DELETE /api/agents/[id]/memories/[memId]
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} 204 No Content or error.
 */
export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id, memId } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;
    await deleteMemory(memId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return apiError('agents/[id]/memories/[memId]', err);
  }
}

/**
 * PATCH /api/agents/[id]/memories/[memId]
 * Updates only tier fields (pinned/scope) — never content — so the Memories-tab
 * pin/scope controls can't overwrite a concurrent content update.
 */
export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id, memId } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;
    const body = (await req.json()) as { pinned?: boolean; scopeUserId?: string | null; scopeGroupId?: string | null };
    await updateMemoryTier(memId, body);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return apiError('agents/[id]/memories/[memId]', err);
  }
}
