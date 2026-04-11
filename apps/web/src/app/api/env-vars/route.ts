/**
 * @fileoverview REST API for the platform env vars store.
 *
 * GET  /api/env-vars — List all env var keys + metadata (values never returned)
 * POST /api/env-vars — Create or update an env var
 *
 * @module web/api/env-vars
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAllEnvVars, setEnvVar } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

/**
 * GET /api/env-vars
 * Returns all env var keys and descriptions. Values are never included.
 *
 * @returns {Promise<NextResponse>} JSON array of { key, description, updatedAt }.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const vars = await getAllEnvVars();
    return NextResponse.json(vars);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/env-vars
 * Creates or updates an env var. Requires editor role or above.
 *
 * @param {NextRequest} request - Body: { key: string, value: string, description?: string }
 * @returns {Promise<NextResponse>} 201 on success.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(request);
  if (denied) return denied;
  try {
    const { key, value, description } = (await request.json()) as {
      key: string;
      value: string;
      description?: string;
    };
    if (!key || !value) {
      return NextResponse.json({ error: 'key and value are required' }, { status: 400 });
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      return NextResponse.json(
        { error: 'key must be uppercase letters, digits, and underscores (e.g. DATABASE_URL)' },
        { status: 400 }
      );
    }
    await setEnvVar(key, value, description);
    return NextResponse.json({ key }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
