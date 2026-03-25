/**
 * @fileoverview API route guard — returns 403 response if user lacks admin role.
 *
 * Usage in any mutating API handler:
 * ```ts
 * const denied = guardAdmin(req);
 * if (denied) return denied;
 * ```
 *
 * @module web/lib/api-guard
 */

import { NextResponse } from 'next/server';
import { getSessionFromRequest, type Role } from './auth';

/**
 * Returns a 403 NextResponse if the request lacks admin/superadmin role.
 * Returns null if the user has sufficient permissions.
 *
 * @param {Request} req - Incoming request.
 * @returns {NextResponse | null} 403 response or null if authorized.
 */
export function guardAdmin(req: Request): NextResponse | null {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const roleLevel: Record<Role, number> = { viewer: 0, admin: 1, superadmin: 2 };
  if ((roleLevel[session.role] ?? -1) < 1) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }
  return null;
}
