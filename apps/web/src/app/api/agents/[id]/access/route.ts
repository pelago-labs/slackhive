import { NextRequest, NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { getAgentWriteUsers, grantAgentAccess, revokeAgentWrite, getAllUsers, userCanWriteAgent, userCanReadAgent, publishAgentEvent, getUserSlackIdById } from '@/lib/db';
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
  // Targeted flush: include both agentId and the user's slack_user_id so the
  // runner drops just that single (agent, sender) cache entry. Falls back to
  // an agentId-scoped flush if the user has no Slack mapping.
  const slackUserId = await getUserSlackIdById(userId).catch(() => null);
  await publishAgentEvent({ type: 'user-access-changed', agentId: id, userId, slackUserId: slackUserId ?? undefined }).catch(() => {});
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
  const slackUserId = await getUserSlackIdById(userId).catch(() => null);
  await revokeAgentWrite(id, userId);
  await publishAgentEvent({ type: 'user-access-changed', agentId: id, userId, slackUserId: slackUserId ?? undefined }).catch(() => {});
  return new NextResponse(null, { status: 204 });
}
