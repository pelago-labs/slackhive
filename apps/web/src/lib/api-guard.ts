/**
 * @fileoverview API route guards — role-based access control for mutations.
 *
 * guardEditor: allows editor, admin, superadmin (blocks viewer)
 * guardAdmin: allows admin, superadmin only (blocks viewer + editor)
 *
 * @module web/lib/api-guard
 */

import { NextResponse } from 'next/server';
import { getSessionFromRequest, type Role } from './auth';

const ROLE_LEVEL: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, superadmin: 3 };

/**
 * Returns 403 if the user lacks editor role or above.
 * Allows: editor, admin, superadmin. Blocks: viewer.
 *
 * @param {Request} req - Incoming request.
 * @returns {NextResponse | null} 403 response or null if authorized.
 */
export function guardAdmin(req: Request): NextResponse | null {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  if ((ROLE_LEVEL[session.role] ?? -1) < ROLE_LEVEL.editor) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }
  return null;
}

/**
 * Returns 403 if the user lacks admin role or above.
 * Allows: admin, superadmin. Blocks: viewer, editor.
 * Use this for user management endpoints only.
 *
 * @param {Request} req - Incoming request.
 * @returns {NextResponse | null} 403 response or null if authorized.
 */
export function guardUserAdmin(req: Request): NextResponse | null {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  if ((ROLE_LEVEL[session.role] ?? -1) < ROLE_LEVEL.admin) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }
  return null;
}
