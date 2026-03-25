/**
 * @fileoverview Boss agent team registry regeneration.
 *
 * Regenerates the Boss agent's team registry skill whenever the agent roster
 * changes (agent created, updated, or deleted). The registry lists every
 * non-boss agent with their Slack user ID and description so Boss knows
 * who to delegate to.
 *
 * @module web/lib/boss-registry
 */

import { getAllAgents, upsertSkill, publishAgentEvent } from '@/lib/db';

/**
 * Regenerates the Boss agent's team registry skill from the current agent list.
 * Silently no-ops if no boss agent exists.
 *
 * Call this after any agent create / update / delete operation.
 *
 * @returns {Promise<void>}
 */
export async function regenerateBossRegistry(): Promise<void> {
  const agents = await getAllAgents();
  const boss = agents.find(a => a.isBoss);
  if (!boss) return;

  const teamAgents = agents.filter(a => !a.isBoss && a.slackBotUserId);
  if (teamAgents.length === 0) return;

  const lines = teamAgents.map(a => {
    const mention = a.slackBotUserId ? `<@${a.slackBotUserId}>` : `@${a.slug}`;
    return `- **${a.name}** (${mention}) — ${a.description ?? 'No description provided.'}`;
  });

  const registryContent = `# BOSS — Team Orchestrator

You are BOSS, the orchestrating agent for this team.

## Your Role
- Receive requests from users in Slack
- Understand which specialist agent is best suited for the task
- Delegate by @mentioning the specialist in the SAME thread — never answer specialist questions yourself
- If multiple specialists are needed, @mention them one at a time and wait for their response
- Summarise the final outcome to the user once the specialists are done

## Delegation Rules
- ALWAYS delegate — do not attempt to perform specialist work yourself
- Use the thread so specialists have full context
- If unsure who to delegate to, ask the user for clarification
- When delegating, use the format: "Let me get <@SLACK_USER_ID> on this 👇"

## Your Team

${lines.join('\n')}

## How to delegate

When you know who should handle the request, reply:
"Let me get <@SLACK_USER_ID> on this 👇"

Then @mention that agent in the thread so they have full context.`;

  await upsertSkill(boss.id, '00-core', 'identity.md', registryContent, 0);
  await publishAgentEvent({ type: 'reload', agentId: boss.id });
}
