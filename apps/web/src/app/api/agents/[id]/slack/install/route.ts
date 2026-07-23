/**
 * @fileoverview GET /api/agents/[id]/slack/install — starts the OAuth install of
 * the agent's auto-provisioned Slack app (admin-only). Stashes a single-use CSRF
 * state and redirects the admin to Slack's authorize (Allow) screen; the callback
 * at /api/slack/install/callback captures the bot token.
 *
 * @module web/api/agents/[id]/slack/install
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardUserAdmin } from '@/lib/api-guard';
import { slackProvisioner } from '@/lib/platforms/slack/provision';
import { originFromRequest } from '@/lib/request-origin';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardUserAdmin(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const url = await slackProvisioner.buildInstallRedirect(id, originFromRequest(req));
    if (!url) {
      return NextResponse.json({ error: 'Automated install unavailable: either no Slack app is provisioned for this agent, or it was provisioned without an OAuth redirect URL (http origin) — use the install link on the agent page and paste the bot token instead.' }, { status: 409 });
    }
    return NextResponse.redirect(url);
  } catch (err) {
    return apiError('agents/[id]/slack/install', err);
  }
}
