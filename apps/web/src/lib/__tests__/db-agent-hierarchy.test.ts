/**
 * @fileoverview Unit tests for agent hierarchy / enabled fields in db.ts.
 *
 * Covers:
 *  - updateAgentEnabled sets the enabled column correctly
 *  - updateAgent supports isBoss and reportsTo fields
 *  - rowToAgent maps the enabled column (defaults true when missing)
 *
 * No real database required — pg.Pool is mocked via vi.mock.
 *
 * @module web/lib/__tests__/db-agent-hierarchy.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock pg ──────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ query: mockQuery })),
}));

process.env.DATABASE_URL = 'postgresql://mock/db';
process.env.ENV_SECRET_KEY = 'test-secret-key-32-chars-padding!';

import { updateAgentEnabled, updateAgent, getAgentById } from '@/lib/db';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AGENT_ID = 'agent-uuid-001';

const BASE_ROW = {
  id: AGENT_ID,
  slug: 'test-agent',
  name: 'Test Agent',
  persona: null,
  description: null,
  slack_bot_token: 'xoxb-test',
  slack_app_token: 'xapp-test',
  slack_signing_secret: 'secret',
  slack_bot_user_id: null,
  model: 'claude-sonnet-4-6',
  status: 'stopped',
  enabled: true,
  is_boss: false,
  reports_to: [],
  claude_md: '',
  created_by: 'system',
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

// ─── updateAgentEnabled ────────────────────────────────────────────────────────

describe('updateAgentEnabled', () => {
  it('sets enabled = true', async () => {
    await updateAgentEnabled(AGENT_ID, true);
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('enabled = $1');
    expect(params).toEqual([true, AGENT_ID]);
  });

  it('sets enabled = false', async () => {
    await updateAgentEnabled(AGENT_ID, false);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe(false);
  });
});

// ─── updateAgent — isBoss + reportsTo ─────────────────────────────────────────

describe('updateAgent — hierarchy fields', () => {
  beforeEach(() => {
    mockQuery.mockResolvedValue({ rows: [BASE_ROW] });
  });

  it('includes is_boss when isBoss is provided', async () => {
    await updateAgent(AGENT_ID, { isBoss: true });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('is_boss =');
    expect(params).toContain(true);
  });

  it('includes reports_to when reportsTo is provided', async () => {
    const bosses = ['boss-uuid-1', 'boss-uuid-2'];
    await updateAgent(AGENT_ID, { reportsTo: bosses });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('reports_to =');
    expect(params).toContain(bosses);
  });

  it('sets both isBoss and reportsTo together', async () => {
    await updateAgent(AGENT_ID, { isBoss: false, reportsTo: ['boss-uuid-1'] });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('is_boss =');
    expect(sql).toContain('reports_to =');
    expect(params).toContain(false);
    expect(params).toContainEqual(['boss-uuid-1']);
  });

  it('does not include is_boss when isBoss is omitted', async () => {
    await updateAgent(AGENT_ID, { name: 'New Name' });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('is_boss');
  });
});

// ─── rowToAgent — enabled field mapping ───────────────────────────────────────

describe('getAgentById — enabled field', () => {
  it('maps enabled = true from DB row', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...BASE_ROW, enabled: true }] });
    const agent = await getAgentById(AGENT_ID);
    expect(agent?.enabled).toBe(true);
  });

  it('maps enabled = false from DB row', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...BASE_ROW, enabled: false }] });
    const agent = await getAgentById(AGENT_ID);
    expect(agent?.enabled).toBe(false);
  });

  it('defaults enabled to true when column is null/undefined', async () => {
    const { enabled: _omit, ...rowWithoutEnabled } = BASE_ROW;
    mockQuery.mockResolvedValue({ rows: [rowWithoutEnabled] });
    const agent = await getAgentById(AGENT_ID);
    expect(agent?.enabled).toBe(true);
  });
});
