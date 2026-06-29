/**
 * @fileoverview POST /api/recovery-key/export — download the encryption key wrapped
 * under an admin-chosen password (for disaster recovery on a fresh host). Superadmin
 * only. The plaintext key never leaves the runner unwrapped.
 *
 * Body: { password } (min length enforced by the runner). Returns the recovery JSON blob.
 *
 * @module web/api/recovery-key/export
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardSuperadmin } from '@/lib/api-guard';
import { runnerBase } from '@/lib/runner';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardSuperadmin(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const up = await fetch(`${runnerBase()}/recovery-key/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: body?.password ?? '' }),
  }).catch(() => null);
  if (!up) return NextResponse.json({ error: 'runner unreachable' }, { status: 502 });
  const out = await up.json().catch(() => ({ error: 'bad runner response' }));
  return NextResponse.json(out, { status: up.status });
}
