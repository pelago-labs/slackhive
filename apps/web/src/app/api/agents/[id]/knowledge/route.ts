/**
 * @fileoverview GET/POST /api/agents/[id]/knowledge
 * CRUD for knowledge sources (URLs, files, git repos).
 *
 * @module web/api/agents/[id]/knowledge
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import type { KnowledgeSource } from '@slackhive/shared';
import { extractFileText } from '@/lib/knowledge-extract';
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

async function db() {
  const { getDb, initDb } = await import('@slackhive/shared');
  try { return getDb(); } catch { await initDb(); return getDb(); }
}

function rowToSource(row: Record<string, unknown>): KnowledgeSource {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    type: row.type as KnowledgeSource['type'],
    name: row.name as string,
    url: row.url as string | undefined,
    repoUrl: row.repo_url as string | undefined,
    branch: (row.branch as string) ?? 'main',
    patEnvRef: row.pat_env_ref as string | undefined,
    syncCron: row.sync_cron as string | undefined,
    content: row.content as string | undefined,
    status: row.status as KnowledgeSource['status'],
    wordCount: (row.word_count as number) ?? 0,
    lastSynced: row.last_synced as string | undefined,
    createdAt: row.created_at as Date,
  };
}

/**
 * GET — list all knowledge sources for an agent.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const r = await (await db()).query(
    'SELECT * FROM knowledge_sources WHERE agent_id = $1 ORDER BY created_at DESC',
    [id]
  );
  return NextResponse.json(r.rows.map(rowToSource));
}

/**
 * POST — add a new knowledge source.
 * JSON body: { type, name, url?, repoUrl?, branch?, patEnvRef?, syncCron?, content? }
 * Multipart body (file sources): `name` + `file` fields.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: agentId } = await params;
  const denied = await guardAgentWrite(req, agentId);
  if (denied) return denied;
  const contentType = req.headers.get('content-type') || '';

  // Multipart: raw file upload. Extract text server-side and funnel into the
  // same insert path as the JSON route.
  if (contentType.startsWith('multipart/form-data')) {
    try {
      const form = await req.formData();
      const file = form.get('file');
      const name = String(form.get('name') || '');
      if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
      if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 });

      const buf = Buffer.from(await file.arrayBuffer());
      const extracted = await extractFileText(buf, file.name, file.type);
      if (extracted === null) {
        return NextResponse.json({ error: 'Unsupported file type — upload text or PDF' }, { status: 415 });
      }
      const text = extracted.slice(0, 1_048_576); // 1 MB cap
      const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

      const sourceId = randomUUID();
      await (await db()).query(
        `INSERT INTO knowledge_sources (id, agent_id, type, name, url, repo_url, branch, pat_env_ref, sync_cron, content, status, word_count)
         VALUES ($1, $2, 'file', $3, NULL, NULL, 'main', NULL, NULL, $4, 'pending', $5)`,
        [sourceId, agentId, name, text, wordCount]
      );
      const r = await (await db()).query('SELECT * FROM knowledge_sources WHERE id = $1', [sourceId]);
      return NextResponse.json(rowToSource(r.rows[0]), { status: 201 });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error('[knowledge-upload] failed', msg, err);
      return NextResponse.json({ error: `Upload failed: ${msg}` }, { status: 500 });
    }
  }

  const body = await req.json();
  const { type, name, url, repoUrl, branch, patEnvRef, syncCron, content } = body;

  if (!type || !name) {
    return NextResponse.json({ error: 'type and name required' }, { status: 400 });
  }
  if (type === 'url' && !url) {
    return NextResponse.json({ error: 'url required for URL sources' }, { status: 400 });
  }
  if (type === 'repo' && !repoUrl) {
    return NextResponse.json({ error: 'repoUrl required for repo sources' }, { status: 400 });
  }

  // For URL sources, fetch and convert to markdown at add time
  let resolvedContent = content ?? null;
  if (type === 'url' && !resolvedContent) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SlackHive/1.0; +https://slackhive.com)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const html = await res.text();
        const { Readability } = await import('@mozilla/readability');
        const { parseHTML } = await import('linkedom');
        const TurndownService = (await import('turndown')).default;

        // Extract article content with Readability (like Firefox Reader View)
        const { document } = parseHTML(html);
        const reader = new Readability(document as any);
        const article = reader.parse();

        const td = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
          bulletListMarker: '-',
        });

        if (article?.content) {
          const md = td.turndown(article.content);
          // If extracted content is too short, page is likely JS-rendered
          if (md.split(/\s+/).length < 20) {
            resolvedContent = `[Warning: This page appears to be JavaScript-rendered. Content may be incomplete.]\n\n${md}`;
          } else {
            resolvedContent = `# ${article.title || name}\n\n${md}`.slice(0, 100000);
          }
        } else {
          // Fallback: convert full HTML
          resolvedContent = td.turndown(html).slice(0, 100000);
        }
      }
    } catch { /* fetch failed — content stays null, wiki builder will skip */ }
  }

  const sourceId = randomUUID();
  const wordCount = resolvedContent ? resolvedContent.split(/\s+/).length : 0;

  await (await db()).query(
    `INSERT INTO knowledge_sources (id, agent_id, type, name, url, repo_url, branch, pat_env_ref, sync_cron, content, status, word_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [sourceId, agentId, type, name, url ?? null, repoUrl ?? null, branch ?? 'main', patEnvRef ?? null, syncCron ?? null, resolvedContent, 'pending', wordCount]
  );

  const r = await (await db()).query('SELECT * FROM knowledge_sources WHERE id = $1', [sourceId]);
  return NextResponse.json(rowToSource(r.rows[0]), { status: 201 });
}
