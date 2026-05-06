import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ sourceId: string }> }): Promise<NextResponse> {
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
