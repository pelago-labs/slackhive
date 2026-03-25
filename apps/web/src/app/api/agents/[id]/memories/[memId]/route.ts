/**
 * @fileoverview DELETE /api/agents/[id]/memories/[memId]
 * Removes a single memory entry for an agent.
 *
 * @module web/api/agents/[id]/memories/[memId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteMemory } from '@/lib/db';

type RouteParams = { params: Promise<{ id: string; memId: string }> };

/**
 * DELETE /api/agents/[id]/memories/[memId]
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} 204 No Content or error.
 */
export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { memId } = await params;
    await deleteMemory(memId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
