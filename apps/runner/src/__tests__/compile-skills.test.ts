import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Skill } from '@slackhive/shared';
import { writeSkillsTree, writeAgentsSkills } from '../compile-instructions';

const skill = (category: string, filename: string, content: string, description: string | null = null): Skill =>
  ({ id: `${category}-${filename}`, agentId: 'a', category, filename, content, description, sortOrder: 0, createdAt: new Date(), updatedAt: new Date() } as Skill);

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('writeSkillsTree — path-addressable skills/<category>/<filename>.md (Codex)', () => {
  it('writes each skill at the exact category/filename path the instructions reference', () => {
    writeSkillsTree(dir, [
      skill('04-daily-dashboard', 'dashboard.md', '# Dashboard\nsteps'),
      skill('02-sql-patterns', 'sql-rules.md', '# SQL rules'),
    ], null);
    expect(fs.readFileSync(path.join(dir, 'skills/04-daily-dashboard/dashboard.md'), 'utf8')).toContain('# Dashboard');
    expect(fs.readFileSync(path.join(dir, 'skills/02-sql-patterns/sql-rules.md'), 'utf8')).toBe('# SQL rules');
  });

  it('appends .md when the filename lacks it, and includes the wiki skill when present', () => {
    writeSkillsTree(dir, [skill('00-core', 'workflow', 'body')], 'WIKI BODY');
    expect(fs.existsSync(path.join(dir, 'skills/00-core/workflow.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'skills/wiki.md'), 'utf8')).toBe('WIKI BODY');
  });

  it('rewrites cleanly — removes skills deleted since the last compile', () => {
    writeSkillsTree(dir, [skill('00-core', 'old.md', 'x')], null);
    expect(fs.existsSync(path.join(dir, 'skills/00-core/old.md'))).toBe(true);
    writeSkillsTree(dir, [skill('00-core', 'new.md', 'y')], null);
    expect(fs.existsSync(path.join(dir, 'skills/00-core/old.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'skills/00-core/new.md'))).toBe(true);
  });
});

describe('writeAgentsSkills — Codex Agent Skills (.agents/skills/<name>/SKILL.md)', () => {
  it('emits a SKILL.md per skill with name + description frontmatter', () => {
    writeAgentsSkills(dir, [skill('03-business-metrics', 'term-resolution.md', 'resolve terms', 'Resolve business metric terms like GMV')], null);
    const md = fs.readFileSync(path.join(dir, '.agents/skills/term-resolution/SKILL.md'), 'utf8');
    expect(md).toMatch(/^---\nname: term-resolution\ndescription: "Resolve business metric terms like GMV"\n---/);
    expect(md).toContain('resolve terms');
  });

  it('falls back to the first content line when description is null', () => {
    writeAgentsSkills(dir, [skill('00-core', 'workflow.md', '# Workflow guide\nstep 1', null)], null);
    const md = fs.readFileSync(path.join(dir, '.agents/skills/workflow/SKILL.md'), 'utf8');
    expect(md).toContain('description: "Workflow guide"');
  });
});
