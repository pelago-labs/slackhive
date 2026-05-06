import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getWikiFolder, getWikiSource, getSetting, setSetting } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; sourceId: string }> }): Promise<NextResponse> {
  try {
    const { sourceId } = await params;
    const { searchParams } = new URL(req.url);
    const requestId = searchParams.get('requestId') ?? (await getSetting(`wiki-source-build-latest:${sourceId}`));
    if (!requestId) return NextResponse.json({ status: 'idle' });
    const raw = await getSetting(`wiki-build:${requestId}`);
    if (!raw) return NextResponse.json({ status: 'idle' });
    return NextResponse.json(JSON.parse(raw));
  } catch (err) {
    return apiError('wiki-folders/[id]/sources/[sourceId]/sync GET', err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; sourceId: string }> }): Promise<NextResponse> {
  const deny = guardAdmin(req);
  if (deny) return deny;
  try {
    const { id, sourceId } = await params;
    const folder = await getWikiFolder(id);
    if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
    const source = await getWikiSource(sourceId);
    if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 });

    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    await setSetting(`wiki-build:${requestId}`, JSON.stringify({ status: 'pending', folderId: id, sourceId, startedAt }));
    await setSetting(`wiki-source-build-latest:${sourceId}`, requestId);
    await setSetting(`wiki-build-latest:${id}`, requestId);

    const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
    fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'build-wiki-source', folderId: id, sourceId, requestId }),
    }).catch(() => null);

    return NextResponse.json({ requestId });
  } catch (err) {
    return apiError('wiki-folders/[id]/sources/[sourceId]/sync POST', err);
  }
}
