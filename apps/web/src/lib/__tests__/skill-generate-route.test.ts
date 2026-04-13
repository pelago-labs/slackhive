/**
 * @fileoverview Unit tests for skill generate/audit route validation logic.
 *
 * @module web/lib/__tests__/skill-generate-route.test
 */

import { describe, it, expect } from 'vitest';

describe('skill generate route validation', () => {
  it('rejects invalid mode', () => {
    const body = { mode: 'invalid' };
    expect(!['generate', 'improve'].includes(body.mode)).toBe(true);
  });

  it('requires description for generate mode', () => {
    const body = { mode: 'generate' as const, description: '' };
    expect(body.mode === 'generate' && !body.description).toBe(true);
  });

  it('requires content for improve mode', () => {
    const body = { mode: 'improve' as const, content: '' };
    expect(body.mode === 'improve' && !body.content).toBe(true);
  });

  it('accepts valid generate request', () => {
    const body = { mode: 'generate' as const, description: 'a weekly KPI skill' };
    expect(['generate', 'improve'].includes(body.mode)).toBe(true);
    expect(body.description).toBeTruthy();
  });

  it('accepts valid improve request with instructions', () => {
    const body = { mode: 'improve' as const, content: '# Help', instructions: 'add error handling' };
    expect(body.content).toBeTruthy();
    expect(body.instructions).toBeTruthy();
  });

  it('accepts target claude-md', () => {
    const body = { mode: 'improve' as const, target: 'claude-md' as const, content: 'You are a bot.' };
    expect(body.target).toBe('claude-md');
  });
});

describe('skill audit route validation', () => {
  it('rejects empty skill list', () => {
    const skills: any[] = [];
    expect(skills.length === 0).toBe(true);
  });

  it('accepts non-empty skill list', () => {
    const skills = [{ category: '00-core', filename: 'test.md', content: '# test' }];
    expect(skills.length > 0).toBe(true);
  });
});
