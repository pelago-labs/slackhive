import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getWikiFolder, getWikiSources, createWikiSource } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { id } = await params;
    const sources = await getWikiSources(id);
    return NextResponse.json(sources);
  } catch (err) {
    return apiError('wiki-folders/[id]/sources', err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const deny = guardAdmin(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    const folder = await getWikiFolder(id);
    if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
    const body = await req.json();
    if (!body.type || !body.name?.trim()) return NextResponse.json({ error: 'type and name are required' }, { status: 400 });
    const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
    if (body.content && Buffer.byteLength(body.content, 'utf-8') > MAX_CONTENT_BYTES) {
      return NextResponse.json({ error: 'File content exceeds 2 MB limit' }, { status: 413 });
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
