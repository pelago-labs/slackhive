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

const AUTH_SECRET = process.env.AUTH_SECRET || 'change-this-secret-in-production';
const COOKIE_NAME = 'auth_session';

/**
 * Verifies HMAC signature using Edge-compatible crypto.subtle.
 *
 * @param {string} data - The base64url-encoded payload.
 * @param {string} sig - The base64url-encoded signature.
 * @returns {Promise<boolean>} True if valid.
 */
async function verifyHmac(data: string, sig: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return sig === expected;
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
  matcher: ['/((?!login|api/auth|_next/static|_next/image|favicon\\.ico|logo\\.svg).*)'],
};
