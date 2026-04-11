/**
 * @fileoverview POST /api/oauth/start
 * Initiates OAuth flow for an MCP server.
 *
 * 1. Discovers OAuth metadata from the MCP server URL
 * 2. Dynamically registers a client (if supported)
 * 3. Returns the authorization URL for the frontend to redirect to
 *
 * Body: { mcpUrl: string, templateId: string }
 * Returns: { authUrl: string, state: string } or { error: string }
 *
 * @module web/api/oauth/start
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { setSetting } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { mcpUrl, templateId } = await req.json();
  if (!mcpUrl || !templateId) {
    return NextResponse.json({ error: 'mcpUrl and templateId required' }, { status: 400 });
  }

  try {
    // Step 1: Discover OAuth resource metadata
    const resourceUrl = new URL(mcpUrl);
    const resourceMeta = await fetch(
      `${resourceUrl.origin}/.well-known/oauth-protected-resource`
    ).then(r => r.ok ? r.json() : null);

    if (!resourceMeta?.authorization_servers?.[0]) {
      return NextResponse.json({ error: 'not_supported', message: 'This server does not support OAuth discovery. Use token paste instead.' });
    }

    const authServerUrl = resourceMeta.authorization_servers[0];

    // Step 2: Get authorization server metadata
    const authMeta = await fetch(
      `${authServerUrl}/.well-known/oauth-authorization-server`
    ).then(r => r.ok ? r.json() : null);

    if (!authMeta?.authorization_endpoint || !authMeta?.token_endpoint) {
      return NextResponse.json({ error: 'not_supported', message: 'OAuth metadata incomplete. Use token paste instead.' });
    }

    // Step 3: Dynamic client registration
    const redirectUri = `${req.nextUrl.origin}/api/oauth/callback`;
    let clientId: string;
    let clientSecret: string | undefined;

    if (authMeta.registration_endpoint) {
      const regRes = await fetch(authMeta.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'SlackHive',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      });

      if (!regRes.ok) {
        return NextResponse.json({ error: 'not_supported', message: 'Dynamic client registration failed. Use token paste instead.' });
      }

      const regData = await regRes.json();
      clientId = regData.client_id;
      clientSecret = regData.client_secret;
    } else {
      return NextResponse.json({ error: 'not_supported', message: 'No registration endpoint. Use token paste instead.' });
    }

    // Step 4: Build authorization URL
    const state = randomUUID();
    const authParams = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    });

    // Store state for callback verification
    await setSetting(`oauth_state:${state}`, JSON.stringify({
      templateId,
      tokenEndpoint: authMeta.token_endpoint,
      clientId,
      clientSecret,
      redirectUri,
    }));

    const authUrl = `${authMeta.authorization_endpoint}?${authParams.toString()}`;
    return NextResponse.json({ authUrl, state });

  } catch (err) {
    return NextResponse.json({
      error: 'failed',
      message: `OAuth discovery failed: ${(err as Error).message}`,
    }, { status: 500 });
  }
}
