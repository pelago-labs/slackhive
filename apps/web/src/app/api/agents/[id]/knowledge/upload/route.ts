/**
 * @fileoverview POST /api/agents/[id]/knowledge/upload
 * Accepts a .tar.gz wiki archive and extracts it into the agent's wiki directory.
 *
 * Expects multipart/form-data with a single "file" field containing the archive.
 * Overwrites the existing wiki. Triggers an agent reload so CLAUDE.md is recompiled.
 *
 * @module web/api/agents/[id]/knowledge/upload
 */

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

async function db() {
  const { getDb, initDb } = await import('@slackhive/shared');
  try { return getDb(); } catch { await initDb(); return getDb(); }
}

async function getAgentSlug(agentId: string): Promise<string | null> {
  const r = await (await db()).query('SELECT slug FROM agents WHERE id = $1', [agentId]);
  return r.rows[0]?.slug as string | null;
}

function getWikiDir(slug: string): string {
  const base = process.env.AGENTS_TMP_DIR ?? (
    process.env.DATABASE_TYPE === 'sqlite'
      ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.slackhive', 'agents')
      : '/tmp/agents'
  );
  return path.join(base, slug, 'knowledge', 'wiki');
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { id } = await params;

  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;

  const slug = await getAgentSlug(id);
  if (!slug) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart request' }, { status: 400 });
  }

  const file = formData.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tar = require('tar-stream') as typeof import('tar-stream');

  const wikiDir = getWikiDir(slug);

  // Clear existing wiki before extraction
  if (fs.existsSync(wikiDir)) {
    fs.rmSync(wikiDir, { recursive: true, force: true });
  }
  fs.mkdirSync(wikiDir, { recursive: true });

  let articleCount = 0;

  await new Promise<void>((resolve, reject) => {
    const extract = tar.extract();
    const gunzip = zlib.createGunzip();

    extract.on('entry', (header: import('tar-stream').Headers, stream: NodeJS.ReadableStream & { resume(): void }, next: () => void) => {
      const entryName = header.name;

      // Only extract wiki/* files — skip sources.json and any other metadata
      if (!entryName.startsWith('wiki/') || header.type !== 'file') {
        stream.resume();
        next();
        return;
      }

      const relPath = entryName.slice('wiki/'.length); // strip leading "wiki/"
      if (!relPath) { stream.resume(); next(); return; }

      // Sanitize — prevent path traversal
      const safe = relPath.replace(/\.\./g, '').replace(/^\//, '');
      const destPath = path.join(wikiDir, safe);

      // Ensure destination is inside wikiDir
      if (!destPath.startsWith(wikiDir)) { stream.resume(); next(); return; }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        fs.writeFileSync(destPath, Buffer.concat(chunks));
        if (safe.endsWith('.md')) articleCount++;
        next();
      });
      stream.on('error', reject);
    });

    extract.on('finish', resolve);
    extract.on('error', reject);
    gunzip.on('error', reject);

    // Pipe: buffer → gunzip → extract
    const readable = new (require('stream').Readable)() as NodeJS.ReadableStream;
    (readable as any).push(buffer);
    (readable as any).push(null);
    (readable as any).pipe(gunzip).pipe(extract);
  });

  // Trigger agent reload so CLAUDE.md picks up the restored wiki
  try {
    const { publishAgentEvent } = await import('@/lib/db');
    await publishAgentEvent({ type: 'reload', agentId: id });
  } catch { /* non-fatal */ }

  return NextResponse.json({ articles: articleCount });
}
