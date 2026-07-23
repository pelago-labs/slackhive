/**
 * @fileoverview Derives the externally visible origin (proto://host) of the web
 * app from a request, honoring reverse-proxy headers. Mirrors the logic used by
 * the Sign-in-with-Slack authorize route so all OAuth callbacks agree on origin.
 *
 * @module web/lib/request-origin
 */

import type { NextRequest } from 'next/server';

/**
 * Externally visible origin for building absolute callback URLs.
 * Chained proxies may send comma-separated forwarded headers
 * ("https, http") — only the first (client-facing) value counts.
 */
export function originFromRequest(req: NextRequest): string {
  const rawProto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '');
  const rawHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
  const proto = rawProto.split(',')[0].trim();
  const host = rawHost.split(',')[0].trim();
  return `${proto}://${host}`;
}
