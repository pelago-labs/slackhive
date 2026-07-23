/**
 * @fileoverview GET /api/auth/slack/authorize
 * Initiates "Sign in with Slack" OAuth flow.
 * Generates a random state for CSRF protection, stores it, then redirects
 * to Slack's authorization endpoint.
 *
 * @module web/api/auth/slack/authorize
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { setSetting, getSetting } from '@/lib/db';
import { originFromRequest } from '@/lib/request-origin';


export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const clientId = await getSetting('slack_client_id');
  if (!clientId) {
    return NextResponse.json({ error: 'Slack OAuth is not configured' }, { status: 501 });
  }

  const state = randomUUID();
  await setSetting(`slack_oauth_state:${state}`, '1');

  const redirectUri = `${originFromRequest(req)}/api/auth/slack/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    response_type: 'code',
    state,
  });

  return NextResponse.redirect(`https://slack.com/openid/connect/authorize?${params}`);
}
