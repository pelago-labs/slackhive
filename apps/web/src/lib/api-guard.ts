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
import { userCanWriteAgent, userCanDeleteAgent } from './db';

/**
 * Returns 401 if the user is not logged in, null otherwise.
 * No role restriction — any authenticated user passes.
 */
export function guardAuth(req: Request): NextResponse | null {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  return null;
}

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
 * Returns 403 if the user cannot write to the specified agent.
 * Admins/superadmins always pass. Editors pass only if they created the agent
 * or have been explicitly granted write access.
 *
 * @param {Request} req - Incoming request.
 * @param {string} agentId - Agent UUID to check write access for.
 * @returns {Promise<NextResponse | null>} 403 response or null if authorized.
 */
export async function guardAgentWrite(req: Request, agentId: string): Promise<NextResponse | null> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const allowed = await userCanWriteAgent(agentId, session.username, session.role);
  if (!allowed) return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  return null;
}

/**
 * Returns 403 if the user cannot delete the specified agent.
 * Allows admins/superadmins and the agent's creator. Editor-grant collaborators
 * are blocked here even though they can edit — delete is irreversible.
 */
export async function guardAgentDelete(req: Request, agentId: string): Promise<NextResponse | null> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const allowed = await userCanDeleteAgent(agentId, session.username, session.role);
  if (!allowed) return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
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

/**
 * Returns 403 unless the caller is a superadmin. For the most sensitive operations
 * (disaster-recovery: DB backup download, recovery-key export — these expose the
 * encrypted database and the wrapped master key).
 *
 * @param {Request} req - Incoming request.
 * @returns {NextResponse | null} 401/403 response or null if authorized.
 */
export function guardSuperadmin(req: Request): NextResponse | null {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  if (session.role !== 'superadmin') {
    return NextResponse.json({ error: 'Superadmin only' }, { status: 403 });
  }
  return null;
}
