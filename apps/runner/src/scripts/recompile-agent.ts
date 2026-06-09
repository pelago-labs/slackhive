/**
 * @fileoverview One-off: recompile a single agent's workspace (AGENTS.md/skills/
 * wiki) from the current DB state. Use after editing an agent's claude_md
 * directly so the on-disk instructions match without waiting for a reload.
 *
 * Usage: npx tsx apps/runner/src/scripts/recompile-agent.ts <agentId>
 *
 * @module runner/scripts/recompile-agent
 */

import 'dotenv/config';
import { initDb } from '@slackhive/shared';
import { getAgentById } from '../db';
import { compileAgentWorkspace } from '../compile-instructions';

async function main(): Promise<void> {
  const agentId = process.argv[2];
  if (!agentId) { console.error('usage: recompile-agent.ts <agentId>'); process.exitCode = 1; return; }
  await initDb();
  const agent = await getAgentById(agentId);
  if (!agent) { console.error(`agent ${agentId} not found`); process.exitCode = 1; return; }
  const out = await compileAgentWorkspace(agent);
  console.log(`Recompiled ${agent.slug} → ${out}`);
}

main().catch((err) => { console.error('recompile failed:', (err as Error).message); process.exitCode = 1; });
