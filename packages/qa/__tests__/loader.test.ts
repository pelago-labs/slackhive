import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent, loadCorpus } from '../src';

const GOOD_AGENT = resolve(__dirname, 'fixtures/good-agent');

describe('loadAgent', () => {
  it('loads a minimal valid agent end-to-end', () => {
    const { config, corpus } = loadAgent(GOOD_AGENT);

    expect(config.dir).toBe(GOOD_AGENT);
    expect(config.claudeMd.raw).toContain('Test Agent');
    expect(config.claudeMd.triggers).toContain('hello world');
    expect(config.claudeMd.mcpReferences).toContain('mcp__notion__notion-fetch');
    expect(config.claudeMd.skillReferences).toContain('skills/test-skill.md');
    expect(config.claudeMd.wikiReferences).toContain('wiki/test-entity.md');

    expect(config.skills).toHaveLength(1);
    expect(config.skills[0].name).toBe('test-skill');
    expect(config.skills[0].path).toBe('test-skill.md');
    expect(config.skills[0].description).toContain('test skill');

    expect(config.wikiEntities).toContain('test-entity.md');
    expect(config.mcps).toEqual(['notion']);

    expect(corpus).not.toBeNull();
    expect(corpus!.checks).toHaveLength(1);
    expect(corpus!.checks[0].primitive).toBe('substring');
    expect(corpus!.fileMtime).toBeGreaterThan(0);
  });

  it('filters cases by status=approved by default', () => {
    const { corpus } = loadAgent(GOOD_AGENT);
    expect(corpus!.cases).toHaveLength(1);
    expect(corpus!.cases[0].id).toBe('T001');
  });

  it('returns both approved and proposed when includeProposed=true', () => {
    const { corpus } = loadAgent(GOOD_AGENT, { includeProposed: true });
    expect(corpus!.cases).toHaveLength(2);
    expect(corpus!.cases.map((c) => c.id).sort()).toEqual(['T001', 'T002']);
  });

  it('throws on missing agent directory', () => {
    expect(() => loadAgent('/does/not/exist/ever')).toThrow(/does not exist/);
  });
});

describe('loadCorpus', () => {
  it('records mtime for immutability checks', () => {
    const corpus = loadCorpus(GOOD_AGENT);
    expect(corpus).not.toBeNull();
    expect(corpus!.fileMtime).toBeGreaterThan(0);
  });

  it('returns null when no eval/tests.yaml exists', () => {
    // The good-agent fixture has tests.yaml, so we synthesize a non-corpus dir
    // by passing the fixtures root, which has no eval/tests.yaml of its own
    const result = loadCorpus(resolve(__dirname, 'fixtures'));
    expect(result).toBeNull();
  });
});
