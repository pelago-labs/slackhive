/**
 * @fileoverview Authentication utilities — cookie signing, user verification, role checks.
 *
 * Superadmin is checked against env vars (ADMIN_USERNAME/ADMIN_PASSWORD).
 * DB users are checked with bcrypt. Sessions are HMAC-signed cookies.
 *
 * @module web/lib/auth
 */

import * as crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getUserByUsername } from './db';

/** Read env lazily so the build step can collect pages without AUTH_SECRET set. */
function getAuthSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s && process.env.NODE_ENV === 'production' && !process.env.CI) {
    throw new Error('AUTH_SECRET must be set in production. See .env.example.');
  }
  return s || 'change-this-secret-in-production';
}

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';

function getAdminPassword(): string {
  const p = process.env.ADMIN_PASSWORD;
  if (!p && process.env.NODE_ENV === 'production' && !process.env.CI) {
    throw new Error('ADMIN_PASSWORD must be set in production. See .env.example.');
  }
  return p || 'changeme';
}
const COOKIE_NAME = 'auth_session';

export type Role = 'superadmin' | 'admin' | 'editor' | 'viewer';

export interface SessionPayload {
  username: string;
  role: Role;
}

/**
 * Signs a session payload into an HMAC cookie value.
 *
 * @param {SessionPayload} payload - The session data to sign.
 * @returns {string} Signed cookie value (base64payload.base64sig).
 */
export function signSession(payload: SessionPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getAuthSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verifies an HMAC-signed session cookie and returns the payload.
 *
 * @param {string} cookie - The signed cookie value.
 * @returns {SessionPayload | null} Decoded payload or null if invalid.
 */
export function verifySession(cookie: string): SessionPayload | null {
  const parts = cookie.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', getAuthSecret()).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString()) as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * Authenticates a user by username and password.
 * Checks superadmin env vars first, then DB users.
 *
 * @param {string} username - The username to authenticate.
 * @param {string} password - The plaintext password.
 * @returns {Promise<SessionPayload | null>} Session payload or null if auth fails.
 */
export async function authenticateUser(username: string, password: string): Promise<SessionPayload | null> {
  // Check superadmin
  if (username === ADMIN_USERNAME && password === getAdminPassword()) {
    return { username, role: 'superadmin' };
  }

  // Check DB users
  const user = await getUserByUsername(username);
  if (!user) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  return { username: user.username, role: user.role as Role };
}

/**
 * Hashes a plaintext password with bcrypt.
 *
 * @param {string} password - Plaintext password.
 * @returns {Promise<string>} Bcrypt hash.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

/**
 * Extracts session from a Request's cookies.
 *
 * @param {Request} req - Incoming request.
 * @returns {SessionPayload | null} Session payload or null.
 */
export function getSessionFromRequest(req: Request): SessionPayload | null {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  return verifySession(decodeURIComponent(match[1]));
}

/**
 * Requires at least the given role. Returns the session or throws.
 *
 * @param {Request} req - Incoming request.
 * @param {'viewer' | 'admin'} minRole - Minimum required role.
 * @returns {SessionPayload} Verified session.
 * @throws {Error} If not authenticated or insufficient role.
 */
export function requireRole(req: Request, minRole: 'viewer' | 'editor' | 'admin'): SessionPayload {
  const session = getSessionFromRequest(req);
  if (!session) throw new Error('Not authenticated');

  const roleLevel: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, superadmin: 3 };
  if ((roleLevel[session.role] ?? -1) < (roleLevel[minRole] ?? 0)) {
    throw new Error('Insufficient permissions');
  }
  return session;
}

/** The cookie name used for auth sessions. */
export { COOKIE_NAME };
