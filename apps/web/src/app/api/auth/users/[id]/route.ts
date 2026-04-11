/**
 * @fileoverview User management API — delete and update role.
 *
 * DELETE /api/auth/users/[id] — Delete a user (admin only)
 * PATCH  /api/auth/users/[id] — Update a user's role (admin only)
 *
 * @module web/api/auth/users/[id]
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { deleteUser, updateUserRole } from '@/lib/db';

export const dynamic = 'force-dynamic';

const VALID_ROLES = ['admin', 'editor', 'viewer'];

/**
 * Deletes a user by ID (admin only).
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    requireRole(req, 'admin');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { id } = await params;
  await deleteUser(id);
  return new NextResponse(null, { status: 204 });
}

/**
 * Updates a user's role (admin only).
 * Body: { role: 'admin' | 'editor' | 'viewer' }
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    requireRole(req, 'admin');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { role } = body;
  if (!role || !VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 });
  }
  await updateUserRole(id, role);
  return NextResponse.json({ id, role });
}
