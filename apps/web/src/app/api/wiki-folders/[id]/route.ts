import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getWikiFolder, updateWikiFolder, deleteWikiFolder } from '@/lib/db';
import { guardAuth } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

const KNOWLEDGE_DIR = path.join(os.homedir(), '.slackhive', 'knowledge');

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const deny = guardAuth(req);
  if (deny) return deny;
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
  const deny = guardAuth(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    const folder = await getWikiFolder(id);
    if (!folder) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const session = getSessionFromRequest(req)!;
    const isAdmin = session.role === 'admin' || session.role === 'superadmin';
    if (!isAdmin && folder.createdBy !== session.username) {
      return NextResponse.json({ error: 'Only the folder owner or an admin can edit this folder' }, { status: 403 });
    }
    const body = await req.json();
    const updated = await updateWikiFolder(id, { name: body.name, description: body.description });
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    return apiError('wiki-folders/[id]', err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const deny = guardAuth(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    const folder = await getWikiFolder(id);
    if (!folder) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const session = getSessionFromRequest(req)!;
    const isAdmin = session.role === 'admin' || session.role === 'superadmin';
    if (!isAdmin && folder.createdBy !== session.username) {
      return NextResponse.json({ error: 'Only the folder owner or an admin can delete this folder' }, { status: 403 });
    }
    await deleteWikiFolder(id);
    // Clean up built wiki from disk
    const dir = path.join(KNOWLEDGE_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError('wiki-folders/[id]', err);
  }
}
