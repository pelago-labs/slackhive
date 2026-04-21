/**
 * @fileoverview Safe API error helper.
 *
 * Previously, 500 branches across API routes returned the raw exception
 * message to the client (`{ error: (err as Error).message }`). That leaks
 * DB error text, file paths, and sometimes secret fragments to anyone who
 * can trigger a failure. This helper logs the real error server-side and
 * returns only a generic public message.
 *
 * @module web/lib/api-error
 */

import { NextResponse } from 'next/server';

/**
 * Server-logs the real error and returns a generic 500 response. Use this in
 * catch blocks that previously returned `error.message` to the client.
 *
 * @param context - Short tag for the log (route name + verb).
 * @param err - The caught error.
 * @param publicMessage - What the client sees. Defaults to a generic message.
 * @param status - HTTP status. Defaults to 500.
 */
export function apiError(
  context: string,
  err: unknown,
  publicMessage = 'Internal server error',
  status = 500,
): NextResponse {
  console.error(`[api:${context}]`, err);
  return NextResponse.json({ error: publicMessage }, { status });
}
