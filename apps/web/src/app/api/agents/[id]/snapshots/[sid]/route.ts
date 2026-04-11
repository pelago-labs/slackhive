/**
 * @fileoverview REST API routes for a single agent snapshot.
 *
 * GET    /api/agents/[id]/snapshots/[sid] — Get full snapshot (including compiledMd)
 * DELETE /api/agents/[id]/snapshots/[sid] — Delete snapshot
 *
 * @module web/api/agents/[id]/snapshots/[sid]
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSnapshotById, deleteSnapshot } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/[id]/snapshots/[sid]
 * Returns the full snapshot including compiledMd.
 *
 * @returns {Promise<NextResponse>} AgentSnapshot or 404.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; sid: string }> }
): Promise<NextResponse> {
  try {
    const { sid } = await params;
    const snapshot = await getSnapshotById(sid);
    if (!snapshot) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/[id]/snapshots/[sid]
 * Permanently deletes a snapshot.
 *
 * @returns {Promise<NextResponse>} 204 No Content.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sid: string }> }
): Promise<NextResponse> {
  try {
    const { id, sid } = await params;
    const denied = await guardAgentWrite(request, id);
    if (denied) return denied;
    await deleteSnapshot(sid);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
