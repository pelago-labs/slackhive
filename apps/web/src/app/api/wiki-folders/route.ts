import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getAllWikiFolders, createWikiFolder } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const folders = await getAllWikiFolders();
    return NextResponse.json(folders);
  } catch (err) {
    return apiError('wiki-folders', err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const deny = guardAdmin(req);
  if (deny) return deny;
  try {
    const session = getSessionFromRequest(req);
    const body = await req.json();
    if (!body.name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    const folder = await createWikiFolder({ name: body.name.trim(), description: body.description }, session?.username ?? 'admin');
    return NextResponse.json(folder, { status: 201 });
  } catch (err) {
    return apiError('wiki-folders', err);
  }
}
