/**
 * @fileoverview GET /api/agents/[id]/knowledge/wiki
 * Lists wiki articles and optionally returns article content.
 *
 * GET /api/agents/:id/knowledge/wiki          → list all articles
 * GET /api/agents/:id/knowledge/wiki?path=xxx → return article content
 *
 * @module web/api/agents/[id]/knowledge/wiki
 */

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

async function db() {
  const { getDb, initDb } = await import('@slackhive/shared');
  try { return getDb(); } catch { await initDb(); return getDb(); }
}

/** Resolve agent slug from ID. */
async function getAgentSlug(agentId: string): Promise<string | null> {
  const r = await (await db()).query('SELECT slug FROM agents WHERE id = $1', [agentId]);
  return r.rows[0]?.slug as string | null;
}

/** Get wiki directory for an agent. */
function getWikiDir(slug: string): string {
  const base = process.env.AGENTS_TMP_DIR ?? (
    process.env.DATABASE_TYPE === 'sqlite'
      ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.slackhive', 'agents')
      : '/tmp/agents'
  );
  return path.join(base, slug, 'knowledge', 'wiki');
}

/** Recursively list .md files in a directory, returning relative paths. */
function listArticles(dir: string, prefix = ''): { path: string; title: string; size: number }[] {
  const results: { path: string; title: string; size: number }[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listArticles(path.join(dir, entry.name), relPath));
    } else if (entry.name.endsWith('.md')) {
      const fullPath = path.join(dir, entry.name);
      const content = fs.readFileSync(fullPath, 'utf-8');
      // Extract title from first heading or filename
      const titleMatch = content.match(/^#\s+(.+)/m);
      const title = titleMatch ? titleMatch[1] : entry.name.replace('.md', '');
      results.push({ path: relPath, title, size: content.split(/\s+/).length });
    }
  }
  return results;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const slug = await getAgentSlug(id);
  if (!slug) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  const wikiDir = getWikiDir(slug);
  const articlePath = req.nextUrl.searchParams.get('path');

  // Return specific article content
  if (articlePath) {
    // Sanitize path to prevent directory traversal
    const safe = articlePath.replace(/\.\./g, '').replace(/^\//, '');
    const fullPath = path.join(wikiDir, safe);
    if (!fullPath.startsWith(wikiDir) || !fs.existsSync(fullPath)) {
      return NextResponse.json({ error: 'Article not found' }, { status: 404 });
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    return NextResponse.json({ path: safe, content });
  }

  // List all articles
  const articles = listArticles(wikiDir);
  const totalWords = articles.reduce((sum, a) => sum + a.size, 0);

  // Get last modified time of wiki dir
  let lastBuilt: string | null = null;
  try {
    const stat = fs.statSync(wikiDir);
    lastBuilt = stat.mtime.toISOString();
  } catch { /* dir might not exist */ }

  return NextResponse.json({ articles, totalWords, lastBuilt });
}
