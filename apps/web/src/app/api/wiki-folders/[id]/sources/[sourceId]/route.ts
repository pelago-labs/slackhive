import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { updateWikiSource, deleteWikiSource, getWikiSource } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; sourceId: string }> }): Promise<NextResponse> {
  const deny = guardAdmin(req);
  if (deny) return deny;
  try {
    const { sourceId } = await params;
    const body = await req.json();
    const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
    if (body.content && Buffer.byteLength(body.content, 'utf-8') > MAX_CONTENT_BYTES) {
      return NextResponse.json({ error: 'File content exceeds 2 MB limit' }, { status: 413 });
    }
    const existing = await getWikiSource(sourceId);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Mark stale when file/url content changes and source is already compiled
    if (existing.type !== 'repo' && existing.status === 'compiled' && (body.content !== undefined || body.url !== undefined)) {
      body.status = 'stale';
    }
    const source = await updateWikiSource(sourceId, body);
    if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(source);
  } catch (err) {
    return apiError('wiki-folders/[id]/sources/[sourceId]', err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; sourceId: string }> }): Promise<NextResponse> {
  const deny = guardAdmin(req);
  if (deny) return deny;
  try {
    const { sourceId } = await params;
    await deleteWikiSource(sourceId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError('wiki-folders/[id]/sources/[sourceId]', err);
  }
}
