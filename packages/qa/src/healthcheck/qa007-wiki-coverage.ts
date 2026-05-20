import { join } from 'node:path';
import type { AgentConfig, HealthcheckIssue } from '../types';

const WIKI_LINK = /\[[^\]]*\]\((wiki\/[^)\s]+\.md)\)/g;

/**
 * QA007 — Wiki coverage.
 *
 * For every wiki file in the agent's wiki/ directory, check whether at
 * least one markdown link from CLAUDE.md or any skill points to it.
 * Reports orphaned wiki files — entities that exist but are never linked,
 * suggesting either dead content or undocumented references.
 *
 * Distinct from QA002 (which flags links pointing to nonexistent files);
 * QA007 inverts the direction (files with no incoming reference).
 *
 * Severity: warn (most agents will have *some* orphans, especially during
 * active development; this is informational coverage, not a hard error).
 */
export function runQA007(config: AgentConfig): HealthcheckIssue[] {
  const referenced = new Set<string>();

  collectRefs(config.claudeMd.raw, referenced);
  for (const skill of config.skills) {
    collectRefs(skill.raw, referenced);
  }

  const issues: HealthcheckIssue[] = [];
  for (const entity of config.wikiEntities) {
    if (!referenced.has(entity)) {
      issues.push({
        code: 'QA007',
        severity: 'warn',
        file: join(config.dir, 'wiki', entity),
        message: `Wiki entity not referenced by CLAUDE.md or any skill — possibly orphaned`,
      });
    }
  }
  return issues;
}

function collectRefs(raw: string, sink: Set<string>): void {
  for (const m of raw.matchAll(WIKI_LINK)) {
    sink.add(m[1].replace(/^wiki\//, ''));
  }
}
