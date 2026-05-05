import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { updateWikiSource, deleteWikiSource } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; sourceId: string }> }): Promise<NextResponse> {
  const deny = guardAdmin(req);
  if (deny) return deny;
  try {
    const { sourceId } = await params;
    const body = await req.json();
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
