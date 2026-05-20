import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent } from '../src';
import { runQA005 } from '../src/healthcheck/qa005-persona-hygiene';

const GOOD = resolve(__dirname, 'fixtures/good-agent');
const BAD = resolve(__dirname, 'fixtures/bad-agent');

describe('QA005 — persona hygiene', () => {
  it('returns zero issues for a clean agent', () => {
    const { config } = loadAgent(GOOD);
    expect(runQA005(config)).toEqual([]);
  });

  it('flags every banned pattern present in the bad fixture', () => {
    const { config } = loadAgent(BAD);
    const issues = runQA005(config);
    const messages = issues.map((i) => i.message);

    expect(messages.some((m) => m.includes('force-push'))).toBe(true);
    expect(messages.some((m) => m.includes('--no-verify'))).toBe(true);
    expect(messages.some((m) => m.includes('rm -rf'))).toBe(true);
    expect(messages.some((m) => m.includes('prompt-injection'))).toBe(true);
    expect(messages.some((m) => m.includes('system override'))).toBe(true);
    expect(messages.some((m) => m.includes('always-agree'))).toBe(true);
  });

  it('all issues have QA005 code + error severity + a line', () => {
    const { config } = loadAgent(BAD);
    for (const i of runQA005(config)) {
      expect(i.code).toBe('QA005');
      expect(i.severity).toBe('error');
      expect(i.line).toBeGreaterThan(0);
    }
  });
});
