/**
 * @fileoverview Platform-agnostic connection info endpoint.
 *
 * GET /api/agents/[id]/platform-info
 * Returns live bot display name and handle from the agent's configured platform.
 * Supports Slack (via auth.test + users.info) and Telegram (via getMe).
 *
 * @module web/api/agents/[id]/platform-info
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getAgentById } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const agent = await getAgentById(id);
    if (!agent?.platformCredentials?.botToken) {
      return NextResponse.json({ error: 'No bot token configured' }, { status: 400 });
    }

    const { botToken } = agent.platformCredentials;
    const platform = agent.platform ?? 'slack';

    if (platform === 'telegram') {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const data = await res.json();
      if (!data.ok) {
        return NextResponse.json({ error: data.description ?? 'Telegram getMe failed' }, { status: 400 });
      }
      return NextResponse.json({
        platform: 'telegram',
        displayName: [data.result.first_name, data.result.last_name].filter(Boolean).join(' '),
        handle: data.result.username ?? null,
        teamName: null,
      });
    }

    // Default: Slack
    const authRes = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const auth = await authRes.json();
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 400 });

    const userRes = await fetch(`https://slack.com/api/users.info?user=${auth.user_id}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const userData = await userRes.json();
    const profile = userData?.user?.profile;

    return NextResponse.json({
      platform: 'slack',
      displayName: profile?.display_name || profile?.real_name || auth.user,
      handle: auth.user,
      teamName: auth.team,
    });
  } catch (err) {
    return apiError('agents/[id]/platform-info', err);
  }
}
