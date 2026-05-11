/**
 * @fileoverview Per-runner LRU cache for `userCanTrigger` results.
 *
 * Every inbound Slack message runs the access check in MessageHandler before
 * the agent does anything. For non-admins that's two DB round-trips
 * (users-by-slack-id, then a UNION over agents + agent_access). Caching the
 * boolean result per (agentId, slackUserId) for 60s cuts the hot path to a
 * single Map lookup for repeated senders.
 *
 * Cache invalidation: the web tier publishes `user-access-changed` events on
 * grant/revoke/user mutation. agent-runner.ts subscribes and calls
 * `flushUserAccess({ userId })` (targeted when we know the DB user id, or
 * coarse clear() when an admin event has no payload).
 *
 * Disable knob: PERF_CACHES_ENABLED=0 makes every operation a pass-through.
 * Useful for debugging and for benchmarking the un-cached baseline.
 *
 * @module runner/access-cache
 */

import { LruCache } from './lru-cache';

/**
 * Read fresh each call so toggling `.env` + restart isn't required to
 * enable/disable. Matches the `activityDashboardEnabled()` convention used
 * elsewhere in the runner.
 */
function cachesEnabled(): boolean {
  return process.env.PERF_CACHES_ENABLED !== '0';
}
const TTL_MS = 60_000;
const CAPACITY = 1000;

// Key shape: `${agentId}:${slackUserId}`. We keep the cache global so all
// MessageHandler instances (one per agent) share the same store — the agentId
// prefix keeps lookups disjoint.
const cache = new LruCache<string, boolean>(CAPACITY, TTL_MS);

/** Cache key for the (agent, sender) pair. */
function keyOf(agentId: string, slackUserId: string): string {
  return `${agentId}:${slackUserId}`;
}

/** Cached read; returns `undefined` when nothing is cached (or caching is disabled). */
export function getCachedUserCanTrigger(agentId: string, slackUserId: string): boolean | undefined {
  if (!cachesEnabled()) return undefined;
  return cache.get(keyOf(agentId, slackUserId));
}

/** Store a fresh result. No-op when caching is disabled. */
export function setCachedUserCanTrigger(agentId: string, slackUserId: string, allowed: boolean): void {
  if (!cachesEnabled()) return;
  cache.set(keyOf(agentId, slackUserId), allowed);
}

/**
 * Invalidate cache entries.
 *
 * - `opts.slackUserId`: drop every entry for that Slack user (any agent).
 *   The cache key suffix is the slack user id, so this is a fast `deleteWhere`.
 * - `opts.agentId`: drop every entry for that agent (any sender). Used when an
 *   agent is deleted or its access surface changes wholesale.
 * - `opts.userId` (DB id, not Slack id): we don't know the slack mapping here,
 *   so this is a coarse `clear()` — correct but throws away unrelated entries.
 *   Acceptable cost given user mutations are rare.
 * - No args: `clear()`.
 */
export function flushUserAccessCache(opts?: { slackUserId?: string; agentId?: string; userId?: string }): void {
  if (!cachesEnabled()) return;
  if (!opts) { cache.clear(); return; }
  if (opts.slackUserId) {
    cache.deleteWhere(k => k.endsWith(`:${opts.slackUserId}`));
    return;
  }
  if (opts.agentId) {
    cache.deleteWhere(k => k.startsWith(`${opts.agentId}:`));
    return;
  }
  // DB userId without slack mapping: coarse clear, since we can't resolve here.
  cache.clear();
}

/** Test hook — drop every entry without running through the enable gate. */
export function _resetAccessCache(): void {
  cache.clear();
}

/** Debugging helper. */
export function _accessCacheSize(): number {
  return cache.size;
}

// ─── Event dispatcher ─────────────────────────────────────────────────────────
// Exported so the runner's bus subscriber can call it and the test suite can
// drive it without loading the full AgentRunner. Routes the cache-invalidation
// events to the right flush. Defined here (next to the cache it manages)
// rather than in agent-runner.ts so the switch stays alongside the cache
// implementation it depends on.

import type { AgentEvent } from '@slackhive/shared';
import { flushEnvVarsCache } from './db';

/** Returns `true` if the event was handled, `false` otherwise. */
export function dispatchCacheEvent(event: AgentEvent): boolean {
  switch (event.type) {
    case 'user-access-changed':
      flushUserAccessCache({
        slackUserId: event.slackUserId,
        agentId: event.agentId,
        userId: event.userId,
      });
      return true;
    case 'env-vars-changed':
      flushEnvVarsCache();
      return true;
    default:
      return false;
  }
}
