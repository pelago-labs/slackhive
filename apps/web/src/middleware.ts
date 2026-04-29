/**
 * @fileoverview Next.js middleware — protects all routes with auth.
 *
 * Redirects unauthenticated users to /login.
 * Skips: /login, /api/auth/*, static assets.
 *
 * Uses crypto.subtle (Edge Runtime compatible) for HMAC verification.
 *
 * @module web/middleware
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAuthSecret } from './lib/secrets';

const COOKIE_NAME = 'auth_session';

/** Decode a base64url string to bytes without leaking on invalid input. */
function base64urlToBytes(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Verifies an HMAC signature using `crypto.subtle.verify`, which is
 * constant-time by contract — avoids the timing oracle of string comparison.
 *
 * @param {string} data - The base64url-encoded payload.
 * @param {string} sig - The base64url-encoded signature.
 * @returns {Promise<boolean>} True if valid.
 */
async function verifyHmac(data: string, sig: string): Promise<boolean> {
  const sigBytes = base64urlToBytes(sig);
  if (!sigBytes) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(getAuthSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  return crypto.subtle.verify('HMAC', key, sigBytes as BufferSource, enc.encode(data));
}

/**
 * Middleware function — checks auth cookie on every non-public route.
 *
 * @param {NextRequest} req - Incoming request.
 * @returns {Promise<NextResponse>} Response or redirect.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const cookie = req.cookies.get(COOKIE_NAME)?.value;

  if (!cookie) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const parts = cookie.split('.');
  if (parts.length !== 2) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const valid = await verifyHmac(parts[0], parts[1]);
  if (!valid) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!login|api/auth|api/webhooks|_next/static|_next/image|favicon\\.ico|logo\\.svg).*)'],
};
