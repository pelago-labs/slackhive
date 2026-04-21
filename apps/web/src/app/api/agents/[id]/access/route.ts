/**
 * @fileoverview Agent write-access management API.
 *
 * GET    /api/agents/[id]/access — List users with explicit write access
 * POST   /api/agents/[id]/access — Grant write access to a user
 * DELETE /api/agents/[id]/access — Revoke write access from a user
 *
 * @module web/api/agents/[id]/access
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { getAgentWriteUsers, grantAgentWrite, revokeAgentWrite, getAllUsers, userCanWriteAgent } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/[id]/access
 * - For admins: returns write-grant list + all users for the assignment UI.
 * - For editors/viewers: returns { canWrite: bool } for the current session user.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (session.role === 'admin' || session.role === 'superadmin') {
    const [writeUsers, allUsers] = await Promise.all([
      getAgentWriteUsers(id),
      getAllUsers(),
    ]);
    return NextResponse.json({ writeUsers, allUsers: allUsers.map(u => ({ id: u.id, username: u.username, role: u.role })) });
  }

  // For editors/viewers — just return their own write permission
  const canWrite = await userCanWriteAgent(id, session.username, session.role);
  return NextResponse.json({ canWrite });
}

/**
 * POST /api/agents/[id]/access
 * Grants write access to a user (admin only).
 * Body: { userId: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const { id } = await params;
  const { userId } = await req.json().catch(() => ({}));
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });
  await grantAgentWrite(id, userId);
  return new NextResponse(null, { status: 204 });
}

/**
 * DELETE /api/agents/[id]/access
 * Revokes write access from a user (admin only).
 * Body: { userId: string }
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const { id } = await params;
  const { userId } = await req.json().catch(() => ({}));
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });
  await revokeAgentWrite(id, userId);
  return new NextResponse(null, { status: 204 });
}
