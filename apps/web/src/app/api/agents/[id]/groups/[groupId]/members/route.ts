import { NextRequest, NextResponse } from 'next/server';
import { guardAgentWrite } from '@/lib/api-guard';
import { getAgentGroup, listGroupMembers, setGroupMembers } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** 404 if the group either doesn't exist or belongs to a different agent. */
async function assertGroupOwnedBy(agentId: string, groupId: string): Promise<NextResponse | null> {
  const group = await getAgentGroup(groupId);
  if (!group || group.agentId !== agentId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; groupId: string }> }
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id, groupId } = await params;
  const guard = await assertGroupOwnedBy(id, groupId);
  if (guard) return guard;
  const members = await listGroupMembers(groupId);
  return NextResponse.json({ members });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; groupId: string }> }
): Promise<NextResponse> {
  const { id, groupId } = await params;
  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;
  const guard = await assertGroupOwnedBy(id, groupId);
  if (guard) return guard;
  const body = await req.json().catch(() => ({}));
  const userIds = Array.isArray(body.userIds) ? body.userIds.filter((u: unknown) => typeof u === 'string') : null;
  if (userIds === null) return NextResponse.json({ error: 'userIds (string[]) required' }, { status: 400 });
  await setGroupMembers(groupId, userIds);
  const members = await listGroupMembers(groupId);
  return NextResponse.json({ members });
}
