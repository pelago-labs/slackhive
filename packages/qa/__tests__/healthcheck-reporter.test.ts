import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent } from '../src';
import { runHealthcheck } from '../src/healthcheck';
import { reportEslintStyle, reportJson, summarize } from '../src/healthcheck/reporter';
import type { HealthcheckIssue } from '../src/types';

const GOOD = resolve(__dirname, 'fixtures/good-agent');
const BAD = resolve(__dirname, 'fixtures/bad-agent');

describe('runHealthcheck (aggregator)', () => {
  it('returns zero issues for a clean agent', () => {
    const { config, corpus, corpusError } = loadAgent(GOOD);
    expect(runHealthcheck(config, corpus, corpusError)).toEqual([]);
  });

  it('aggregates issues across all 9 checks against the bad agent', () => {
    const { config, corpus, corpusError } = loadAgent(BAD);
    const issues = runHealthcheck(config, corpus, corpusError);
    const codes = new Set(issues.map((i) => i.code));
    // bad-agent seeds violations across 8 of 9 checks (QA003 seeded too)
    for (const expected of ['QA001', 'QA002', 'QA003', 'QA004', 'QA005', 'QA006', 'QA007', 'QA009']) {
      expect(codes.has(expected)).toBe(true);
    }
  });

  it('emits a QA009 issue when corpus failed to load', () => {
    const fakeConfig = {
      dir: '/fake',
      claudeMd: {
        raw: '',
        triggers: [],
        mcpReferences: [],
        skillReferences: [],
        wikiReferences: [],
      },
      skills: [],
      wikiEntities: [],
      mcps: [],
    };
    const issues = runHealthcheck(fakeConfig, null, 'malformed YAML at line 3');
    const qa009 = issues.filter((i) => i.code === 'QA009');
    expect(qa009.length).toBe(1);
    expect(qa009[0].message).toContain('malformed YAML');
    expect(qa009[0].severity).toBe('error');
  });
});

describe('summarize', () => {
  it('counts errors and warnings', () => {
    const issues: HealthcheckIssue[] = [
      { code: 'QA001', severity: 'error', file: 'a', message: 'x' },
      { code: 'QA001', severity: 'error', file: 'a', message: 'y' },
      { code: 'QA007', severity: 'warn', file: 'b', message: 'z' },
    ];
    expect(summarize(issues)).toEqual({ total: 3, errors: 2, warnings: 1 });
  });
});

describe('reportEslintStyle', () => {
  it('returns a success line on empty issues', () => {
    expect(reportEslintStyle([])).toContain('No issues');
  });

  it('groups issues by file and includes summary line', () => {
    const issues: HealthcheckIssue[] = [
      { code: 'QA001', severity: 'error', file: '/x/CLAUDE.md', line: 5, message: 'one' },
      { code: 'QA001', severity: 'error', file: '/x/CLAUDE.md', line: 10, message: 'two' },
      { code: 'QA007', severity: 'warn', file: '/x/wiki/foo.md', message: 'three' },
    ];
    const out = reportEslintStyle(issues);
    expect(out).toContain('/x/CLAUDE.md');
    expect(out).toContain('5:1');
    expect(out).toContain('10:1');
    expect(out).toContain('/x/wiki/foo.md');
    expect(out).toMatch(/3 problems \(2 errors, 1 warning\)/);
  });
});

describe('reportJson', () => {
  it('produces valid JSON with summary and issues', () => {
    const issues: HealthcheckIssue[] = [
      { code: 'QA001', severity: 'error', file: '/x', message: 'm' },
    ];
    const parsed = JSON.parse(reportJson(issues));
    expect(parsed.summary).toEqual({ total: 1, errors: 1, warnings: 0 });
    expect(parsed.issues).toEqual(issues);
  });
});
