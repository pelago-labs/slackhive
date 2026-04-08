/**
 * @fileoverview Unit tests for auth.ts — signSession, verifySession,
 * getSessionFromRequest, requireRole, and authenticateUser.
 *
 * No database connection required for session/cookie tests.
 * authenticateUser DB path is tested via vi.mock.
 *
 * @module web/lib/__tests__/auth.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

// Mock DB dependency before importing auth
vi.mock('@/lib/db', () => ({
  getUserByUsername: vi.fn(),
}));

import {
  signSession,
  verifySession,
  getSessionFromRequest,
  requireRole,
  authenticateUser,
  COOKIE_NAME,
} from '@/lib/auth';
import { getUserByUsername } from '@/lib/db';
import type { SessionPayload } from '@/lib/auth';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(cookie?: string): Request {
  return new Request('http://localhost/api/test', {
    headers: cookie ? { cookie } : {},
  });
}

function makeSignedCookie(payload: SessionPayload, secret = 'change-this-secret-in-production'): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// ─── signSession / verifySession ──────────────────────────────────────────────

describe('signSession + verifySession', () => {
  it('round-trips a valid session payload', () => {
    const payload: SessionPayload = { username: 'alice', role: 'editor' };
    const cookie = signSession(payload);
    const result = verifySession(cookie);
    expect(result).toEqual(payload);
  });

  it('round-trips all role types', () => {
    const roles: SessionPayload['role'][] = ['superadmin', 'admin', 'editor', 'viewer'];
    for (const role of roles) {
      const payload: SessionPayload = { username: 'user', role };
      expect(verifySession(signSession(payload))).toEqual(payload);
    }
  });

  it('returns null for a tampered signature', () => {
    const payload: SessionPayload = { username: 'alice', role: 'admin' };
    const cookie = signSession(payload);
    const [data] = cookie.split('.');
    const tampered = `${data}.invalidsignature`;
    expect(verifySession(tampered)).toBeNull();
  });

  it('returns null for a tampered payload (data changed, sig unchanged)', () => {
    const payload: SessionPayload = { username: 'alice', role: 'editor' };
    const cookie = signSession(payload);
    const [, sig] = cookie.split('.');
    const evilPayload = Buffer.from(JSON.stringify({ username: 'alice', role: 'superadmin' })).toString('base64url');
    const tampered = `${evilPayload}.${sig}`;
    expect(verifySession(tampered)).toBeNull();
  });

  it('returns null when cookie has no dot separator', () => {
    expect(verifySession('nodothere')).toBeNull();
  });

  it('returns null when cookie has more than one dot', () => {
    expect(verifySession('part1.part2.part3')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(verifySession('')).toBeNull();
  });

  it('returns null when payload is valid base64 but not JSON', () => {
    const notJson = Buffer.from('not-json').toString('base64url');
    const sig = crypto
      .createHmac('sha256', 'change-this-secret-in-production')
      .update(notJson)
      .digest('base64url');
    expect(verifySession(`${notJson}.${sig}`)).toBeNull();
  });

  it('returns null when signed with a different secret', () => {
    const cookie = makeSignedCookie({ username: 'alice', role: 'admin' }, 'other-secret');
    expect(verifySession(cookie)).toBeNull();
  });

  it('produces different cookies for different payloads', () => {
    const a = signSession({ username: 'alice', role: 'admin' });
    const b = signSession({ username: 'alice', role: 'editor' });
    expect(a).not.toBe(b);
  });
});

// ─── getSessionFromRequest ────────────────────────────────────────────────────

describe('getSessionFromRequest', () => {
  it('extracts and verifies a valid session from the cookie header', () => {
    const payload: SessionPayload = { username: 'bob', role: 'viewer' };
    const value = signSession(payload);
    const req = makeRequest(`${COOKIE_NAME}=${value}`);
    expect(getSessionFromRequest(req)).toEqual(payload);
  });

  it('returns null when no cookie header is present', () => {
    const req = makeRequest();
    expect(getSessionFromRequest(req)).toBeNull();
  });

  it('returns null when cookie header has no auth_session key', () => {
    const req = makeRequest('other_cookie=abc123');
    expect(getSessionFromRequest(req)).toBeNull();
  });

  it('returns null when the session cookie is tampered', () => {
    const req = makeRequest(`${COOKIE_NAME}=invalid.garbage`);
    expect(getSessionFromRequest(req)).toBeNull();
  });

  it('extracts session when auth_session is among multiple cookies', () => {
    const payload: SessionPayload = { username: 'charlie', role: 'admin' };
    const value = signSession(payload);
    const req = makeRequest(`other=val; ${COOKIE_NAME}=${value}; another=foo`);
    expect(getSessionFromRequest(req)).toEqual(payload);
  });

  it('handles URL-encoded cookie values', () => {
    const payload: SessionPayload = { username: 'dave', role: 'editor' };
    const value = encodeURIComponent(signSession(payload));
    const req = makeRequest(`${COOKIE_NAME}=${value}`);
    expect(getSessionFromRequest(req)).toEqual(payload);
  });
});

// ─── requireRole ─────────────────────────────────────────────────────────────

describe('requireRole', () => {
  it('returns session when role meets minimum (viewer requires viewer)', () => {
    const payload: SessionPayload = { username: 'alice', role: 'viewer' };
    const req = makeRequest(`${COOKIE_NAME}=${signSession(payload)}`);
    expect(requireRole(req, 'viewer')).toEqual(payload);
  });

  it('returns session when role exceeds minimum (admin requires editor)', () => {
    const payload: SessionPayload = { username: 'alice', role: 'admin' };
    const req = makeRequest(`${COOKIE_NAME}=${signSession(payload)}`);
    expect(requireRole(req, 'editor')).toEqual(payload);
  });

  it('superadmin passes any role requirement', () => {
    const payload: SessionPayload = { username: 'root', role: 'superadmin' };
    const req = makeRequest(`${COOKIE_NAME}=${signSession(payload)}`);
    expect(requireRole(req, 'admin')).toEqual(payload);
  });

  it('throws when role is below minimum (viewer requires editor)', () => {
    const payload: SessionPayload = { username: 'alice', role: 'viewer' };
    const req = makeRequest(`${COOKIE_NAME}=${signSession(payload)}`);
    expect(() => requireRole(req, 'editor')).toThrow('Insufficient permissions');
  });

  it('throws when not authenticated (no cookie)', () => {
    const req = makeRequest();
    expect(() => requireRole(req, 'viewer')).toThrow('Not authenticated');
  });

  it('editor cannot meet admin requirement', () => {
    const payload: SessionPayload = { username: 'alice', role: 'editor' };
    const req = makeRequest(`${COOKIE_NAME}=${signSession(payload)}`);
    expect(() => requireRole(req, 'admin')).toThrow('Insufficient permissions');
  });
});

// ─── authenticateUser ─────────────────────────────────────────────────────────

describe('authenticateUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns superadmin session for env-var credentials', async () => {
    const result = await authenticateUser('admin', 'changeme');
    expect(result).toEqual({ username: 'admin', role: 'superadmin' });
  });

  it('returns null for wrong superadmin password', async () => {
    const result = await authenticateUser('admin', 'wrongpass');
    expect(result).toBeNull();
  });

  it('returns null when DB user does not exist', async () => {
    vi.mocked(getUserByUsername).mockResolvedValue(null);
    const result = await authenticateUser('unknown', 'pass');
    expect(result).toBeNull();
  });

  it('returns null when DB user password does not match', async () => {
    vi.mocked(getUserByUsername).mockResolvedValue({
      id: 'u1', username: 'bob', role: 'editor',
      passwordHash: '$2b$10$invalidhashthatisnevervalid123456789012',
      createdAt: new Date().toISOString(),
    });
    const result = await authenticateUser('bob', 'wrongpass');
    expect(result).toBeNull();
  });

  it('does not hit DB for superadmin credentials', async () => {
    await authenticateUser('admin', 'changeme');
    expect(getUserByUsername).not.toHaveBeenCalled();
  });
});

// ─── hashPassword ─────────────────────────────────────────────────────────────

describe('hashPassword', () => {
  it('returns a bcrypt hash string', async () => {
    const { hashPassword } = await import('@/lib/auth');
    const hash = await hashPassword('mysecret');
    expect(hash).toMatch(/^\$2[ab]\$10\$/);
  });

  it('produces a different hash each call (salt)', async () => {
    const { hashPassword } = await import('@/lib/auth');
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });

  it('produces a hash that bcrypt can verify', async () => {
    const { hashPassword } = await import('@/lib/auth');
    const bcrypt = (await import('bcryptjs')).default;
    const hash = await hashPassword('testpass');
    expect(await bcrypt.compare('testpass', hash)).toBe(true);
  });
});

// ─── Production secret guard ────────────────────────────────────────────────

describe('production secret guard', () => {
  it('does not throw in test/dev environment', () => {
    // The module already loaded successfully via the top-level import.
    // If the guard fired incorrectly, this entire test file would have
    // failed to import. Verify the module exported the expected function.
    expect(signSession).toBeDefined();
    expect(typeof signSession).toBe('function');
  });
});
