/**
 * @fileoverview Public-safe Agent projection — strips Slack credentials.
 *
 * The DB layer (`getAgentById`, `getAllAgents`) enriches agents with decrypted
 * Slack tokens for the runner-facing code paths. API routes that return agents
 * to the browser must pass them through `toAgentPublic` first, otherwise any
 * authenticated user — including viewers — receives working bot tokens.
 *
 * `hasSlackCreds` is the boolean the UI uses to render "credentials configured"
 * indicators without needing the raw token material.
 *
 * @module web/lib/agent-public
 */

import type { Agent } from '@slackhive/shared';

/**
 * Returns a copy of the agent with Slack secret fields removed and a
 * `hasSlackCreds` presence flag set. `slackBotUserId` is preserved — it is a
 * public Slack identifier used for `<@Uxxx>` mentions, not a secret.
 */
export function toAgentPublic(agent: Agent): Agent {
  const hasSlackCreds = Boolean(
    agent.slackBotToken && agent.slackAppToken && agent.slackSigningSecret
  );
  const {
    slackBotToken: _botToken,
    slackAppToken: _appToken,
    slackSigningSecret: _signingSecret,
    ...rest
  } = agent;
  void _botToken; void _appToken; void _signingSecret;
  return { ...rest, hasSlackCreds };
}
