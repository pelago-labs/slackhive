/**
 * @fileoverview Login API — authenticates user and sets session cookie.
 *
 * POST /api/auth/login — accepts `{ username, password }`.
 *
 * @module web/api/auth/login
 */

import { NextResponse } from 'next/server';
import { authenticateUser, signSession, COOKIE_NAME } from '@/lib/auth';

/**
 * Authenticates a user and sets an HMAC-signed session cookie.
 *
 * @param {Request} req - JSON body with `username` and `password`.
 * @returns {Promise<NextResponse>} JSON response with role or 401.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const { username, password } = await req.json();

  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
  }

  const session = await authenticateUser(username, password);
  if (!session) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const cookie = signSession(session);
  const res = NextResponse.json({ ok: true, username: session.username, role: session.role });
  res.cookies.set(COOKIE_NAME, cookie, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
  return res;
}
