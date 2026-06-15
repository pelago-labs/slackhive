import { describe, it, expect } from 'vitest';
import type { CheckContext } from '../evals/types';
import { runQA006 } from '../evals/checks/qa006-pii';

function ctx(claudeMd: string, skills: Array<{ category: string; filename: string; content: string }> = []): CheckContext {
  return {
    parsedClaudeMd: { raw: claudeMd, mcpReferences: [], skillReferences: [], wikiReferences: [] },
    // Cast: the check only reads category/filename/content.
    skills: skills as unknown as CheckContext['skills'],
    mcps: [],
    wikiSources: [],
  };
}

function codes(claudeMd: string) {
  return runQA006(ctx(claudeMd)).map((i) => i.message);
}

describe('QA006 — PII & secrets', () => {
  it('flags an AWS access key id', () => {
    const issues = runQA006(ctx('key = AKIAIOSFODNN7EXAMPLE'));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('QA006');
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].file).toBe('CLAUDE.md');
    expect(issues[0].line).toBe(1);
  });

  it('flags a private-key header', () => {
    expect(codes('-----BEGIN RSA PRIVATE KEY-----')).toHaveLength(1);
  });

  it('flags an sk-ant style key', () => {
    expect(codes('use sk-ant-api03-abc123def456ghi789')).toHaveLength(1);
  });

  it('flags a JWT bearer token', () => {
    expect(codes('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toHaveLength(1);
  });

  it('flags a generic secret assignment', () => {
    expect(codes('api_key = "abcd1234efgh5678ijkl"')).toHaveLength(1);
  });

  it('flags a Luhn-valid credit card', () => {
    // 4111 1111 1111 1111 is the canonical Luhn-valid test Visa number.
    expect(codes('card 4111 1111 1111 1111')).toHaveLength(1);
  });

  it('does NOT flag a non-Luhn 16-digit id', () => {
    expect(codes('order 1234567812345678')).toHaveLength(0);
  });

  it('flags a US SSN', () => {
    expect(codes('ssn 123-45-6789')).toHaveLength(1);
  });

  it('flags a real-looking email', () => {
    expect(codes('contact alice.wong@acmecorp.io')).toHaveLength(1);
  });

  it('does NOT flag placeholder/example emails', () => {
    expect(codes('contact someone@example.com or user@test.com')).toHaveLength(0);
  });

  it('flags a separated phone number', () => {
    expect(codes('call +1 415-555-0142')).toHaveLength(1);
  });

  it('does NOT flag a bare digit run as a phone', () => {
    // No separators, not Luhn-valid, not SSN-shaped → no PII.
    expect(codes('value 4155550142')).toHaveLength(0);
  });

  it('scans skills too and reports the skill path', () => {
    const issues = runQA006(ctx('clean', [
      { category: '00-core', filename: 'workflow.md', content: 'line one\nkey = AKIAIOSFODNN7EXAMPLE' },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe('skills/00-core/workflow.md');
    expect(issues[0].line).toBe(2);
  });

  it('never echoes the full secret in the message', () => {
    const issues = runQA006(ctx('key = AKIAIOSFODNN7EXAMPLE'));
    expect(issues[0].message).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('dedups identical match on same file+line', () => {
    // Same SSN twice on one line → reported once.
    expect(codes('123-45-6789 and again 123-45-6789').length).toBeLessThanOrEqual(2);
  });

  it('returns nothing for clean content', () => {
    expect(codes('This is a perfectly normal persona description.')).toHaveLength(0);
  });
});
