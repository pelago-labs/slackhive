/**
 * @fileoverview GET /api/auth/slack/callback
 * Handles the OAuth callback from Slack after user approval.
 *
 * Flow:
 * 1. Validate state (CSRF)
 * 2. Exchange code for access token
 * 3. Fetch user identity (sub, email, name)
 * 4. Upsert user in DB (new users get role=viewer)
 * 5. Issue HMAC-signed session cookie
 * 6. Redirect to /
 *
 * @module web/api/auth/slack/callback
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSetting, upsertSlackUser, getUserBySlackId, fixSlackUsername } from '@/lib/db';

import { signSession, COOKIE_NAME } from '@/lib/auth';
import type { Role } from '@/lib/auth';
import { originFromRequest } from '@/lib/request-origin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const origin = originFromRequest(req);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=slack_denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${origin}/login?error=slack_invalid`);
  }

  // Validate CSRF state
  const storedState = await getSetting(`slack_oauth_state:${state}`);
  if (!storedState) {
    return NextResponse.redirect(`${origin}/login?error=slack_invalid`);
  }

  const clientId = await getSetting('slack_client_id');
  const clientSecret = await getSetting('slack_client_secret');
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${origin}/login?error=slack_not_configured`);
  }

  // Exchange code for token
  const redirectUri = `${origin}/api/auth/slack/callback`;
  const tokenRes = await fetch('https://slack.com/api/openid.connect.token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });

  const tokenData = await tokenRes.json() as { ok: boolean; access_token?: string; error?: string };
  if (!tokenData.ok || !tokenData.access_token) {
    return NextResponse.redirect(`${origin}/login?error=slack_token`);
  }

  // Fetch user identity
  const userRes = await fetch('https://slack.com/api/openid.connect.userInfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  const userInfo = await userRes.json() as { ok: boolean; sub?: string; email?: string; name?: string; error?: string };
  if (!userInfo.ok || !userInfo.sub || !userInfo.email) {
    return NextResponse.redirect(`${origin}/login?error=slack_userinfo`);
  }

  // If slack_login_open is not explicitly 'true', only pre-imported users may sign in
  const loginOpen = await getSetting('slack_login_open');
  let user = await getUserBySlackId(userInfo.sub);
  if (!user) {
    if (loginOpen !== 'true') {
      return NextResponse.redirect(`${origin}/login?error=slack_not_invited`);
    }
    user = await upsertSlackUser(userInfo.sub, userInfo.email, userInfo.name ?? userInfo.email);
  } else if (userInfo.name && user.username === userInfo.email) {
    user = await fixSlackUsername(user.id, userInfo.name) ?? user;
  }
  const session = signSession({ username: user.username, role: user.role as Role });

  const response = NextResponse.redirect(`${origin}/`);
  response.cookies.set(COOKIE_NAME, session, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  });

  return response;
}
