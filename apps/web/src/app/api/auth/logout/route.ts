/**
 * @fileoverview Logout API — clears the session cookie.
 *
 * POST /api/auth/logout
 *
 * @module web/api/auth/logout
 */

import { NextResponse } from 'next/server';
import { COOKIE_NAME } from '@/lib/auth';

/**
 * Clears the auth session cookie.
 *
 * @returns {Promise<NextResponse>} JSON confirmation.
 */
export async function POST(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
