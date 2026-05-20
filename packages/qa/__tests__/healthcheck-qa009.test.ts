import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent } from '../src';
import { runQA009 } from '../src/healthcheck/qa009-corpus-shape';

const GOOD = resolve(__dirname, 'fixtures/good-agent');
const BAD = resolve(__dirname, 'fixtures/bad-agent');

describe('QA009 — corpus shape', () => {
  it('returns zero issues for a clean corpus', () => {
    const { corpus } = loadAgent(GOOD);
    expect(runQA009(corpus)).toEqual([]);
  });

  it('flags invalid primitive', () => {
    const { corpus } = loadAgent(BAD);
    const issues = runQA009(corpus);
    expect(issues.some((i) => i.message.includes('primitive') && i.message.includes('not_a_real_primitive'))).toBe(true);
  });

  it('flags invalid target', () => {
    const { corpus } = loadAgent(BAD);
    const issues = runQA009(corpus);
    expect(issues.some((i) => i.message.includes('target') && i.message.includes('not_a_real_target'))).toBe(true);
  });

  it('flags missing rubric file', () => {
    const { corpus } = loadAgent(BAD);
    const issues = runQA009(corpus);
    expect(issues.some((i) => i.message.includes('rubric') && i.message.includes('does-not-exist.md'))).toBe(true);
  });

  it('flags _from referencing a nonexistent case field', () => {
    const { corpus } = loadAgent(BAD);
    const issues = runQA009(corpus);
    expect(issues.some((i) => i.message.includes('contains_from') && i.message.includes('nonexistent_field'))).toBe(true);
  });

  it('returns no issues when corpus is null', () => {
    expect(runQA009(null)).toEqual([]);
  });
});
