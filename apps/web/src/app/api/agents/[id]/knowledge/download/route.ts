/**
 * @fileoverview GET /api/agents/[id]/knowledge/download
 * Streams a .tar.gz archive of the agent's compiled wiki + sources metadata.
 *
 * Archive contents:
 *   wiki/index.md
 *   wiki/modules/...
 *   wiki/concepts/...
 *   sources.json   ← knowledge_sources metadata (no content/credentials)
 *
 * @module web/api/agents/[id]/knowledge/download
 */

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

async function db() {
  const { getDb, initDb } = await import('@slackhive/shared');
  try { return getDb(); } catch { await initDb(); return getDb(); }
}

async function getAgentByIdRow(agentId: string): Promise<{ slug: string; name: string } | null> {
  const r = await (await db()).query('SELECT slug, name FROM agents WHERE id = $1', [agentId]);
  return r.rows[0] ? { slug: r.rows[0].slug as string, name: r.rows[0].name as string } : null;
}

function getWikiDir(slug: string): string {
  const base = process.env.AGENTS_TMP_DIR ?? (
    process.env.DATABASE_TYPE === 'sqlite'
      ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.slackhive', 'agents')
      : '/tmp/agents'
  );
  return path.join(base, slug, 'knowledge', 'wiki');
}

/** Recursively list all files in a directory with their relative paths. */
function listFiles(dir: string, prefix = ''): { rel: string; abs: string }[] {
  const results: { rel: string; abs: string }[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(abs, rel));
    } else {
      results.push({ rel, abs });
    }
  }
  return results;
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams
): Promise<Response> {
  const { id } = await params;
  const agent = await getAgentByIdRow(id);
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  const wikiDir = getWikiDir(agent.slug);
  const files = listFiles(wikiDir);
  if (files.length === 0) {
    return NextResponse.json({ error: 'No wiki found — build the wiki first' }, { status: 404 });
  }

  // Fetch sources metadata (no content/credentials)
  const sourcesResult = await (await db()).query(
    `SELECT name, type, url, repo_url, branch, status, word_count, last_synced
     FROM knowledge_sources WHERE agent_id = $1 ORDER BY created_at`,
    [id]
  );
  const sources = sourcesResult.rows.map(r => ({
    name: r.name,
    type: r.type,
    url: r.url ?? null,
    repoUrl: r.repo_url ?? null,
    branch: r.branch ?? null,
    status: r.status,
    wordCount: r.word_count,
    lastSynced: r.last_synced ?? null,
  }));

  // Build tar.gz in memory using tar-stream + zlib.
  // Attach the gz consumer BEFORE writing any entries — otherwise gz's
  // internal buffer fills (16KB high-water), backpressure halts pack,
  // and `pack.entry()` callbacks never fire. That deadlock is what caused
  // large-wiki downloads to hang.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tar = require('tar-stream') as typeof import('tar-stream');
  const pack = tar.pack();
  const gz = zlib.createGzip();
  pack.pipe(gz);

  const chunks: Buffer[] = [];
  const gzDone = new Promise<Buffer>((resolve, reject) => {
    gz.on('data', (chunk: Buffer) => chunks.push(chunk));
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
  });

  // Add wiki files
  for (const { rel, abs } of files) {
    const content = fs.readFileSync(abs);
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: `wiki/${rel}`, size: content.length }, content, (err?: Error | null) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  // Add sources.json
  const sourcesJson = Buffer.from(JSON.stringify(sources, null, 2), 'utf-8');
  await new Promise<void>((resolve, reject) => {
    pack.entry({ name: 'sources.json', size: sourcesJson.length }, sourcesJson, (err?: Error | null) => {
      if (err) reject(err); else resolve();
    });
  });

  pack.finalize();
  const body = await gzDone;

  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${agent.slug}-wiki.tar.gz"`,
      'Content-Length': String(body.length),
    },
  });
}
