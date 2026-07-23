/**
 * @fileoverview GET /api/slack/install/callback — OAuth redirect target for the
 * automated Slack app install. Validates the single-use state (which carries the
 * agent id and is the auth for this unauthenticated redirect — same model as the
 * SSO callback), exchanges the code for the bot token, and merges it into the
 * agent's credentials. Redirects back to the agent's Slack setup UI.
 *
 * @module web/api/slack/install/callback
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById } from '@/lib/db';
import { handleInstallCallback } from '@/lib/platforms/slack/provision';
import { originFromRequest } from '@/lib/request-origin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = originFromRequest(req);
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const oauthError = req.nextUrl.searchParams.get('error');

  const back = (path: string) => NextResponse.redirect(`${origin}${path}`);

  if (oauthError) {
    // Admin clicked Cancel (access_denied) or Slack reported an install error.
    return back(`/agents?install_error=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state) return back('/agents?install_error=missing_params');

  try {
    const { agentId } = await handleInstallCallback(code, state, origin);
    const agent = await getAgentById(agentId);
    const slug = agent?.slug ?? '';
    return back(`/agents/${slug}?setup=slack&installed=1`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    // 'state' | 'not_provisioned' | 'exchange' — surfaced by the stepper UI.
    return back(`/agents?install_error=${encodeURIComponent(reason)}`);
  }
}
