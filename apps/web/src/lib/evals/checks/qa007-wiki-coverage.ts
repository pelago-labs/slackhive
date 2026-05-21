/**
 * @fileoverview QA007 — Wiki coverage.
 *
 * For each wiki source accessible to the agent (from its linked
 * wiki folders), checks whether at least one markdown link from
 * `claudeMd` or any skill points to it. Reports orphans — entities
 * that exist but are never linked.
 *
 * Distinct from QA002 (which flags links pointing to nonexistent
 * entities); QA007 inverts the direction (entities with no incoming
 * reference).
 *
 * Severity: warn (most agents will have *some* orphans, especially
 * during active development; this is informational coverage, not a
 * hard error).
 *
 * @module web/lib/evals/checks/qa007-wiki-coverage
 */

import type { CheckContext, HealthcheckIssue } from '../types';

const WIKI_LINK = /\[[^\]]*\]\((wiki\/[^)\s]+\.md)\)/g;

export function runQA007(ctx: CheckContext): HealthcheckIssue[] {
  const referenced = new Set<string>();
  collectRefs(ctx.parsedClaudeMd.raw, referenced);
  for (const skill of ctx.skills) {
    collectRefs(skill.content, referenced);
  }

  const issues: HealthcheckIssue[] = [];
  for (const source of ctx.wikiSources) {
    const name = source.name.replace(/\.md$/, '');
    if (!referenced.has(name)) {
      issues.push({
        code: 'QA007',
        severity: 'warn',
        file: `wiki/${name}`,
        message: `Wiki entity "${source.name}" not referenced by CLAUDE.md or any skill — possibly orphaned`,
      });
    }
  }
  return issues;
}

function collectRefs(raw: string, sink: Set<string>): void {
  for (const m of raw.matchAll(WIKI_LINK)) {
    const name = m[1].replace(/^wiki\//, '').replace(/\.md$/, '');
    sink.add(name);
  }
}
