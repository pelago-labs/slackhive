import { NextRequest, NextResponse } from 'next/server';
import { listAgentEligibleUsers } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Lists users who can at least trigger this agent (admins, the agent's
 * creator, or anyone with an `agent_access` grant). Used by the audience-
 * membership picker so audiences can only contain people who could actually
 * receive a response from the agent.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const users = await listAgentEligibleUsers(id);
  return NextResponse.json({ users });
}
