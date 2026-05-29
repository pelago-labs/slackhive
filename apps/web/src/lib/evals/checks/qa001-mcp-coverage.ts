/**
 * @fileoverview QA001 — MCP coverage.
 *
 * Walks the agent's `claudeMd` and every skill's `content` for
 * `mcp__<server>__<tool>` references. Reports each reference whose
 * `<server>` is not in the agent's enabled MCP server list.
 *
 * Server-prefix coverage only; we can't statically verify the
 * `<tool>` suffix without probing the MCP server itself.
 *
 * @module web/lib/evals/checks/qa001-mcp-coverage
 */

import type { CheckContext, HealthcheckIssue } from '../types';

const MCP_REF_PATTERN = /\bmcp__([a-z][a-z0-9_-]*)__([a-z_][a-z0-9_-]*)\b/g;

export function runQA001(ctx: CheckContext): HealthcheckIssue[] {
  const declared = new Set(ctx.mcps.map((m) => m.name));
  const issues: HealthcheckIssue[] = [];

  scanFile(ctx.parsedClaudeMd.raw, 'CLAUDE.md', declared, issues);

  for (const skill of ctx.skills) {
    scanFile(
      skill.content,
      `skills/${skill.category}/${skill.filename}`,
      declared,
      issues,
    );
  }

  return issues;
}

function scanFile(
  raw: string,
  filePath: string,
  declared: Set<string>,
  issues: HealthcheckIssue[],
): void {
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(MCP_REF_PATTERN)) {
      const server = match[1];
      if (!declared.has(server)) {
        issues.push({
          code: 'QA001',
          severity: 'error',
          file: filePath,
          line: i + 1,
          message: `MCP tool ref \`${match[0]}\` references server "${server}" not linked to this agent`,
        });
      }
    }
  }
}
