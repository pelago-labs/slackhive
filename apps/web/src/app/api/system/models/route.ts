/**
 * @fileoverview GET /api/system/models?backend=codex|claude — list selectable
 * models for a backend.
 *
 * Uses the provider's REAL models API when an API key is available
 * (OpenAI `/v1/models`, Anthropic `/v1/models`); falls back to the curated list
 * for subscription auth, which has no models-listing endpoint.
 *
 * @module web/api/system/models
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  MODELS, CODEX_MODELS, AGENT_BACKEND_SETTING_KEY, DEFAULT_AGENT_BACKEND, decrypt,
  type ModelOption,
} from '@slackhive/shared';
import { getSetting } from '@/lib/db';
import { getEncryptionKey } from '@/lib/secrets';
import { guardAdmin } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

async function secret(key: string): Promise<string | undefined> {
  const enc = await getSetting(`secret:${key}`);
  if (!enc) return undefined;
  try { return decrypt(enc, getEncryptionKey()); } catch { return undefined; }
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<any | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { headers, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** OpenAI: keep coding/chat-capable models, newest-ish first. */
function filterOpenAiModels(ids: string[]): ModelOption[] {
  const keep = ids
    .filter((id) => /^gpt-5/.test(id) || /codex/.test(id) || /^o[0-9]/.test(id))
    .sort((a, b) => b.localeCompare(a));
  return keep.map((id) => ({ value: id, label: id, sub: '' }));
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const backend = req.nextUrl.searchParams.get('backend')
    ?? (await getSetting(AGENT_BACKEND_SETTING_KEY)) ?? DEFAULT_AGENT_BACKEND;

  if (backend === 'codex') {
    const key = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || (await secret('OPENAI_API_KEY'));
    if (key) {
      const data = await fetchJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` });
      const models = data?.data ? filterOpenAiModels(data.data.map((m: { id: string }) => m.id)) : [];
      if (models.length) return NextResponse.json({ backend, source: 'api', models });
    }
    // Subscription (no models API) or fetch failed → curated list.
    return NextResponse.json({ backend, source: 'curated', models: CODEX_MODELS });
  }

  // Claude
  const key = process.env.ANTHROPIC_API_KEY || (await secret('ANTHROPIC_API_KEY'));
  if (key) {
    const data = await fetchJson('https://api.anthropic.com/v1/models', {
      'x-api-key': key, 'anthropic-version': '2023-06-01',
    });
    const models: ModelOption[] = data?.data
      ? data.data.map((m: { id: string; display_name?: string }) => ({ value: m.id, label: m.display_name ?? m.id, sub: '' }))
      : [];
    if (models.length) return NextResponse.json({ backend, source: 'api', models });
  }
  return NextResponse.json({ backend, source: 'curated', models: MODELS });
}
