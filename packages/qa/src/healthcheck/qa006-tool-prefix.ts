import { join } from 'node:path';
import type { AgentConfig, HealthcheckIssue } from '../types';

const QUALIFIED_FULL = /\bmcp__[a-z][a-z0-9_-]*__[a-z_][a-z0-9_-]*\b/g;
const HYPHENATED_WORD = /\b([a-z][a-z0-9]*-[a-z][a-z0-9-]*)\b/g;

/**
 * QA006 — Tool prefix correctness.
 *
 * Catches bare hyphenated tool references where the qualified form
 * (`mcp__<server>__<tool>`) also appears somewhere in the agent. If
 * the qualified form is used in some places but the bare form leaks into
 * others, the bare ones are likely authoring mistakes.
 *
 * Limitation: only catches tool names that contain a hyphen, since
 * single-word names (e.g. `query`, `search`) are indistinguishable from
 * normal prose.
 */
export function runQA006(config: AgentConfig): HealthcheckIssue[] {
  const files = [
    { relPath: 'CLAUDE.md', raw: config.claudeMd.raw },
    ...config.skills.map((s) => ({ relPath: `skills/${s.path}`, raw: s.raw })),
  ];

  // Collect hyphenated tool names from all qualified refs across the agent.
  const knownTools = new Set<string>();
  for (const { raw } of files) {
    for (const m of raw.matchAll(QUALIFIED_FULL)) {
      const ref = m[0];
      const tool = ref.slice(ref.lastIndexOf('__') + 2);
      if (tool.includes('-')) knownTools.add(tool);
    }
  }

  if (knownTools.size === 0) return [];

  const issues: HealthcheckIssue[] = [];
  for (const { relPath, raw } of files) {
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Map out positions of qualified refs in this line so we can ignore
      // hyphenated-word matches that fall inside them.
      const ranges: Array<[number, number]> = [];
      for (const m of line.matchAll(QUALIFIED_FULL)) {
        const start = m.index ?? 0;
        ranges.push([start, start + m[0].length]);
      }

      for (const m of line.matchAll(HYPHENATED_WORD)) {
        const tool = m[1];
        if (!knownTools.has(tool)) continue;
        const idx = m.index ?? 0;
        if (ranges.some(([s, e]) => idx >= s && idx < e)) continue;
        issues.push({
          code: 'QA006',
          severity: 'error',
          file: join(config.dir, relPath),
          line: i + 1,
          message: `Bare tool reference "${tool}" should be qualified with the mcp__<server>__ prefix`,
        });
      }
    }
  }
  return issues;
}
