/**
 * @fileoverview API route for platform settings (key-value store).
 *
 * GET  /api/settings — returns all settings as a JSON object.
 * PUT  /api/settings — upserts a single setting `{ key, value }`.
 *
 * @module web/api/settings
 */

import { NextRequest, NextResponse } from 'next/server';
import { AGENT_BACKEND_SETTING_KEY, CODEX_AUTH_MODE_SETTING_KEY, CLAUDE_AUTH_MODE_SETTING_KEY } from '@slackhive/shared';
import { getAllSettings, setSetting, getAllAgents, publishAgentEvent } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

/**
 * Settings keys that change how an agent's runtime is constructed (which backend,
 * which auth). Saving one must reload running agents so the change takes effect
 * without a manual restart. `codexModel` is intentionally NOT here — CodexBackend
 * reads it live each turn (see getModel), so it applies on the next message.
 * Auth secrets (`secret:…`) also trigger a reload so cached credentials refresh.
 */
const RELOAD_KEYS = new Set<string>([
  AGENT_BACKEND_SETTING_KEY,
  CODEX_AUTH_MODE_SETTING_KEY,
  CLAUDE_AUTH_MODE_SETTING_KEY,
]);

function keyRequiresReload(key: string): boolean {
  return RELOAD_KEYS.has(key) || key.startsWith('secret:');
}

/**
 * Returns every stored setting as a flat `{ key: value }` JSON object.
 *
 * @returns {Promise<NextResponse>} JSON response with all settings.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const settings = await getAllSettings();
  return NextResponse.json(settings);
}

/**
 * Upserts a single setting. Expects JSON body `{ key: string, value: string }`.
 *
 * @param {Request} req - Incoming request with JSON body.
 * @returns {Promise<NextResponse>} JSON response confirming the upsert.
 */
export async function PUT(req: Request): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const body = await req.json();
  const { key, value } = body as { key: string; value: string };

  if (!key || typeof key !== 'string' || typeof value !== 'string') {
    return NextResponse.json({ error: 'key and value are required strings' }, { status: 400 });
  }

  await setSetting(key, value);

  // Backend/auth changes only take effect when running agents are rebuilt —
  // setSetting alone doesn't reach the runner. Reload every agent (reuses the
  // per-agent reload event the runner already handles).
  let reloaded = 0;
  if (keyRequiresReload(key)) {
    const agents = await getAllAgents();
    await Promise.all(
      agents.map((a) => publishAgentEvent({ type: 'reload', agentId: a.id })),
    );
    reloaded = agents.length;
  }

  return NextResponse.json({ ok: true, key, value, reloaded });
}
