/**
 * @fileoverview GET /api/backup/list — list existing database backups.
 * Proxies to the runner. Superadmin only.
 *
 * @module web/api/backup/list
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardSuperadmin } from '@/lib/api-guard';
import { runnerBase } from '@/lib/runner';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = guardSuperadmin(req);
  if (denied) return denied;

  const up = await fetch(`${runnerBase()}/backups`).catch(() => null);
  if (!up) return NextResponse.json({ backups: [], error: 'runner unreachable' }, { status: 502 });
  const body = await up.json().catch(() => ({ backups: [] }));
  return NextResponse.json(body, { status: up.status });
}
