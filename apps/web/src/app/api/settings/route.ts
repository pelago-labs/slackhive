/**
 * @fileoverview API route for platform settings (key-value store).
 *
 * GET  /api/settings — returns all settings as a JSON object.
 * PUT  /api/settings — upserts a single setting `{ key, value }`.
 *
 * @module web/api/settings
 */

import { NextResponse } from 'next/server';
import { getAllSettings, setSetting } from '@/lib/db';

/**
 * Returns every stored setting as a flat `{ key: value }` JSON object.
 *
 * @returns {Promise<NextResponse>} JSON response with all settings.
 */
export async function GET(): Promise<NextResponse> {
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
  const body = await req.json();
  const { key, value } = body as { key: string; value: string };

  if (!key || typeof key !== 'string' || typeof value !== 'string') {
    return NextResponse.json({ error: 'key and value are required strings' }, { status: 400 });
  }

  await setSetting(key, value);
  return NextResponse.json({ ok: true, key, value });
}
