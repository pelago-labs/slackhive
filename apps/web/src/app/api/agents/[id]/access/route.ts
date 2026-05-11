import { NextRequest, NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { getAgentWriteUsers, grantAgentAccess, revokeAgentWrite, getAllUsers, userCanWriteAgent, userCanReadAgent, publishAgentEvent } from '@/lib/db';
import type { AgentAccessLevel } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

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

  const [canRead, canWrite] = await Promise.all([
    userCanReadAgent(id, session.username, session.role),
    userCanWriteAgent(id, session.username, session.role),
  ]);
  return NextResponse.json({ canRead, canWrite });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const { id } = await params;
  const { userId, accessLevel, canWrite } = await req.json().catch(() => ({}));
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  // Support both new accessLevel param and legacy canWrite boolean
  const level: AgentAccessLevel = accessLevel ?? (canWrite ? 'edit' : 'view');
  await grantAgentAccess(id, userId, level);
  // Invalidate the runner's per-(agent, sender) userCanTrigger cache. Targeted
  // to this agent — other agents' cache entries are unaffected.
  await publishAgentEvent({ type: 'user-access-changed', agentId: id, userId }).catch(() => {});
  return new NextResponse(null, { status: 204 });
}

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
  await publishAgentEvent({ type: 'user-access-changed', agentId: id, userId }).catch(() => {});
  return new NextResponse(null, { status: 204 });
}
