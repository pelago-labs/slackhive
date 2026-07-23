/**
 * @fileoverview /api/system/slack-config — manage the workspace-level Slack App
 * Configuration token that powers automated agent onboarding (app creation via
 * the manifest API). Admin-only; token material is never returned to clients.
 *
 * GET    → { configured, expiresAt? }
 * PUT    → { refreshToken } — stores + validates by rotating once (422 on reject)
 * DELETE → clears the stored token material
 *
 * @module web/api/system/slack-config
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardUserAdmin } from '@/lib/api-guard';
import {
  isConfigTokenConfigured, getConfigTokenExpiry,
  saveConfigRefreshToken, clearConfigToken, SlackConfigTokenError,
} from '@/lib/platforms/slack/config-token';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = guardUserAdmin(req);
  if (denied) return denied;
  try {
    const configured = await isConfigTokenConfigured();
    const expiresAt = configured ? await getConfigTokenExpiry() : null;
    return NextResponse.json({ configured, ...(expiresAt ? { expiresAt } : {}) });
  } catch (err) {
    return apiError('system/slack-config', err);
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const denied = guardUserAdmin(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as { refreshToken?: string };
    const refreshToken = body.refreshToken?.trim();
    if (!refreshToken) {
      return NextResponse.json({ error: 'refreshToken is required' }, { status: 400 });
    }
    if (!refreshToken.startsWith('xoxe-1-')) {
      return NextResponse.json({ error: 'That does not look like an App Configuration REFRESH token (expected xoxe-1-…). Copy the Refresh Token, not the Access Token.' }, { status: 400 });
    }
    await saveConfigRefreshToken(refreshToken);
    return NextResponse.json({ configured: true });
  } catch (err) {
    if (err instanceof SlackConfigTokenError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return apiError('system/slack-config', err);
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const denied = guardUserAdmin(req);
  if (denied) return denied;
  try {
    await clearConfigToken();
    return NextResponse.json({ configured: false });
  } catch (err) {
    return apiError('system/slack-config', err);
  }
}
