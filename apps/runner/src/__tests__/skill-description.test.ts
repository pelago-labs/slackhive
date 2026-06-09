import { describe, it, expect, vi } from 'vitest';
import { fillSkillDescription, type FillSkillDeps, type SkillRow } from '../skill-description';

function makeDeps(overrides: Partial<FillSkillDeps> & { skill?: SkillRow | null } = {}): {
  deps: FillSkillDeps;
  updateSkillDescription: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  summarize: ReturnType<typeof vi.fn>;
} {
  const skill = overrides.skill === undefined
    ? ({ filename: 'analysis-validation.md', content: 'long skill body', description: null } as SkillRow)
    : overrides.skill;
  const summarize = vi.fn(overrides.summarize ?? (async () => 'Use when validating an analysis'));
  const updateSkillDescription = vi.fn(async () => undefined);
  const reload = vi.fn(async () => undefined);
  const deps: FillSkillDeps = {
    getSkillById: vi.fn(async () => skill),
    summarize,
    updateSkillDescription,
    isRunning: overrides.isRunning ?? (() => true),
    reload,
  };
  return { deps, updateSkillDescription, reload, summarize };
}

describe('fillSkillDescription', () => {
  it('summarizes and writes the description even when the agent is STOPPED (the regenerate bug)', async () => {
    const { deps, updateSkillDescription, reload } = makeDeps({ isRunning: () => false });

    const out = await fillSkillDescription(deps, 'agent-1', 'skill-1');

    expect(out).toBe('Use when validating an analysis');
    expect(updateSkillDescription).toHaveBeenCalledWith('skill-1', 'Use when validating an analysis');
    // Stopped agent: description is persisted, but no reload is attempted.
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads the agent when it is running (so the new line lands in instructions)', async () => {
    const { deps, reload } = makeDeps({ isRunning: () => true });

    await fillSkillDescription(deps, 'agent-1', 'skill-1');

    expect(reload).toHaveBeenCalledWith('agent-1');
  });

  it('does nothing when the description is already filled', async () => {
    const { deps, summarize, updateSkillDescription } = makeDeps({
      skill: { filename: 'x.md', content: 'body', description: 'already here' },
    });

    const out = await fillSkillDescription(deps, 'agent-1', 'skill-1');

    expect(out).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
    expect(updateSkillDescription).not.toHaveBeenCalled();
  });

  it('returns null and writes nothing when the skill was deleted', async () => {
    const { deps, updateSkillDescription } = makeDeps({ skill: null });

    const out = await fillSkillDescription(deps, 'agent-1', 'skill-1');

    expect(out).toBeNull();
    expect(updateSkillDescription).not.toHaveBeenCalled();
  });

  it('returns null and does not write when the summarizer fails', async () => {
    const { deps, updateSkillDescription, reload } = makeDeps({ summarize: async () => null });

    const out = await fillSkillDescription(deps, 'agent-1', 'skill-1');

    expect(out).toBeNull();
    expect(updateSkillDescription).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
