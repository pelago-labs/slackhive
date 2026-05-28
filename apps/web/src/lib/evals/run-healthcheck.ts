/**
 * @fileoverview Entry point for Tier 1 healthcheck.
 *
 * Takes slackhive's native Agent + related rows, parses the agent's
 * `claudeMd` once into a `ParsedClaudeMd`, builds a `CheckContext`,
 * fans out to all 7 Tier 1 checks, and returns the aggregated
 * `{ summary, issues }` shape consumed by the Evals tab.
 *
 * QA008 + QA009 are intentionally absent — they depend on a test
 * case corpus, which slackhive does not yet model in the DB.
 * They will be added when the eval-case storage decision lands.
 *
 * @module web/lib/evals/run-healthcheck
 */

import type { Agent, McpServer, Skill, WikiSource } from '@slackhive/shared';
import { parseClaudeMd } from './parse-claude-md';
import type { CheckContext, HealthcheckResult } from './types';
import { runQA001 } from './checks/qa001-mcp-coverage';
import { runQA002 } from './checks/qa002-cross-refs';
import { runQA004 } from './checks/qa004-skill-overlap';
import { runQA005 } from './checks/qa005-persona-hygiene';

export function runHealthcheck(
  agent: Agent,
  skills: Skill[],
  mcps: McpServer[],
  wikiSources: WikiSource[],
): HealthcheckResult {
  const ctx: CheckContext = {
    parsedClaudeMd: parseClaudeMd(agent.claudeMd),
    skills,
    mcps,
    wikiSources,
  };

  const issues = [
    ...runQA001(ctx),
    ...runQA002(ctx),
    ...runQA004(ctx),
    ...runQA005(ctx),
  ];

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warn').length;

  return {
    summary: { total: issues.length, errors, warnings },
    issues,
  };
}
