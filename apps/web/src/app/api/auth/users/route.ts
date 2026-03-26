/**
 * @fileoverview User management API — list and create users.
 *
 * GET  /api/auth/users — list all users (admin only).
 * POST /api/auth/users — create a user `{ username, password, role }` (admin only).
 *
 * @module web/api/auth/users
 */

import { NextResponse } from 'next/server';
import { requireRole, hashPassword } from '@/lib/auth';
import { getAllUsers, createUser } from '@/lib/db';

/**
 * Lists all platform users (excluding password hashes).
 *
 * @param {Request} req - Incoming request.
 * @returns {Promise<NextResponse>} JSON array of users.
 */
export async function GET(req: Request): Promise<NextResponse> {
  try {
    requireRole(req, 'admin');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const users = await getAllUsers();
  return NextResponse.json(users);
}

/**
 * Creates a new platform user.
 *
 * @param {Request} req - JSON body with `username`, `password`, `role`.
 * @returns {Promise<NextResponse>} Created user JSON.
 */
export async function POST(req: Request): Promise<NextResponse> {
  try {
    requireRole(req, 'admin');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { username, password, role } = await req.json();

  if (!username || !password) {
    return NextResponse.json({ error: 'username and password required' }, { status: 400 });
  }
  if (role && !['admin', 'editor', 'viewer'].includes(role)) {
    return NextResponse.json({ error: 'role must be admin, editor, or viewer' }, { status: 400 });
  }

  try {
    const hash = await hashPassword(password);
    const user = await createUser(username, hash, role || 'viewer');
    return NextResponse.json(user, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return NextResponse.json({ error: 'Username already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
