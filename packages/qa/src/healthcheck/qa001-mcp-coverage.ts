import { join } from 'node:path';
import type { AgentConfig, HealthcheckIssue } from '../types';

const MCP_REF_PATTERN = /\bmcp__([a-z][a-z0-9_-]*)__([a-z_][a-z0-9_-]*)\b/g;

/**
 * QA001 — MCP coverage.
 *
 * Walk CLAUDE.md and every skill for `mcp__<server>__<tool>` references.
 * Report each reference whose `<server>` is not declared in `mcps.yaml`.
 *
 * Server-prefix coverage only; the framework cannot statically verify the
 * `<tool>` suffix without probing the MCP server itself.
 */
export function runQA001(config: AgentConfig): HealthcheckIssue[] {
  const declared = new Set(config.mcps);
  const issues: HealthcheckIssue[] = [];

  scanFile(
    config.claudeMd.raw,
    join(config.dir, 'CLAUDE.md'),
    declared,
    issues,
  );

  for (const skill of config.skills) {
    scanFile(
      skill.raw,
      join(config.dir, 'skills', skill.path),
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
          message: `MCP tool ref \`${match[0]}\` references server "${server}" not declared in mcps.yaml`,
        });
      }
    }
  }
}
