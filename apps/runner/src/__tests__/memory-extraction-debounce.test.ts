/**
 * @fileoverview Unit tests for the end-of-conversation reflection DEBOUNCE.
 *
 * scheduleExtraction arms a per-thread timer so the agent reflects ONCE after a
 * conversation goes quiet, not on every turn. These tests pin that contract with
 * fake timers (runExtraction is stubbed — the extraction body has its own suite):
 *   - fires exactly once after the quiet window;
 *   - each new turn RE-ARMS (resets) the timer, so a busy thread reflects once, late;
 *   - distinct threads debounce independently, each with its own (channel, thread);
 *   - MEMORY_EXTRACTION_DEBOUNCE_MS overrides the 5-min default (so tests/ops can tune it).
 *
 * @module runner/__tests__/memory-extraction-debounce.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentBackend, PlatformAdapter, Restriction } from '@slackhive/shared';
import { MessageHandler } from '../message-handler';

const AGENT = { id: 'agent-1', slug: 'agent-1', name: 'A', model: 'claude-sonnet-4-6' } as unknown as Agent;

function makeHandler() {
  const adapter = {} as unknown as PlatformAdapter;
  const backend = {} as unknown as AgentBackend;
  const handler = new MessageHandler(adapter, backend, AGENT, null as unknown as Restriction | null);
  // Stub the reflection body — we're only asserting the timer/keying contract.
  const run = vi
    .spyOn(handler as unknown as { runExtraction: () => Promise<void> }, 'runExtraction')
    .mockResolvedValue(undefined);
  // scheduleExtraction is private; reach it through a typed cast.
  const schedule = (channelId: string, threadId: string) =>
    (handler as unknown as { scheduleExtraction: (c: string, t: string) => void }).scheduleExtraction(channelId, threadId);
  return { handler, run, schedule };
}

const OLD_ENV = process.env.MEMORY_EXTRACTION_DEBOUNCE_MS;

beforeEach(() => {
  vi.useFakeTimers();
  process.env.MEMORY_EXTRACTION_DEBOUNCE_MS = '1000';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (OLD_ENV === undefined) delete process.env.MEMORY_EXTRACTION_DEBOUNCE_MS;
  else process.env.MEMORY_EXTRACTION_DEBOUNCE_MS = OLD_ENV;
});

describe('scheduleExtraction debounce', () => {
  it('fires runExtraction exactly once after the quiet window', () => {
    const { run, schedule } = makeHandler();
    schedule('C', 'T');
    expect(run).not.toHaveBeenCalled();       // nothing before the window elapses
    vi.advanceTimersByTime(999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('C', 'T');
  });

  it('re-arms on each turn — a busy thread reflects once, after it finally goes quiet', () => {
    const { run, schedule } = makeHandler();
    schedule('C', 'T');
    vi.advanceTimersByTime(700);
    schedule('C', 'T');                        // new turn resets the timer
    vi.advanceTimersByTime(700);               // 1400ms since first, but only 700 since reset
    expect(run).not.toHaveBeenCalled();        // reset means it hasn't fired yet
    schedule('C', 'T');                        // another turn
    vi.advanceTimersByTime(999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);      // exactly one reflection for the whole thread
  });

  it('debounces distinct threads independently', () => {
    const { run, schedule } = makeHandler();
    schedule('C', 'T1');
    schedule('C', 'T2');
    schedule('C2', 'T1');                       // same thread id, different channel → distinct key
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledWith('C', 'T1');
    expect(run).toHaveBeenCalledWith('C', 'T2');
    expect(run).toHaveBeenCalledWith('C2', 'T1');
  });

  it('honors the MEMORY_EXTRACTION_DEBOUNCE_MS override', () => {
    process.env.MEMORY_EXTRACTION_DEBOUNCE_MS = '5000';
    const { run, schedule } = makeHandler();
    schedule('C', 'T');
    vi.advanceTimersByTime(1000);              // would have fired under the 1s default
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
