/**
 * @fileoverview User management API — delete, update role, reset password.
 *
 * DELETE /api/auth/users/[id] — Delete a user (admin+)
 * PATCH  /api/auth/users/[id] — Update role (admin+) and/or reset password (superadmin)
 *
 * @module web/api/auth/users/[id]
 */

import { NextResponse } from 'next/server';
import { hashPassword, requireRole } from '@/lib/auth';
import { deleteUser, updateUserPassword, updateUserRole } from '@/lib/db';

export const dynamic = 'force-dynamic';

const VALID_ROLES = ['admin', 'editor', 'viewer'];
const MIN_PASSWORD_LEN = 8;

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
 * Updates a user.
 * Body: { role?: 'admin' | 'editor' | 'viewer', password?: string }
 *
 * Role updates require admin+. Password resets require superadmin — resetting
 * another user's password is higher-risk than reassigning their role.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { role, password } = body as { role?: unknown; password?: unknown };

  if (role === undefined && password === undefined) {
    return NextResponse.json({ error: 'Provide role and/or password' }, { status: 400 });
  }

  if (role !== undefined) {
    try { requireRole(req, 'admin'); } catch {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (typeof role !== 'string' || !VALID_ROLES.includes(role)) {
      return NextResponse.json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 });
    }
    await updateUserRole(id, role);
  }

  if (password !== undefined) {
    try { requireRole(req, 'superadmin'); } catch {
      return NextResponse.json({ error: 'Only superadmin can reset passwords' }, { status: 403 });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` }, { status: 400 });
    }
    await updateUserPassword(id, await hashPassword(password));
  }

  return NextResponse.json({ id, ...(typeof role === 'string' ? { role } : {}) });
}
