import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB setting lookup so we can flip the active backend per-test.
const getSetting = vi.fn();
vi.mock('../db', () => ({ getSetting: (...a: unknown[]) => getSetting(...a) }));
vi.mock('../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../backends/claude-backend', () => ({ ClaudeBackend: { refreshOAuthToken: vi.fn() } }));

// Stub both SDKs — they're ESM-only / native and must never load in unit tests.
const run = vi.fn();
const startThread = vi.fn(() => ({ run }));
vi.mock('@openai/codex-sdk', () => ({ Codex: vi.fn(function () { return { startThread }; }) }));

const query = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...a: unknown[]) => query(...a) }));

async function* claudeResult(text: string) {
  yield { type: 'result', result: text } as never;
}

import { generateText } from '../backends/generate-text';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateText — backend dispatch', () => {
  it('routes to Codex when the active backend is codex, prepending systemPrompt', async () => {
    getSetting.mockImplementation((k: string) =>
      k === 'agentBackend' ? 'codex' : 'gpt-5.4');
    run.mockResolvedValue({ finalResponse: 'codex says hi' });

    const out = await generateText('the user prompt', { systemPrompt: 'SYS' });

    expect(out).toBe('codex says hi');
    expect(query).not.toHaveBeenCalled();
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxMode: 'read-only', approvalPolicy: 'never', model: 'gpt-5.4' }),
    );
    expect(run).toHaveBeenCalledWith('SYS\n\nthe user prompt');
  });

  it('falls back to the default Codex model when the stored model is a Claude id', async () => {
    getSetting.mockImplementation((k: string) =>
      k === 'agentBackend' ? 'codex' : 'claude-sonnet-4-6');
    run.mockResolvedValue({ finalResponse: 'ok' });

    await generateText('p');

    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.not.stringMatching(/^claude/i) }),
    );
  });

  it('routes to Claude when the active backend is claude', async () => {
    getSetting.mockResolvedValue('claude');
    query.mockReturnValue(claudeResult('claude says hi'));

    const out = await generateText('p', { claudeModel: 'claude-sonnet-4-6' });

    expect(out).toBe('claude says hi');
    expect(startThread).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'p',
      options: expect.objectContaining({ model: 'claude-sonnet-4-6', maxTurns: 1 }),
    }));
  });

  it('defaults to the claude path when no backend setting is stored', async () => {
    getSetting.mockResolvedValue(undefined);
    query.mockReturnValue(claudeResult('default'));

    await generateText('p');

    expect(query).toHaveBeenCalled();
    expect(startThread).not.toHaveBeenCalled();
  });
});
