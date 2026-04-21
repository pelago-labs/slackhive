/**
 * @fileoverview In-memory sliding-window rate limiter.
 *
 * Used by /api/auth/login to slow password-guessing. Per-IP counter with a
 * fixed window. In-memory means it does NOT hold across server restarts and
 * is NOT shared across instances — sufficient for a single-node deployment
 * of this app, insufficient if horizontally scaled. If we ever run multiple
 * web processes, swap this for Redis.
 *
 * @module web/lib/rate-limit
 */

type Entry = { count: number; resetAt: number };

const buckets = new Map<string, Entry>();

/**
 * Check and record a hit against the limiter.
 *
 * @param key - Unique bucket key (typically `login:<ip>`).
 * @param limit - Max hits allowed per window.
 * @param windowMs - Window size in milliseconds.
 * @returns `{ allowed: true }` if under the limit, or
 *   `{ allowed: false, retryAfterSec }` if blocked.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (entry.count >= limit) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count += 1;
  return { allowed: true };
}

/**
 * Extract the client IP from common proxy headers. Falls back to 'unknown'
 * if no hint is available.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}
