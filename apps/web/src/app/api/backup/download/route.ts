/**
 * @fileoverview GET /api/backup/download?name=… — stream a backup file for download.
 * Proxies the runner's traversal-guarded file stream. Superadmin only (the file is the
 * full encrypted database).
 *
 * @module web/api/backup/download
 */

import { NextRequest, NextResponse } from 'next/server';
import { BACKUP_NAME_RE } from '@slackhive/shared';
import { guardSuperadmin } from '@/lib/api-guard';
import { runnerBase } from '@/lib/runner';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const denied = guardSuperadmin(req);
  if (denied) return denied;

  const name = req.nextUrl.searchParams.get('name') ?? '';
  // Defense in depth: validate web-side too (don't reflect an arbitrary name into the
  // download header or the runner), not just rely on the runner's allowlist.
  if (!BACKUP_NAME_RE.test(name)) {
    return NextResponse.json({ error: 'invalid backup name' }, { status: 400 });
  }
  const up = await fetch(`${runnerBase()}/backup-file?name=${encodeURIComponent(name)}`).catch(() => null);
  if (!up || !up.ok || !up.body) {
    return NextResponse.json({ error: 'backup not found' }, { status: up?.status ?? 502 });
  }
  // Pass the runner's stream straight through with download headers.
  return new Response(up.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      ...(up.headers.get('content-length') ? { 'Content-Length': up.headers.get('content-length')! } : {}),
    },
  });
}
