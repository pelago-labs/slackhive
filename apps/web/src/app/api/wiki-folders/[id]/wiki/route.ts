import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardAuth } from '@/lib/api-guard';
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
    const { searchParams } = new URL(req.url);
    const filePath = searchParams.get('path');

    const wikiDir = path.join(KNOWLEDGE_DIR, id, 'wiki');

    if (filePath) {
      // Read a specific page — prevent path traversal
      const safe = path.resolve(wikiDir, filePath);
      if (!safe.startsWith(wikiDir)) return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
      if (!fs.existsSync(safe)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const content = fs.readFileSync(safe, 'utf8');
      return NextResponse.json({ content, path: filePath });
    }

    // List all wiki pages
    if (!fs.existsSync(wikiDir)) return NextResponse.json({ pages: [] });

    const pages: { path: string; title: string; size: number }[] = [];
    function walk(dir: string, prefix = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else if (entry.name.endsWith('.md')) {
          const full = path.join(dir, entry.name);
          const stat = fs.statSync(full);
          const firstLine = fs.readFileSync(full, 'utf8').split('\n')[0].replace(/^#+\s*/, '').trim();
          pages.push({ path: rel, title: firstLine || rel, size: stat.size });
        }
      }
    }
    walk(wikiDir);
    return NextResponse.json({ pages });
  } catch (err) {
    return apiError('wiki-folders/[id]/wiki', err);
  }
}
