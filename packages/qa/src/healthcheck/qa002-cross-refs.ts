import { join } from 'node:path';
import type { AgentConfig, HealthcheckIssue } from '../types';

const WIKI_LINK = /\[[^\]]*\]\((wiki\/[^)\s]+\.md)\)/g;
const SKILL_LINK = /\[[^\]]*\]\((skills\/[^)\s]+\.md)\)/g;

/**
 * QA002 — Cross-refs.
 *
 * Walks CLAUDE.md and every skill for markdown links into `skills/X.md` or
 * `wiki/Y.md`. Reports refs whose target file does not exist.
 */
export function runQA002(config: AgentConfig): HealthcheckIssue[] {
  const skillPaths = new Set(config.skills.map((s) => s.path));
  const wikiPaths = new Set(config.wikiEntities);
  const issues: HealthcheckIssue[] = [];

  const files = [
    { absPath: join(config.dir, 'CLAUDE.md'), raw: config.claudeMd.raw },
    ...config.skills.map((s) => ({
      absPath: join(config.dir, 'skills', s.path),
      raw: s.raw,
    })),
  ];

  for (const { absPath, raw } of files) {
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(SKILL_LINK)) {
        const rel = m[1].replace(/^skills\//, '');
        if (!skillPaths.has(rel)) {
          issues.push({
            code: 'QA002',
            severity: 'error',
            file: absPath,
            line: i + 1,
            message: `Dangling skill reference \`${m[1]}\` — file does not exist`,
          });
        }
      }
      for (const m of lines[i].matchAll(WIKI_LINK)) {
        const rel = m[1].replace(/^wiki\//, '');
        if (!wikiPaths.has(rel)) {
          issues.push({
            code: 'QA002',
            severity: 'error',
            file: absPath,
            line: i + 1,
            message: `Dangling wiki reference \`${m[1]}\` — file does not exist`,
          });
        }
      }
    }
  }

  return issues;
}
