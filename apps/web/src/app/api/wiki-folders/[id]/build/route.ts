import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getWikiFolder, getSetting, setSetting } from '@/lib/db';
import { guardAuth } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const deny = guardAuth(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const requestId = searchParams.get('requestId') ?? (await getSetting(`wiki-build-latest:${id}`));
    if (!requestId) return NextResponse.json({ status: 'idle' });
    const raw = await getSetting(`wiki-build:${requestId}`);
    if (!raw) return NextResponse.json({ status: 'idle' });
    return NextResponse.json(JSON.parse(raw));
  } catch (err) {
    return apiError('wiki-folders/[id]/build GET', err);
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
      return NextResponse.json({ error: 'Only the folder owner or an admin can build this folder' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const scratch = body.scratch === true;

    // Reject if a build is already in progress for this folder
    const latestRequestId = await getSetting(`wiki-build-latest:${id}`);
    if (latestRequestId) {
      const latestRaw = await getSetting(`wiki-build:${latestRequestId}`);
      if (latestRaw) {
        const latest = JSON.parse(latestRaw);
        if (latest.status === 'building' || latest.status === 'pending') {
          return NextResponse.json({ error: 'A build is already in progress for this folder.' }, { status: 409 });
        }
      }
    }

    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    await setSetting(`wiki-build:${requestId}`, JSON.stringify({ status: 'pending', folderId: id, startedAt }));
    await setSetting(`wiki-build-latest:${id}`, requestId);

    const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
    fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'build-wiki-folder', folderId: id, requestId, scratch }),
    }).catch(() => null);

    return NextResponse.json({ requestId });
  } catch (err) {
    return apiError('wiki-folders/[id]/build POST', err);
  }
}
