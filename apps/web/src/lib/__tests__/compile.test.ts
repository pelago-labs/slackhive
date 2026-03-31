/**
 * @fileoverview Unit tests for compile.ts — compileSkillsOnly and skillToSnapshotSkill.
 *
 * All tests use inline mock data; no database connection required.
 *
 * @module web/lib/__tests__/compile.test
 */

import { describe, it, expect } from 'vitest';
import { compileSkillsOnly, skillToSnapshotSkill } from '@/lib/compile';
import type { Skill } from '@slackhive/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal {@link Skill} object for testing purposes.
 *
 * @param {Partial<Skill>} overrides - Fields to override from defaults.
 * @returns {Skill}
 */
function makeSkill(overrides: Partial<Skill>): Skill {
  return {
    id: 'skill-id',
    agentId: 'agent-id',
    category: '00-core',
    filename: 'main.md',
    content: '# Main',
    sortOrder: 0,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// compileSkillsOnly
// ---------------------------------------------------------------------------

describe('compileSkillsOnly', () => {
  it('returns empty string for empty skills array with no fallback', () => {
    expect(compileSkillsOnly([])).toBe('');
  });

  it('returns identity block for empty skills array with fallback', () => {
    const result = compileSkillsOnly([], {
      name: 'TestBot',
      description: 'A test bot',
      persona: 'Friendly helper',
    });
    expect(result).toContain('# TestBot');
    expect(result).toContain('A test bot');
    expect(result).toContain('Friendly helper');
  });

  it('returns identity block using default persona when persona is undefined', () => {
    const result = compileSkillsOnly([], { name: 'TestBot', description: 'Desc' });
    expect(result).toContain('A helpful assistant.');
  });

  it('returns trimmed content for a single skill', () => {
    const skill = makeSkill({ content: '  # Identity\n\nHello world  ' });
    const result = compileSkillsOnly([skill]);
    expect(result).toBe('# Identity\n\nHello world');
  });

  it('joins multiple skills with double newline sorted by sortOrder', () => {
    const skills = [
      makeSkill({ sortOrder: 2, content: 'Third' }),
      makeSkill({ sortOrder: 0, content: 'First' }),
      makeSkill({ sortOrder: 1, content: 'Second' }),
    ];
    const result = compileSkillsOnly(skills);
    expect(result).toBe('First\n\nSecond\n\nThird');
  });

  it('strips <!-- skill:... --> header comments from output', () => {
    const skill = makeSkill({
      content: '<!-- skill:identity -->\n# Identity\n\nContent here',
    });
    const result = compileSkillsOnly([skill]);
    expect(result).not.toContain('<!-- skill:identity -->');
    expect(result).toContain('# Identity');
  });

  it('correctly sorts skills passed out of order', () => {
    const skills = [
      makeSkill({ sortOrder: 10, content: 'Last' }),
      makeSkill({ sortOrder: 1, content: 'First' }),
      makeSkill({ sortOrder: 5, content: 'Middle' }),
    ];
    const result = compileSkillsOnly(skills);
    const parts = result.split('\n\n');
    expect(parts[0]).toBe('First');
    expect(parts[1]).toBe('Middle');
    expect(parts[2]).toBe('Last');
  });
});

// ---------------------------------------------------------------------------
// skillToSnapshotSkill
// ---------------------------------------------------------------------------

describe('skillToSnapshotSkill', () => {
  it('maps category, filename, content, and sortOrder -> sort_order correctly', () => {
    const skill = makeSkill({
      category: '01-knowledge',
      filename: 'schema.md',
      content: '## Schema\n\nDetails',
      sortOrder: 42,
    });
    const snapshot = skillToSnapshotSkill(skill);
    expect(snapshot.category).toBe('01-knowledge');
    expect(snapshot.filename).toBe('schema.md');
    expect(snapshot.content).toBe('## Schema\n\nDetails');
    expect(snapshot.sort_order).toBe(42);
  });

  it('does not include id or agentId in the result', () => {
    const skill = makeSkill({ id: 'some-uuid', agentId: 'agent-uuid' });
    const snapshot = skillToSnapshotSkill(skill);
    expect(snapshot).not.toHaveProperty('id');
    expect(snapshot).not.toHaveProperty('agentId');
  });
});
