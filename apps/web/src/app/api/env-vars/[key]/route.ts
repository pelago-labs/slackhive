/**
 * @fileoverview REST API for a single env var entry.
 *
 * PUT    /api/env-vars/[key] — Update value and/or description
 * DELETE /api/env-vars/[key] — Remove the env var
 *
 * @module web/api/env-vars/[key]
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { setEnvVar, updateEnvVarDescription, deleteEnvVar } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

/**
 * PUT /api/env-vars/[key]
 * Updates an env var. Supply value to replace it, description to update label.
 * At least one of value or description must be provided.
 *
 * @param {NextRequest} request - Body: { value?: string, description?: string }
 * @param {{ params: { key: string } }} context - Route params.
 * @returns {Promise<NextResponse>}
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
): Promise<NextResponse> {
  const denied = guardAdmin(request);
  if (denied) return denied;
  try {
    const { key } = await params;
    const body = (await request.json()) as { value?: string; description?: string };
    if (body.value !== undefined) {
      await setEnvVar(key, body.value, body.description);
    } else if (body.description !== undefined) {
      await updateEnvVarDescription(key, body.description);
    } else {
      return NextResponse.json({ error: 'value or description required' }, { status: 400 });
    }
    return NextResponse.json({ key });
  } catch (err) {
    return apiError('env-vars/[key]', err);
  }
}

/**
 * DELETE /api/env-vars/[key]
 * Removes an env var from the store.
 *
 * @param {NextRequest} request - Incoming request.
 * @param {{ params: { key: string } }} context - Route params.
 * @returns {Promise<NextResponse>}
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
): Promise<NextResponse> {
  const denied = guardAdmin(request);
  if (denied) return denied;
  try {
    const { key } = await params;
    await deleteEnvVar(key);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError('env-vars/[key]', err);
  }
}
