/**
 * @fileoverview DELETE /api/agents/[id]/knowledge/[sourceId]
 *
 * Deletes a source and marks the wiki as stale. The wiki stays intact
 * (agent can still use it) until user clicks Build Wiki, which triggers
 * a full rebuild since all remaining sources are reset to pending.
 *
 * @module web/api/agents/[id]/knowledge/[sourceId]
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

async function db() {
  const { getDb, initDb } = await import('@slackhive/shared');
  try { return getDb(); } catch { await initDb(); return getDb(); }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; sourceId: string }> }
): Promise<NextResponse> {
  const { id: agentId, sourceId } = await params;
  const d = await db();

  // Delete the source
  await d.query('DELETE FROM knowledge_sources WHERE id = $1', [sourceId]);

  // Mark remaining sources as pending — next Build Wiki does a full rebuild
  // Wiki stays on disk so agent can still use it until then
  await d.query(
    "UPDATE knowledge_sources SET status = 'pending' WHERE agent_id = $1",
    [agentId]
  );

  return new NextResponse(null, { status: 204 });
}
