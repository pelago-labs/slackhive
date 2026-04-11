/**
 * @fileoverview GET /api/oauth/callback
 * OAuth callback handler for MCP server authentication.
 * Exchanges auth code for access token using the stored OAuth state.
 *
 * Flow:
 * 1. User clicks "Connect" on an OAuth MCP in the library
 * 2. Frontend starts OAuth: registers client, stores state, redirects to provider
 * 3. Provider redirects back here with ?code=...&state=...
 * 4. This route exchanges code for token, stores it, redirects to MCP catalog
 *
 * @module web/api/oauth/callback
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');

  if (!code || !state) {
    return new NextResponse('Missing code or state parameter', { status: 400 });
  }

  // Load OAuth state (stored by the frontend before redirect)
  const stateData = await getSetting(`oauth_state:${state}`);
  if (!stateData) {
    return new NextResponse('Invalid or expired OAuth state. Try again.', { status: 400 });
  }

  let oauthState: {
    templateId: string;
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    codeVerifier?: string;
  };
  try {
    oauthState = JSON.parse(stateData);
  } catch {
    return new NextResponse('Corrupt OAuth state', { status: 500 });
  }

  // Exchange code for token
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: oauthState.redirectUri,
      client_id: oauthState.clientId,
      ...(oauthState.clientSecret && { client_secret: oauthState.clientSecret }),
      ...(oauthState.codeVerifier && { code_verifier: oauthState.codeVerifier }),
    });

    const tokenRes = await fetch(oauthState.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('Token exchange failed:', err);
      return new NextResponse(`Token exchange failed: ${err}`, { status: 502 });
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return new NextResponse('No access token in response', { status: 502 });
    }

    // Store the token for the template install to pick up
    await setSetting(`oauth_token:${state}`, JSON.stringify({
      accessToken,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
      templateId: oauthState.templateId,
    }));

    // Clean up state
    await setSetting(`oauth_state:${state}`, JSON.stringify({ used: true }));

    // Redirect back to MCP catalog with success indicator
    return NextResponse.redirect(new URL(`/settings/mcps?oauth=success&state=${state}`, req.url));
  } catch (err) {
    console.error('OAuth callback error:', err);
    return new NextResponse(`OAuth error: ${(err as Error).message}`, { status: 500 });
  }
}
