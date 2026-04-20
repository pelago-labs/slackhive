/**
 * @fileoverview Unit tests for agent hierarchy / enabled fields in db.ts.
 *
 * Covers:
 *  - updateAgentEnabled sets the enabled column correctly
 *  - updateAgent supports isBoss and reportsTo fields
 *  - rowToAgent maps the enabled column (defaults true when missing)
 *
 * Uses an injected fake DbAdapter — no real database required.
 *
 * @module web/lib/__tests__/db-agent-hierarchy.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDb, type DbAdapter, type DbResult } from '@slackhive/shared';

import { updateAgentEnabled, updateAgent, getAgentById } from '@/lib/db';

// ─── Fake adapter ─────────────────────────────────────────────────────────────

const mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<DbResult>>();

const fakeAdapter: DbAdapter = {
  query: mockQuery,
  transaction: async (fn) => fn(fakeAdapter),
  close: async () => {},
  type: 'sqlite',
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'agent-uuid-001';

const BASE_ROW = {
  id: AGENT_ID,
  slug: 'test-agent',
  name: 'Test Agent',
  persona: null,
  description: null,
  model: 'claude-sonnet-4-6',
  status: 'stopped',
  enabled: true,
  is_boss: false,
  reports_to: [],
  claude_md: '',
  verbose: 1,
  created_by: 'system',
  created_at: new Date(),
  updated_at: new Date(),
};

/** Query against `platform_integrations` — we return no rows so enrichment is a no-op. */
function isPlatformIntegrationsQuery(sql: string) {
  return sql.includes('platform_integrations');
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  setDb(fakeAdapter);
});

// ─── updateAgentEnabled ───────────────────────────────────────────────────────

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
    expect(params![0]).toBe(false);
  });
});

// ─── updateAgent — isBoss + reportsTo ─────────────────────────────────────────

describe('updateAgent — hierarchy fields', () => {
  beforeEach(() => {
    // updateAgent issues one UPDATE and returns the updated row.
    mockQuery.mockResolvedValue({ rows: [BASE_ROW], rowCount: 1 });
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
    mockQuery.mockImplementation(async (sql: string) => {
      if (isPlatformIntegrationsQuery(sql)) return { rows: [], rowCount: 0 };
      return { rows: [{ ...BASE_ROW, enabled: true }], rowCount: 1 };
    });
    const agent = await getAgentById(AGENT_ID);
    expect(agent?.enabled).toBe(true);
  });

  it('maps enabled = false from DB row', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (isPlatformIntegrationsQuery(sql)) return { rows: [], rowCount: 0 };
      return { rows: [{ ...BASE_ROW, enabled: false }], rowCount: 1 };
    });
    const agent = await getAgentById(AGENT_ID);
    expect(agent?.enabled).toBe(false);
  });

  it('defaults enabled to true when column is null/undefined', async () => {
    const { enabled: _omit, ...rowWithoutEnabled } = BASE_ROW;
    mockQuery.mockImplementation(async (sql: string) => {
      if (isPlatformIntegrationsQuery(sql)) return { rows: [], rowCount: 0 };
      return { rows: [rowWithoutEnabled], rowCount: 1 };
    });
    const agent = await getAgentById(AGENT_ID);
    expect(agent?.enabled).toBe(true);
  });
});
