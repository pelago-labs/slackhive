/**
 * @fileoverview Delete user API.
 *
 * DELETE /api/auth/users/[id]
 *
 * @module web/api/auth/users/[id]
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { deleteUser } from '@/lib/db';

/**
 * Deletes a user by ID (admin only).
 *
 * @param {Request} req - Incoming request.
 * @param {{ params: Promise<{ id: string }> }} ctx - Route params.
 * @returns {Promise<NextResponse>} 204 on success.
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
