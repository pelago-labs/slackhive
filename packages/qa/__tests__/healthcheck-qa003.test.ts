import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent } from '../src';
import { runQA003 } from '../src/healthcheck/qa003-trigger-conflicts';

const GOOD = resolve(__dirname, 'fixtures/good-agent');
const BAD = resolve(__dirname, 'fixtures/bad-agent');

describe('QA003 — trigger conflicts', () => {
  it('returns zero issues for a clean agent (single trigger)', () => {
    const { config } = loadAgent(GOOD);
    expect(runQA003(config)).toEqual([]);
  });

  it('flags prefix-overlapping triggers', () => {
    const { config } = loadAgent(BAD);
    const issues = runQA003(config);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].code).toBe('QA003');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('bad hello');
    expect(issues[0].message).toContain('bad hello world');
  });

  it('flags exact duplicate triggers', () => {
    const synthetic = {
      dir: '/fake',
      claudeMd: {
        raw: '',
        triggers: ['foo', 'foo'],
        mcpReferences: [],
        skillReferences: [],
        wikiReferences: [],
      },
      skills: [],
      wikiEntities: [],
      mcps: [],
    };
    const issues = runQA003(synthetic);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('Duplicate');
  });
});
