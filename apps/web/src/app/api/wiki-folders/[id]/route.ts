import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getWikiFolder, updateWikiFolder, deleteWikiFolder } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

const KNOWLEDGE_DIR = path.join(os.homedir(), '.slackhive', 'knowledge');

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { id } = await params;
    const folder = await getWikiFolder(id);
    if (!folder) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(folder);
  } catch (err) {
    return apiError('wiki-folders/[id]', err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const deny = guardAdmin(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    const body = await req.json();
    const folder = await updateWikiFolder(id, { name: body.name, description: body.description });
    if (!folder) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(folder);
  } catch (err) {
    return apiError('wiki-folders/[id]', err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const deny = guardAdmin(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    await deleteWikiFolder(id);
    // Clean up built wiki from disk
    const dir = path.join(KNOWLEDGE_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError('wiki-folders/[id]', err);
  }
}
