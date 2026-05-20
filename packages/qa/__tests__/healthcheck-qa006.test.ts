import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent } from '../src';
import { runQA006 } from '../src/healthcheck/qa006-tool-prefix';

const GOOD = resolve(__dirname, 'fixtures/good-agent');
const BAD = resolve(__dirname, 'fixtures/bad-agent');

describe('QA006 — tool prefix correctness', () => {
  it('returns zero issues for a clean agent (notion-fetch only appears qualified)', () => {
    const { config } = loadAgent(GOOD);
    expect(runQA006(config)).toEqual([]);
  });

  it('flags bare hyphenated tool refs whose qualified form exists elsewhere', () => {
    const { config } = loadAgent(BAD);
    const issues = runQA006(config);
    expect(issues.length).toBeGreaterThanOrEqual(2); // CLAUDE.md + bad-skill.md
    for (const i of issues) {
      expect(i.code).toBe('QA006');
      expect(i.severity).toBe('error');
      expect(i.message).toContain('notion-fetch');
      expect(i.line).toBeGreaterThan(0);
    }
    const files = new Set(issues.map((i) => i.file));
    expect([...files].some((f) => f.endsWith('CLAUDE.md'))).toBe(true);
    expect([...files].some((f) => f.endsWith('bad-skill.md'))).toBe(true);
  });

  it('returns no issues when no qualified MCP refs exist at all', () => {
    const synthetic = {
      dir: '/fake',
      claudeMd: {
        raw: 'Just a plain doc with notion-fetch mentioned bare. No qualified refs.',
        triggers: [],
        mcpReferences: [],
        skillReferences: [],
        wikiReferences: [],
      },
      skills: [],
      wikiEntities: [],
      mcps: [],
    };
    expect(runQA006(synthetic)).toEqual([]);
  });
});
