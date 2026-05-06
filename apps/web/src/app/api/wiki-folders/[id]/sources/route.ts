import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getWikiFolder, getWikiSources, createWikiSource, getEnvVarCreatedBy } from '@/lib/db';
import { guardAuth } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const deny = guardAuth(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    const sources = await getWikiSources(id);
    return NextResponse.json(sources);
  } catch (err) {
    return apiError('wiki-folders/[id]/sources', err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const deny = guardAuth(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    const folder = await getWikiFolder(id);
    if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
    const session = getSessionFromRequest(req)!;
    const isAdmin = session.role === 'admin' || session.role === 'superadmin';
    if (!isAdmin && folder.createdBy !== session.username) {
      return NextResponse.json({ error: 'Only the folder owner or an admin can add sources' }, { status: 403 });
    }
    const body = await req.json();
    if (!body.type || !body.name?.trim()) return NextResponse.json({ error: 'type and name are required' }, { status: 400 });
    const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
    if (body.content && Buffer.byteLength(body.content, 'utf-8') > MAX_CONTENT_BYTES) {
      return NextResponse.json({ error: 'File content exceeds 2 MB limit' }, { status: 413 });
    }
    if (!isAdmin && body.patEnvRef) {
      const owner = await getEnvVarCreatedBy(body.patEnvRef);
      if (owner !== session.username) {
        return NextResponse.json({ error: 'You can only reference env vars you own' }, { status: 403 });
      }
    }
    const source = await createWikiSource(id, {
      type: body.type,
      name: body.name.trim(),
      url: body.url,
      repoUrl: body.repoUrl,
      branch: body.branch,
      patEnvRef: body.patEnvRef,
      content: body.content,
    });
    return NextResponse.json(source, { status: 201 });
  } catch (err) {
    return apiError('wiki-folders/[id]/sources', err);
  }
}
