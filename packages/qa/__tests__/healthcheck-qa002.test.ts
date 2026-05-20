import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent } from '../src';
import { runQA002 } from '../src/healthcheck/qa002-cross-refs';

const GOOD = resolve(__dirname, 'fixtures/good-agent');
const BAD = resolve(__dirname, 'fixtures/bad-agent');

describe('QA002 — cross-refs', () => {
  it('returns zero issues for a clean agent', () => {
    const { config } = loadAgent(GOOD);
    expect(runQA002(config)).toEqual([]);
  });

  it('flags dangling skill references', () => {
    const { config } = loadAgent(BAD);
    const issues = runQA002(config);
    expect(issues.some((i) => i.message.includes('skills/non-existent.md'))).toBe(true);
  });

  it('flags dangling wiki references', () => {
    const { config } = loadAgent(BAD);
    const issues = runQA002(config);
    expect(issues.some((i) => i.message.includes('wiki/non-existent.md'))).toBe(true);
  });

  it('all issues have QA002 code + error severity + a line', () => {
    const { config } = loadAgent(BAD);
    for (const i of runQA002(config)) {
      expect(i.code).toBe('QA002');
      expect(i.severity).toBe('error');
      expect(i.line).toBeGreaterThan(0);
    }
  });
});
