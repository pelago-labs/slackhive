/**
 * @fileoverview Current user API — returns session info from cookie.
 *
 * GET /api/auth/me
 *
 * @module web/api/auth/me
 */

import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Returns the current user's username and role from the session cookie.
 *
 * @param {Request} req - Incoming request.
 * @returns {Promise<NextResponse>} JSON with user info or 401.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  return NextResponse.json({ username: session.username, role: session.role });
}
