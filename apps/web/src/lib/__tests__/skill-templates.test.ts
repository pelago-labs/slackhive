/**
 * @fileoverview Unit tests for skill-templates.ts — SKILL_TEMPLATES.
 *
 * Verifies each template generates the correct skill files with expected
 * content, structure, and sort ordering. Identity is NOT a skill — it lives
 * on the agent row — so no template should seed `identity.md`.
 *
 * No database or network required.
 *
 * @module web/lib/__tests__/skill-templates.test
 */

import { describe, it, expect } from 'vitest';
import { SKILL_TEMPLATES } from '@/lib/skill-templates';
import type { Agent } from '@slackhive/shared';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    slug: 'test-bot',
    name: 'TestBot',
    persona: undefined,
    description: undefined,
    slackBotToken: 'xoxb-fake',
    slackAppToken: 'xapp-fake',
    slackSigningSecret: 'secret',
    slackBotUserId: undefined,
    model: 'claude-opus-4-5',
    status: 'stopped',
    enabled: true,
    isBoss: false,
    reportsTo: [],
    claudeMd: '',
    verbose: true,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Common assertions ────────────────────────────────────────────────────────

function expectValidSkills(skills: ReturnType<typeof SKILL_TEMPLATES['blank']>) {
  for (const skill of skills) {
    expect(skill.category).toBeTruthy();
    expect(skill.filename).toMatch(/\.md$/);
    expect(skill.content.trim()).toBeTruthy();
    expect(typeof skill.sortOrder).toBe('number');
  }
}

function expectUniqueSortOrders(skills: ReturnType<typeof SKILL_TEMPLATES['blank']>) {
  const orders = skills.map(s => s.sortOrder);
  expect(new Set(orders).size).toBe(orders.length);
}

// ─── blank template ───────────────────────────────────────────────────────────

describe('SKILL_TEMPLATES.blank', () => {
  it('returns no starter skills (identity lives on the agent row)', () => {
    expect(SKILL_TEMPLATES.blank(makeAgent())).toHaveLength(0);
  });
});

// ─── data-analyst template ────────────────────────────────────────────────────

describe('SKILL_TEMPLATES.data-analyst', () => {
  it('returns 2 skill files', () => {
    expect(SKILL_TEMPLATES['data-analyst'](makeAgent())).toHaveLength(2);
  });

  it('includes workflow.md with query execution steps', () => {
    const skills = SKILL_TEMPLATES['data-analyst'](makeAgent());
    const workflow = skills.find(s => s.filename === 'workflow.md')!;
    expect(workflow).toBeDefined();
    expect(workflow.content).toContain('Understand');
    expect(workflow.content).toContain('Execute');
  });

  it('includes response-format.md', () => {
    const skills = SKILL_TEMPLATES['data-analyst'](makeAgent());
    expect(skills.find(s => s.filename === 'response-format.md')).toBeDefined();
  });

  it('skills are in ascending sortOrder', () => {
    const skills = SKILL_TEMPLATES['data-analyst'](makeAgent());
    const orders = skills.map(s => s.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('has unique sort orders', () => {
    expectUniqueSortOrders(SKILL_TEMPLATES['data-analyst'](makeAgent()));
  });

  it('produces valid skill structures', () => {
    expectValidSkills(SKILL_TEMPLATES['data-analyst'](makeAgent()));
  });
});

// ─── writer template ──────────────────────────────────────────────────────────

describe('SKILL_TEMPLATES.writer', () => {
  it('returns 1 skill file', () => {
    expect(SKILL_TEMPLATES.writer(makeAgent())).toHaveLength(1);
  });

  it('includes style-guide.md with writing guidelines', () => {
    const skills = SKILL_TEMPLATES.writer(makeAgent());
    const guide = skills.find(s => s.filename === 'style-guide.md')!;
    expect(guide).toBeDefined();
    expect(guide.content).toContain('Active voice');
  });

  it('produces valid skill structures', () => {
    expectValidSkills(SKILL_TEMPLATES.writer(makeAgent()));
  });
});

// ─── developer template ───────────────────────────────────────────────────────

describe('SKILL_TEMPLATES.developer', () => {
  it('returns 1 skill file', () => {
    expect(SKILL_TEMPLATES.developer(makeAgent())).toHaveLength(1);
  });

  it('includes code-standards.md with security mention', () => {
    const skills = SKILL_TEMPLATES.developer(makeAgent());
    const standards = skills.find(s => s.filename === 'code-standards.md')!;
    expect(standards).toBeDefined();
    expect(standards.content).toContain('security');
  });

  it('produces valid skill structures', () => {
    expectValidSkills(SKILL_TEMPLATES.developer(makeAgent()));
  });
});

// ─── All templates ────────────────────────────────────────────────────────────

describe('SKILL_TEMPLATES (all)', () => {
  const templateNames = ['blank', 'data-analyst', 'writer', 'developer'] as const;

  it('all templates are defined', () => {
    for (const name of templateNames) {
      expect(SKILL_TEMPLATES[name]).toBeTypeOf('function');
    }
  });

  it('all templates produce skills in 00-core category', () => {
    const agent = makeAgent();
    for (const name of templateNames) {
      const skills = SKILL_TEMPLATES[name](agent);
      expect(skills.every(s => s.category === '00-core')).toBe(true);
    }
  });

  it('no template seeds identity.md (identity lives on the agent row)', () => {
    const agent = makeAgent();
    for (const name of templateNames) {
      const skills = SKILL_TEMPLATES[name](agent);
      expect(skills.find(s => s.filename === 'identity.md')).toBeUndefined();
    }
  });
});
