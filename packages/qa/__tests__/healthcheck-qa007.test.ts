import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent } from '../src';
import { runQA007 } from '../src/healthcheck/qa007-wiki-coverage';

const GOOD = resolve(__dirname, 'fixtures/good-agent');
const BAD = resolve(__dirname, 'fixtures/bad-agent');

describe('QA007 — wiki coverage (orphan check)', () => {
  it('returns zero issues for a clean agent (test-entity.md is linked)', () => {
    const { config } = loadAgent(GOOD);
    expect(runQA007(config)).toEqual([]);
  });

  it('flags orphaned wiki files', () => {
    const { config } = loadAgent(BAD);
    const issues = runQA007(config);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].code).toBe('QA007');
    expect(issues[0].severity).toBe('warn');
    expect(issues.some((i) => i.file.endsWith('orphan.md'))).toBe(true);
  });
});
