/**
 * @fileoverview Boss agent team registry regeneration.
 *
 * Regenerates each boss agent's team registry skill whenever the agent roster
 * changes (agent created, updated, or deleted). The registry lists every
 * specialist agent that reports to a given boss, with their Slack user ID and
 * description, so the boss knows who to delegate to.
 *
 * Multiple boss agents are supported. Each boss gets its own registry built
 * from the agents whose `reportsTo` array includes that boss's ID.
 *
 * @module web/lib/boss-registry
 */

import type { Agent } from '@slackhive/shared';
import { getAllAgents, upsertSkill, publishAgentEvent } from '@/lib/db';

/**
 * Regenerates team registry skills for all boss agents.
 * Silently no-ops if no boss agent exists.
 *
 * Call this after any agent create / update / delete operation.
 *
 * @returns {Promise<void>}
 */
export async function regenerateBossRegistry(): Promise<void> {
  const agents = await getAllAgents();
  const bosses = agents.filter(a => a.isBoss);
  if (bosses.length === 0) return;

  for (const boss of bosses) {
    await regenerateSingleBossRegistry(boss, agents);
  }
}

/**
 * Regenerates the registry skill for one boss agent.
 *
 * @param {Agent} boss - The boss agent to regenerate for.
 * @param {Agent[]} agents - All agents in the platform.
 * @returns {Promise<void>}
 */
async function regenerateSingleBossRegistry(boss: Agent, agents: Agent[]): Promise<void> {
  const teamAgents = agents.filter(a => a.reportsTo.includes(boss.id) && a.slackBotUserId);
  if (teamAgents.length === 0) return;

  const lines = teamAgents.map(a => {
    const mention = a.slackBotUserId ? `<@${a.slackBotUserId}>` : `@${a.slug}`;
    return `- **${a.name}** (${mention}) — ${a.description ?? 'No description provided.'}`;
  });

  const registryContent = `# ${boss.name} — Team Orchestrator

You are ${boss.name}, the orchestrating agent for this team.

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
