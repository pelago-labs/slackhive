/**
 * @fileoverview Workspace-wide cache of known SlackHive agent bot user IDs
 * → Agent. Module-level singleton so N MessageHandler instances share one
 * cache + one in-flight DB request, not N copies — was previously stored as
 * an instance field on every MessageHandler with its own TTL clock and its
 * own redundant DB query every minute.
 *
 * Used by `MessageHandler.isAuthorizedAgentTraffic` to enforce the
 * boss/reportee bypass on the user-access gate. Fail-closed semantics live
 * in the caller (returns false on lookup failure); this module simply
 * exposes the cached map and refreshes lazily.
 *
 * @module runner/agent-registry
 */

import type { Agent } from '@slackhive/shared';
import { getAgentsByBotUserId } from './db';

/** TTL for the cached map. New agents created within this window need to wait. */
const TTL_MS = 60_000;

let cache: Map<string, Agent> = new Map();
let expiresAt = 0;
let inflight: Promise<Map<string, Agent>> | null = null;

/**
 * Returns the workspace-wide map of `slack_bot_user_id` → Agent. Refreshed
 * lazily on first call after TTL expiry. Concurrent callers awaiting a cold
 * cache share a single in-flight DB query (the `inflight` promise dedupes).
 *
 * Throws on DB failure — the caller in `MessageHandler` catches and falls
 * back to fail-closed (deny the agent-traffic bypass) so a transient DB
 * blip doesn't grant unauthorized access.
 */
export async function getKnownAgentsByBotId(): Promise<Map<string, Agent>> {
  if (Date.now() <= expiresAt) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      cache = await getAgentsByBotUserId();
      expiresAt = Date.now() + TTL_MS;
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Test hook — resets the cache so unit tests start clean. Module-level
 * state would otherwise leak across test files. Not for production use.
 */
export function _resetAgentRegistryCache(): void {
  cache = new Map();
  expiresAt = 0;
  inflight = null;
}
