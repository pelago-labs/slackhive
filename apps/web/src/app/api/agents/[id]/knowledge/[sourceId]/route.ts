/**
 * @fileoverview DELETE /api/agents/[id]/knowledge/[sourceId]
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
  const { sourceId } = await params;
  await (await db()).query('DELETE FROM knowledge_sources WHERE id = $1', [sourceId]);
  return new NextResponse(null, { status: 204 });
}
