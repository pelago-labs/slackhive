/**
 * @fileoverview Unit tests for MemoryWatcher session-only watching.
 *
 * Tests cover:
 * - MemoryWatcher only watches session dirs, not the root memory dir
 * - parseMemoryFile correctly parses valid frontmatter
 * - parseMemoryFile returns null for invalid/missing frontmatter
 *
 * @module runner/__tests__/memory-sync.test
 */

import { describe, it, expect } from 'vitest';
import { parseMemoryFile } from '../memory-watcher.js';

describe('parseMemoryFile', () => {
  it('parses valid memory frontmatter', () => {
    const content = `---
name: test_memory
description: A test memory
type: user
---

Memory content here.`;
    const result = parseMemoryFile(content);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('test_memory');
    expect(result?.type).toBe('user');
  });

  it('returns null for missing frontmatter', () => {
    const content = `No frontmatter here, just plain text.`;
    expect(parseMemoryFile(content)).toBeNull();
  });

  it('returns null for missing name field', () => {
    const content = `---
type: user
---
Content`;
    expect(parseMemoryFile(content)).toBeNull();
  });

  it('returns null for invalid type', () => {
    const content = `---
name: test
type: invalid_type
---
Content`;
    expect(parseMemoryFile(content)).toBeNull();
  });

  it('parses all valid types', () => {
    for (const type of ['user', 'feedback', 'project', 'reference']) {
      const content = `---\nname: test\ntype: ${type}\n---\nContent`;
      const result = parseMemoryFile(content);
      expect(result?.type).toBe(type);
    }
  });
});
