/**
 * @fileoverview Unit tests for skill-templates.ts — SKILL_TEMPLATES.
 *
 * Verifies each template generates the correct skill files with expected
 * content, structure, and agent name/persona interpolation.
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
    isBoss: false,
    reportsTo: [],
    claudeMd: '',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Common assertions ────────────────────────────────────────────────────────

function expectValidSkills(skills: ReturnType<typeof SKILL_TEMPLATES['blank']>) {
  expect(skills.length).toBeGreaterThan(0);
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
  it('returns exactly one skill file', () => {
    const skills = SKILL_TEMPLATES.blank(makeAgent());
    expect(skills).toHaveLength(1);
  });

  it('interpolates agent name into the skill heading', () => {
    const skills = SKILL_TEMPLATES.blank(makeAgent({ name: 'MyBot' }));
    expect(skills[0].content).toContain('# MyBot');
  });

  it('uses agent persona when provided', () => {
    const skills = SKILL_TEMPLATES.blank(makeAgent({ persona: 'A grumpy assistant.' }));
    expect(skills[0].content).toContain('A grumpy assistant.');
  });

  it('generates default persona when persona is undefined', () => {
    const skills = SKILL_TEMPLATES.blank(makeAgent({ name: 'MyBot', persona: undefined }));
    expect(skills[0].content).toContain('You are MyBot');
  });

  it('includes description when provided', () => {
    const skills = SKILL_TEMPLATES.blank(makeAgent({ description: 'Handles billing queries.' }));
    expect(skills[0].content).toContain('Handles billing queries.');
  });

  it('omits description section when description is undefined', () => {
    const skills = SKILL_TEMPLATES.blank(makeAgent({ description: undefined }));
    expect(skills[0].content).not.toContain('## What you do');
  });

  it('produces a valid skill structure', () => {
    expectValidSkills(SKILL_TEMPLATES.blank(makeAgent()));
  });
});

// ─── data-analyst template ────────────────────────────────────────────────────

describe('SKILL_TEMPLATES.data-analyst', () => {
  it('returns 3 skill files', () => {
    expect(SKILL_TEMPLATES['data-analyst'](makeAgent())).toHaveLength(3);
  });

  it('interpolates agent name in identity skill', () => {
    const skills = SKILL_TEMPLATES['data-analyst'](makeAgent({ name: 'DataBot' }));
    const identity = skills.find(s => s.filename === 'identity.md')!;
    expect(identity.content).toContain('# DataBot');
  });

  it('uses agent persona when provided', () => {
    const skills = SKILL_TEMPLATES['data-analyst'](makeAgent({ persona: 'Expert SQL analyst.' }));
    const identity = skills.find(s => s.filename === 'identity.md')!;
    expect(identity.content).toContain('Expert SQL analyst.');
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
  it('returns 2 skill files', () => {
    expect(SKILL_TEMPLATES.writer(makeAgent())).toHaveLength(2);
  });

  it('interpolates agent name in identity skill', () => {
    const skills = SKILL_TEMPLATES.writer(makeAgent({ name: 'WriterBot' }));
    const identity = skills.find(s => s.filename === 'identity.md')!;
    expect(identity.content).toContain('# WriterBot');
  });

  it('includes style-guide.md with writing guidelines', () => {
    const skills = SKILL_TEMPLATES.writer(makeAgent());
    const guide = skills.find(s => s.filename === 'style-guide.md')!;
    expect(guide).toBeDefined();
    expect(guide.content).toContain('Active voice');
  });

  it('has unique sort orders', () => {
    expectUniqueSortOrders(SKILL_TEMPLATES.writer(makeAgent()));
  });

  it('produces valid skill structures', () => {
    expectValidSkills(SKILL_TEMPLATES.writer(makeAgent()));
  });
});

// ─── developer template ───────────────────────────────────────────────────────

describe('SKILL_TEMPLATES.developer', () => {
  it('returns 2 skill files', () => {
    expect(SKILL_TEMPLATES.developer(makeAgent())).toHaveLength(2);
  });

  it('interpolates agent name in identity skill', () => {
    const skills = SKILL_TEMPLATES.developer(makeAgent({ name: 'DevBot' }));
    const identity = skills.find(s => s.filename === 'identity.md')!;
    expect(identity.content).toContain('# DevBot');
  });

  it('includes code-standards.md with security mention', () => {
    const skills = SKILL_TEMPLATES.developer(makeAgent());
    const standards = skills.find(s => s.filename === 'code-standards.md')!;
    expect(standards).toBeDefined();
    expect(standards.content).toContain('security');
  });

  it('has unique sort orders', () => {
    expectUniqueSortOrders(SKILL_TEMPLATES.developer(makeAgent()));
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

  it('all templates include an identity.md file', () => {
    const agent = makeAgent();
    for (const name of templateNames) {
      const skills = SKILL_TEMPLATES[name](agent);
      expect(skills.find(s => s.filename === 'identity.md')).toBeDefined();
    }
  });

  it('all identity.md files start with the agent name as heading', () => {
    const agent = makeAgent({ name: 'SpecialAgent' });
    for (const name of templateNames) {
      const skills = SKILL_TEMPLATES[name](agent);
      const identity = skills.find(s => s.filename === 'identity.md')!;
      expect(identity.content).toContain('# SpecialAgent');
    }
  });
});
