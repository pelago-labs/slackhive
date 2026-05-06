import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardAuth } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ sourceId: string }> }): Promise<NextResponse> {
  const deny = guardAuth(req);
  if (deny) return deny;
  try {
    const { sourceId } = await params;
    const { getWikiSourceFolder } = await import('@/lib/db');
    const folderId = await getWikiSourceFolder(sourceId);
    if (!folderId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ id: sourceId, folderId });
  } catch (err) {
    return apiError('wiki-sources/[sourceId]', err);
  }
}
