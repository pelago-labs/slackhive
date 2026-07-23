/**
 * @fileoverview GET /api/slack/install/callback — OAuth redirect target for the
 * automated Slack app install. Resolves the single-use state FIRST (it carries
 * the agent id and is the auth for this unauthenticated redirect — same model
 * as the SSO callback) so every outcome, including a denied install, redirects
 * back to the right agent's Slack setup UI where the stepper surfaces it.
 *
 * @module web/api/slack/install/callback
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById } from '@/lib/db';
import { handleInstallCallback, consumeInstallState } from '@/lib/platforms/slack/provision';
import { originFromRequest } from '@/lib/request-origin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = originFromRequest(req);
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const oauthError = req.nextUrl.searchParams.get('error');

  const back = (path: string) => NextResponse.redirect(`${origin}${path}`);

  // Resolve the state up front — Slack echoes it back on BOTH success and
  // denial, so even failures can land on the owning agent's page.
  const resolved = state ? await consumeInstallState(state) : null;
  const agent = resolved ? await getAgentById(resolved.agentId) : null;
  const agentPage = agent ? `/agents/${agent.slug}?setup=slack` : null;

  if (oauthError) {
    // Admin clicked Cancel (access_denied) or Slack reported an install error.
    return back(agentPage
      ? `${agentPage}&install_error=${encodeURIComponent(oauthError)}`
      : `/?install_error=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state) return back('/?install_error=missing_params');
  if (!agentPage) return back('/?install_error=state');

  try {
    await handleInstallCallback(code, resolved!.agentId, origin);
    return back(`${agentPage}&installed=1`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    // 'not_provisioned' | 'exchange' — surfaced by the stepper's error banner.
    return back(`${agentPage}&install_error=${encodeURIComponent(reason)}`);
  }
}
