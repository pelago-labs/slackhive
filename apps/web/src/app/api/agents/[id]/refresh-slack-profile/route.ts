/**
 * @fileoverview POST /api/agents/[id]/refresh-slack-profile — re-fetch the
 * agent's Slack bot handle + profile image and cache them in DB. Used by the
 * dashboard to lazily backfill avatars for agents that pre-date this feature,
 * and by the agent settings page as a manual "Refresh" button.
 *
 * Auth: any logged-in user (the data is already public to anyone in the
 * workspace via Slack itself).
 *
 * @module web/api/agents/[id]/refresh-slack-profile
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getAgentById, fetchSlackBotProfile } from '@/lib/db';
import { guardAuth } from '@/lib/api-guard';
import { getDb } from '@slackhive/shared';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const deny = guardAuth(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    if (!agent.slackBotToken) {
      return NextResponse.json({ ok: false, reason: 'no-slack-token' });
    }
    const profile = await fetchSlackBotProfile(agent.slackBotToken);
    if (!profile.imageUrl && !profile.handle) {
      return NextResponse.json({ ok: false, reason: 'slack-api-failed' });
    }
    await getDb().query(
      `UPDATE platform_integrations SET
         bot_handle    = COALESCE($1, bot_handle),
         bot_image_url = COALESCE($2, bot_image_url)
       WHERE agent_id = $3 AND platform = 'slack'`,
      [profile.handle, profile.imageUrl, id],
    );
    return NextResponse.json({
      ok: true,
      slackBotHandle: profile.handle ?? agent.slackBotHandle ?? null,
      slackBotImageUrl: profile.imageUrl ?? agent.slackBotImageUrl ?? null,
    });
  } catch (err) {
    return apiError('agents/[id]/refresh-slack-profile', err);
  }
}