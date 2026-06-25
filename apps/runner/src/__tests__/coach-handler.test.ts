/**
 * @fileoverview Unit tests for coach-handler helpers.
 *
 * Focuses on the security-critical path sanitizer. The SDK-driven turn loop is
 * exercised by integration runs rather than unit-mocked here.
 *
 * @module runner/__tests__/coach-handler.test
 */

import { describe, it, expect } from 'vitest';
import { assertSafeSkillPath, resumeSessionFor, resolveCoachBackend } from '../coach-handler';

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

describe('resumeSessionFor', () => {
  it('resumes when the backend is unchanged', () => {
    expect(resumeSessionFor('claude', 'claude', 'sess-1')).toBe('sess-1');
    expect(resumeSessionFor('codex', 'codex', 'thread-9')).toBe('thread-9');
  });

  it('drops the stale id when the backend was switched (the coach-break bug)', () => {
    // Claude session id resumed under Codex → would break; start fresh instead.
    expect(resumeSessionFor('codex', 'claude', 'claude-uuid')).toBeUndefined();
    // …and the reverse.
    expect(resumeSessionFor('claude', 'codex', 'codex-thread')).toBeUndefined();
  });

  it('treats an untagged (pre-fix) session as the default backend', () => {
    // Default backend is 'claude' — a legacy session resumes on claude…
    expect(resumeSessionFor('claude', undefined, 'sess-2')).toBe('sess-2');
    // …but is dropped if the active backend was switched away from the default.
    expect(resumeSessionFor('codex', undefined, 'legacy-claude-uuid')).toBeUndefined();
  });

  it('returns undefined when there is no session id', () => {
    expect(resumeSessionFor('claude', 'codex', undefined)).toBeUndefined();
    expect(resumeSessionFor('claude', 'claude', undefined)).toBeUndefined();
  });
});

describe('resolveCoachBackend', () => {
  it('resolves each registered backend to its own distinct runner', () => {
    const claude = resolveCoachBackend('claude');
    const codex = resolveCoachBackend('codex');
    expect(typeof claude).toBe('function');
    expect(typeof codex).toBe('function');
    expect(claude).not.toBe(codex);
  });

  it('falls back to the default backend for an unknown name (modular/extensible)', () => {
    // A future backend not yet registered must not throw — it degrades to the default.
    expect(resolveCoachBackend('some-future-backend')).toBe(resolveCoachBackend('claude'));
  });
});
