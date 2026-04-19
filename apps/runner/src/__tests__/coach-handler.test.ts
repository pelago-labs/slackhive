/**
 * @fileoverview Unit tests for coach-handler helpers.
 *
 * Focuses on the security-critical path sanitizer. The SDK-driven turn loop is
 * exercised by integration runs rather than unit-mocked here.
 *
 * @module runner/__tests__/coach-handler.test
 */

import { describe, it, expect } from 'vitest';
import { assertSafeSkillPath } from '../coach-handler';

describe('assertSafeSkillPath', () => {
  it('accepts safe category + filename pairs', () => {
    expect(() => assertSafeSkillPath('nlq', 'answer.md')).not.toThrow();
    expect(() => assertSafeSkillPath('00-core', 'identity.md')).not.toThrow();
    expect(() => assertSafeSkillPath('my_skill.v2', 'file-name.md')).not.toThrow();
  });

  it('rejects path traversal in filename', () => {
    expect(() => assertSafeSkillPath('nlq', '../escape.md')).toThrow(/invalid filename/);
    expect(() => assertSafeSkillPath('nlq', '..')).toThrow(/invalid filename/);
  });

  it('rejects path traversal in category', () => {
    expect(() => assertSafeSkillPath('../secrets', 'ok.md')).toThrow(/invalid category/);
    expect(() => assertSafeSkillPath('..', 'ok.md')).toThrow(/invalid category/);
  });

  it('rejects slashes', () => {
    expect(() => assertSafeSkillPath('nlq', 'sub/foo.md')).toThrow(/invalid filename/);
    expect(() => assertSafeSkillPath('nlq', 'back\\slash.md')).toThrow(/invalid filename/);
    expect(() => assertSafeSkillPath('a/b', 'ok.md')).toThrow(/invalid category/);
  });

  it('rejects empty values', () => {
    expect(() => assertSafeSkillPath('', 'ok.md')).toThrow(/invalid category/);
    expect(() => assertSafeSkillPath('cat', '')).toThrow(/invalid filename/);
  });

  it('rejects null bytes and whitespace', () => {
    expect(() => assertSafeSkillPath('nlq', 'has space.md')).toThrow(/invalid filename/);
    expect(() => assertSafeSkillPath('nlq', 'has\0null.md')).toThrow(/invalid filename/);
  });
});
