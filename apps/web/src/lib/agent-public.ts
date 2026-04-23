/**
 * @fileoverview Public-safe Agent projection — strips platform credentials.
 *
 * The DB layer (`getAgentById`, `getAllAgents`) enriches agents with decrypted
 * platform tokens for the runner-facing code paths. API routes that return agents
 * to the browser must pass them through `toAgentPublic` first, otherwise any
 * authenticated user — including viewers — receives working bot tokens.
 *
 * `hasPlatformCreds` is the boolean the UI uses to render "credentials configured"
 * indicators without needing the raw token material.
 *
 * @module web/lib/agent-public
 */

import type { Agent } from '@slackhive/shared';

/**
 * Returns a copy of the agent with raw credential fields removed.
 * `platform`, `platformBotUserId`, and `hasPlatformCreds` are preserved —
 * they are needed by the UI and are not secrets.
 */
export function toAgentPublic(agent: Agent): Agent {
  const hasPlatformCreds = agent.hasPlatformCreds ?? Boolean(agent.platformCredentials);
  const { platformCredentials: _creds, ...rest } = agent;
  void _creds;
  return { ...rest, hasPlatformCreds };
}
