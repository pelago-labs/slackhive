/**
 * @fileoverview Unit tests for agent restriction functions in db.ts.
 *
 * Verifies getAgentRestrictions and upsertRestrictions issue correct SQL and
 * bind parameters. Uses an injected fake DbAdapter — no real database required.
 *
 * @module web/lib/__tests__/db-restrictions.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDb, type DbAdapter, type DbResult } from '@slackhive/shared';

import { getAgentRestrictions, upsertRestrictions } from '@/lib/db';

// ─── Fake adapter ────────────────────────────────────────────────────────────

const mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<DbResult>>();

const fakeAdapter: DbAdapter = {
  query: mockQuery,
  transaction: async (fn) => fn(fakeAdapter),
  close: async () => {},
  type: 'sqlite',
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'agent-uuid-001';

const RESTRICTION_ROW = {
  id: 'r-001',
  agent_id: AGENT_ID,
  allowed_channels: ['C_ABC', 'C_DEF'],
  updated_at: new Date('2026-01-01'),
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  setDb(fakeAdapter);
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
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getAgentRestrictions(AGENT_ID);
    expect(result).toBeNull();
  });

  it('maps row to Restriction with correct fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [RESTRICTION_ROW], rowCount: 1 });
    const result = await getAgentRestrictions(AGENT_ID);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('r-001');
    expect(result!.agentId).toBe(AGENT_ID);
    expect(result!.allowedChannels).toEqual(['C_ABC', 'C_DEF']);
    expect(result!.updatedAt).toEqual(RESTRICTION_ROW.updated_at);
  });

  it('defaults allowedChannels to [] when column is null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...RESTRICTION_ROW, allowed_channels: null }],
      rowCount: 1,
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

  it('binds [generatedId, agentId, allowedChannels] in that order', async () => {
    const channels = ['C_1', 'C_2', 'C_3'];
    await upsertRestrictions(AGENT_ID, channels);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toHaveLength(3);
    expect(typeof params![0]).toBe('string');
    expect(params![1]).toBe(AGENT_ID);
    expect(params![2]).toEqual(channels);
  });

  it('accepts an empty allowedChannels array (unrestricted)', async () => {
    await upsertRestrictions(AGENT_ID, []);
    const [, params] = mockQuery.mock.calls[0];
    expect(params![2]).toEqual([]);
  });

  it('updates allowed_channels in the SET clause', async () => {
    await upsertRestrictions(AGENT_ID, ['C_NEW']);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('allowed_channels');
  });
});
