import { NextRequest, NextResponse } from 'next/server';
import { getAgentById } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/[id]/slack-info
 * Fetches live bot display name and @handle from Slack using the agent's bot token.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const agent = await getAgentById(id);
    if (!agent?.slackBotToken) return NextResponse.json({ error: 'No bot token' }, { status: 400 });

    const authRes = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${agent.slackBotToken}` },
    });
    const auth = await authRes.json();
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 400 });

    const userRes = await fetch(`https://slack.com/api/users.info?user=${auth.user_id}`, {
      headers: { Authorization: `Bearer ${agent.slackBotToken}` },
    });
    const userData = await userRes.json();
    const profile = userData?.user?.profile;

    return NextResponse.json({
      displayName: profile?.display_name || profile?.real_name || auth.user,
      handle:      auth.user,
      botId:       auth.bot_id,
      teamName:    auth.team,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
