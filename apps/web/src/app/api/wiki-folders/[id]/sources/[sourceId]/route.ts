import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { updateWikiSource, deleteWikiSource, getWikiSource, getWikiFolder, getEnvVarCreatedBy } from '@/lib/db';
import { guardAuth } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; sourceId: string }> }): Promise<NextResponse> {
  const deny = guardAuth(req);
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
    const folder = await getWikiFolder(existing.folderId);
    const session = getSessionFromRequest(req)!;
    const isAdmin = session.role === 'admin' || session.role === 'superadmin';
    if (!isAdmin && folder?.createdBy !== session.username) {
      return NextResponse.json({ error: 'Only the folder owner or an admin can edit sources' }, { status: 403 });
    }
    if (!isAdmin && body.patEnvRef) {
      const owner = await getEnvVarCreatedBy(body.patEnvRef);
      if (owner !== session.username) {
        return NextResponse.json({ error: 'You can only reference env vars you own' }, { status: 403 });
      }
    }
    // Mark stale when any field that affects the compiled output changes
    if (existing.status === 'compiled' && (
      body.content !== undefined || body.url !== undefined ||
      body.repoUrl !== undefined || body.branch !== undefined || body.patEnvRef !== undefined
    )) {
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
  const deny = guardAuth(req);
  if (deny) return deny;
  try {
    const { sourceId } = await params;
    const existing = await getWikiSource(sourceId);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const folder = await getWikiFolder(existing.folderId);
    const session = getSessionFromRequest(req)!;
    const isAdmin = session.role === 'admin' || session.role === 'superadmin';
    if (!isAdmin && folder?.createdBy !== session.username) {
      return NextResponse.json({ error: 'Only the folder owner or an admin can delete sources' }, { status: 403 });
    }
    await deleteWikiSource(sourceId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError('wiki-folders/[id]/sources/[sourceId]', err);
  }
}
