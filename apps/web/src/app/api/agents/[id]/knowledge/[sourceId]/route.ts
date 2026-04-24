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
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

async function db() {
  const { getDb, initDb } = await import('@slackhive/shared');
  try { return getDb(); } catch { await initDb(); return getDb(); }
}

/**
 * PATCH — update a source. Accepts any subset of:
 *   - content (file sources)
 *   - name, url (url sources)
 *   - repoUrl, branch, patEnvRef (repo sources)
 * Status resets to 'pending' so the next Build Wiki re-ingests.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sourceId: string }> }
): Promise<NextResponse> {
  const { id: agentId, sourceId } = await params;
  const denied = await guardAgentWrite(req, agentId);
  if (denied) return denied;
  const body = await req.json() as {
    name?: string;
    url?: string;
    content?: string;
    repoUrl?: string;
    branch?: string;
    patEnvRef?: string | null;
  };
  const d = await db();

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (body.name !== undefined)      { fields.push(`name = $${i++}`);         values.push(body.name); }
  if (body.url !== undefined)       { fields.push(`url = $${i++}`);          values.push(body.url || null); }
  if (body.repoUrl !== undefined)   { fields.push(`repo_url = $${i++}`);     values.push(body.repoUrl || null); }
  if (body.branch !== undefined)    { fields.push(`branch = $${i++}`);       values.push(body.branch || 'main'); }
  if (body.patEnvRef !== undefined) { fields.push(`pat_env_ref = $${i++}`);  values.push(body.patEnvRef || null); }
  if (body.content !== undefined) {
    const wordCount = body.content ? body.content.split(/\s+/).length : 0;
    fields.push(`content = $${i++}`);
    fields.push(`word_count = $${i++}`);
    values.push(body.content, wordCount);
  }

  if (fields.length === 0) {
    return NextResponse.json({ error: 'No editable fields provided' }, { status: 400 });
  }

  fields.push(`status = 'pending'`);
  values.push(sourceId);

  await d.query(
    `UPDATE knowledge_sources SET ${fields.join(', ')} WHERE id = $${i}`,
    values,
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sourceId: string }> }
): Promise<NextResponse> {
  const { id: agentId, sourceId } = await params;
  const denied = await guardAgentWrite(req, agentId);
  if (denied) return denied;
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
