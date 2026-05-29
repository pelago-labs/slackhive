/**
 * @fileoverview QA002 — Cross-refs.
 *
 * Walks the agent's `claudeMd` and every skill for markdown links
 * shaped `[text](skills/X.md)` or `[text](wiki/Y.md)`. Reports any
 * link whose target doesn't resolve to an actual skill row or wiki
 * source.
 *
 * @module web/lib/evals/checks/qa002-cross-refs
 */

import type { CheckContext, HealthcheckIssue } from '../types';

const SKILL_LINK = /\[[^\]]*\]\((skills\/[^)\s]+\.md)\)/g;
const WIKI_LINK = /\[[^\]]*\]\((wiki\/[^)\s]+\.md)\)/g;

export function runQA002(ctx: CheckContext): HealthcheckIssue[] {
  const skillPaths = new Set(
    ctx.skills.map((s) => `${s.category}/${s.filename}`),
  );
  // Wiki sources are stored by `name` without an extension; we strip
  // `.md` from captured refs before checking. Tolerate either form
  // in the source name just in case.
  const wikiNames = new Set<string>();
  for (const w of ctx.wikiSources) {
    wikiNames.add(w.name);
    wikiNames.add(w.name.replace(/\.md$/, ''));
  }

  const issues: HealthcheckIssue[] = [];

  const files: Array<{ file: string; raw: string }> = [
    { file: 'CLAUDE.md', raw: ctx.parsedClaudeMd.raw },
    ...ctx.skills.map((s) => ({
      file: `skills/${s.category}/${s.filename}`,
      raw: s.content,
    })),
  ];

  for (const { file, raw } of files) {
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(SKILL_LINK)) {
        const rel = m[1].replace(/^skills\//, '');
        if (!skillPaths.has(rel)) {
          issues.push({
            code: 'QA002',
            severity: 'error',
            file,
            line: i + 1,
            message: `Dangling skill reference \`${m[1]}\` — no matching skill row`,
          });
        }
      }
      for (const m of lines[i].matchAll(WIKI_LINK)) {
        const name = m[1].replace(/^wiki\//, '').replace(/\.md$/, '');
        if (!wikiNames.has(name)) {
          issues.push({
            code: 'QA002',
            severity: 'error',
            file,
            line: i + 1,
            message: `Dangling wiki reference \`${m[1]}\` — no matching wiki source`,
          });
        }
      }
    }
  }

  return issues;
}
