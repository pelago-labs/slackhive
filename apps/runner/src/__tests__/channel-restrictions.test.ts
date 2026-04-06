/**
 * @fileoverview Unit tests for isChannelRestricted in slack-handler.ts.
 *
 * Pure function — no mocks needed.
 *
 * @module runner/__tests__/channel-restrictions.test
 */

import { describe, it, expect } from 'vitest';
import { isChannelRestricted } from '../slack-handler';
import type { Restriction } from '@slackhive/shared';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRestriction(allowedChannels: string[]): Restriction {
  return {
    id: 'r-001',
    agentId: 'a-001',
    allowedChannels,
    updatedAt: new Date(),
  };
}

// ─── isChannelRestricted ──────────────────────────────────────────────────────

describe('isChannelRestricted', () => {
  it('returns false when restrictions is null', () => {
    expect(isChannelRestricted('C_ANY', null)).toBe(false);
  });

  it('returns false when allowedChannels is empty (unrestricted)', () => {
    expect(isChannelRestricted('C_ANY', makeRestriction([]))).toBe(false);
  });

  it('returns false when channel is in the allowedChannels list', () => {
    const r = makeRestriction(['C_ALLOWED', 'C_OTHER']);
    expect(isChannelRestricted('C_ALLOWED', r)).toBe(false);
  });

  it('returns true when channel is NOT in the allowedChannels list', () => {
    const r = makeRestriction(['C_ALLOWED']);
    expect(isChannelRestricted('C_BLOCKED', r)).toBe(true);
  });

  it('returns true for a DM channel not in the allowedChannels list', () => {
    const r = makeRestriction(['C_ALLOWED']);
    expect(isChannelRestricted('D_DM_CHANNEL', r)).toBe(true);
  });

  it('returns false for a DM channel that is explicitly in the allowedChannels list', () => {
    const r = makeRestriction(['D_DM_CHANNEL', 'C_ALLOWED']);
    expect(isChannelRestricted('D_DM_CHANNEL', r)).toBe(false);
  });

  it('is case-sensitive — does not match wrong case', () => {
    const r = makeRestriction(['C_abc123']);
    expect(isChannelRestricted('C_ABC123', r)).toBe(true);
  });

  it('handles a single-channel allowlist correctly — allowed', () => {
    const r = makeRestriction(['C_ONLY']);
    expect(isChannelRestricted('C_ONLY', r)).toBe(false);
  });

  it('handles a single-channel allowlist correctly — blocked', () => {
    const r = makeRestriction(['C_ONLY']);
    expect(isChannelRestricted('C_OTHER', r)).toBe(true);
  });

  it('returns false when allowedChannels has many entries and channel matches one', () => {
    const channels = ['C_1', 'C_2', 'C_3', 'C_4', 'C_5'];
    const r = makeRestriction(channels);
    expect(isChannelRestricted('C_3', r)).toBe(false);
  });
});
