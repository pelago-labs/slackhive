import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getWikiFolder, getWikiSources } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

const KNOWLEDGE_DIR = path.join(os.homedir(), '.slackhive', 'knowledge');

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { id } = await params;
    const wikiDir = path.join(KNOWLEDGE_DIR, id, 'wiki');
    const exists = fs.existsSync(wikiDir);
    const pages = exists ? fs.readdirSync(wikiDir).filter(f => f.endsWith('.md')) : [];
    const sources = await getWikiSources(id);
    return NextResponse.json({ pages: pages.length, sources: sources.length, built: exists });
  } catch (err) {
    return apiError('wiki-folders/[id]/build', err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const deny = guardAdmin(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    const folder = await getWikiFolder(id);
    if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });

    // Send build event to runner via shared event mechanism
    const runnerUrl = process.env.RUNNER_URL ?? 'http://localhost:3001';
    const resp = await fetch(`${runnerUrl}/internal/build-wiki`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: id }),
    }).catch(() => null);

    if (!resp?.ok) {
      return NextResponse.json({ error: 'Runner unavailable — start the runner to build wikis' }, { status: 503 });
    }

    return NextResponse.json({ ok: true, message: 'Build started' });
  } catch (err) {
    return apiError('wiki-folders/[id]/build', err);
  }
}
