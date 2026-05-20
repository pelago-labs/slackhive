import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent } from '../src';
import { runQA004 } from '../src/healthcheck/qa004-skill-overlap';

const GOOD = resolve(__dirname, 'fixtures/good-agent');
const BAD = resolve(__dirname, 'fixtures/bad-agent');

describe('QA004 — skill description overlap', () => {
  it('returns zero issues for a clean agent (single skill)', () => {
    const { config } = loadAgent(GOOD);
    expect(runQA004(config)).toEqual([]);
  });

  it('flags near-duplicate skill descriptions', () => {
    const { config } = loadAgent(BAD);
    const issues = runQA004(config);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].code).toBe('QA004');
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].message).toContain('Jaccard');
  });

  it('Jaccard threshold ignores unrelated descriptions', () => {
    const synthetic = {
      dir: '/fake',
      claudeMd: {
        raw: '',
        triggers: [],
        mcpReferences: [],
        skillReferences: [],
        wikiReferences: [],
      },
      skills: [
        { path: 'a.md', name: 'a', description: 'apple banana cherry', raw: '' },
        { path: 'b.md', name: 'b', description: 'dog elephant frog', raw: '' },
      ],
      wikiEntities: [],
      mcps: [],
    };
    expect(runQA004(synthetic)).toEqual([]);
  });
});
