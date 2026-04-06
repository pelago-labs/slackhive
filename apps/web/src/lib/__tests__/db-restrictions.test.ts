/**
 * @fileoverview Unit tests for agent restriction functions in db.ts.
 *
 * Verifies that getAgentRestrictions and upsertRestrictions issue correct SQL.
 * No real database required — pg.Pool is mocked via vi.mock.
 *
 * @module web/lib/__tests__/db-restrictions.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock pg ─────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ query: mockQuery })),
}));

process.env.DATABASE_URL = 'postgresql://mock/db';
process.env.ENV_SECRET_KEY = 'test-secret-key-32-chars-padding!';

import { getAgentRestrictions, upsertRestrictions } from '@/lib/db';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AGENT_ID = 'agent-uuid-001';

const RESTRICTION_ROW = {
  id: 'r-001',
  agent_id: AGENT_ID,
  allowed_channels: ['C_ABC', 'C_DEF'],
  updated_at: new Date('2026-01-01'),
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

// ─── getAgentRestrictions ────────────────────────────────────────────────────

describe('getAgentRestrictions', () => {
  it('queries agent_restrictions by agent_id', async () => {
    await getAgentRestrictions(AGENT_ID);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('agent_restrictions');
    expect(sql).toContain('agent_id');
  });

  it('passes agentId as query parameter', async () => {
    await getAgentRestrictions(AGENT_ID);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain(AGENT_ID);
  });

  it('returns null when no row found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await getAgentRestrictions(AGENT_ID);
    expect(result).toBeNull();
  });

  it('maps row to Restriction with correct fields', async () => {
    mockQuery.mockResolvedValue({ rows: [RESTRICTION_ROW] });
    const result = await getAgentRestrictions(AGENT_ID);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('r-001');
    expect(result!.agentId).toBe(AGENT_ID);
    expect(result!.allowedChannels).toEqual(['C_ABC', 'C_DEF']);
    expect(result!.updatedAt).toEqual(RESTRICTION_ROW.updated_at);
  });

  it('defaults allowedChannels to [] when column is null', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...RESTRICTION_ROW, allowed_channels: null }],
    });
    const result = await getAgentRestrictions(AGENT_ID);
    expect(result!.allowedChannels).toEqual([]);
  });
});

// ─── upsertRestrictions ──────────────────────────────────────────────────────

describe('upsertRestrictions', () => {
  it('uses INSERT … ON CONFLICT DO UPDATE', async () => {
    await upsertRestrictions(AGENT_ID, ['C_ABC']);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO agent_restrictions/i);
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/DO UPDATE/i);
  });

  it('passes agentId as first parameter', async () => {
    await upsertRestrictions(AGENT_ID, ['C_ABC']);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe(AGENT_ID);
  });

  it('passes allowedChannels array as second parameter', async () => {
    const channels = ['C_1', 'C_2', 'C_3'];
    await upsertRestrictions(AGENT_ID, channels);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toEqual(channels);
  });

  it('accepts an empty allowedChannels array (unrestricted)', async () => {
    await upsertRestrictions(AGENT_ID, []);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toEqual([]);
  });

  it('updates allowed_channels in the SET clause', async () => {
    await upsertRestrictions(AGENT_ID, ['C_NEW']);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('allowed_channels');
  });
});
