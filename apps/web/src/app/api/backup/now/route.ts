/**
 * @fileoverview POST /api/backup/now — trigger an immediate database backup.
 * Proxies to the runner (which owns the live DB handle). Superadmin only.
 *
 * @module web/api/backup/now
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardSuperadmin } from '@/lib/api-guard';
import { runnerBase } from '@/lib/runner';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardSuperadmin(req);
  if (denied) return denied;

  const up = await fetch(`${runnerBase()}/backup-now`, { method: 'POST' }).catch(() => null);
  if (!up) return NextResponse.json({ error: 'runner unreachable' }, { status: 502 });
  const body = await up.json().catch(() => ({ error: 'bad runner response' }));
  return NextResponse.json(body, { status: up.status });
}
