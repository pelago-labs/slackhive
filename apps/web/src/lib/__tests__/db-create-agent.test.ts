/**
 * @fileoverview Unit tests for createAgent default-model behavior in db.ts.
 *
 * Verifies the `req.model ?? DEFAULT_AGENT_MODEL` fallback: an agent created
 * without an explicit `model` must persist the shared default constant, and
 * an explicit model must be passed through unchanged.
 *
 * No real database required — a fake DbAdapter is injected via setDb().
 *
 * @module web/lib/__tests__/db-create-agent.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDb, DEFAULT_AGENT_MODEL, type DbAdapter, type DbResult } from '@slackhive/shared';

import { createAgent } from '@/lib/db';

// ─── Fake adapter ─────────────────────────────────────────────────────────────

const mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<DbResult>>();

const fakeAdapter: DbAdapter = {
  query: mockQuery,
  transaction: async (fn) => fn(fakeAdapter),
  close: async () => {},
  type: 'sqlite',
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_ROW = {
  id: 'agent-uuid-001',
  slug: 'test-agent',
  name: 'Test Agent',
  persona: null,
  description: null,
  model: DEFAULT_AGENT_MODEL,
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

/** Default mock: INSERT returns the row, platform_integrations SELECT is empty. */
function mockInsertThenEmptyPlatform(row: Record<string, unknown> = BASE_ROW) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('platform_integrations')) return { rows: [], rowCount: 0 };
    return { rows: [row], rowCount: 1 };
  });
}

/** Extract the model param (position 6, index 5) from the INSERT call. */
function modelParamFromInsert(): unknown {
  const insertCall = mockQuery.mock.calls.find(c => c[0].includes('INSERT INTO agents'));
  if (!insertCall) throw new Error('createAgent did not issue an INSERT');
  return insertCall[1]![5];
}

beforeEach(() => {
  mockQuery.mockReset();
  setDb(fakeAdapter);
});

describe('createAgent — model fallback', () => {
  it('uses DEFAULT_AGENT_MODEL when req.model is omitted', async () => {
    mockInsertThenEmptyPlatform();

    await createAgent({
      slug: 'no-model',
      name: 'No Model',
    });

    expect(modelParamFromInsert()).toBe(DEFAULT_AGENT_MODEL);
  });

  it('passes through an explicit model unchanged', async () => {
    const explicit = 'claude-haiku-4-5-20251001';
    mockInsertThenEmptyPlatform({ ...BASE_ROW, model: explicit });

    await createAgent({
      slug: 'explicit-model',
      name: 'Explicit Model',
      model: explicit,
    });

    expect(modelParamFromInsert()).toBe(explicit);
  });
});
