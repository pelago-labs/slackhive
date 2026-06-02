import { describe, it, expect } from 'vitest';
import type { Agent } from '@slackhive/shared';
import { createAgentBackend } from '../backends';

const agent = (slug: string): Agent =>
  ({ id: `id-${slug}`, slug, name: slug, model: 'claude-opus-4-6' } as unknown as Agent);

describe('backends factory / createAgentBackend', () => {
  it('returns a CodexBackend for "codex"', () => {
    const b = createAgentBackend('codex', agent('a'), [], null, '/tmp/agents/a', {});
    expect(b.backend).toBe('codex');
  });

  it('returns a ClaudeBackend for "claude"', () => {
    const b = createAgentBackend('claude', agent('b'), [], null, '/tmp/agents/b', {});
    expect(b.backend).toBe('claude');
  });

  it('falls back to Claude for an unknown/empty backend id (never takes the hive down)', () => {
    expect(createAgentBackend('', agent('c'), [], null, '/tmp/agents/c', {}).backend).toBe('claude');
    expect(createAgentBackend('hermes', agent('d'), [], null, '/tmp/agents/d', {}).backend).toBe('claude');
  });

  it('exposes the full AgentBackend surface on each backend', () => {
    for (const id of ['claude', 'codex']) {
      const b = createAgentBackend(id, agent(`e-${id}`), [], null, `/tmp/agents/e-${id}`, {});
      expect(typeof b.initialize).toBe('function');
      expect(typeof b.destroy).toBe('function');
      expect(typeof b.getSessionKey).toBe('function');
      expect(typeof b.streamQuery).toBe('function');
      expect(b.getSessionKey('U1', 'C1', '123')).toBe('U1-C1-123');
    }
  });
});
