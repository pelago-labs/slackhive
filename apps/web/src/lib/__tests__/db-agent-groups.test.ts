/**
 * @fileoverview Tests for the agent-groups DB helpers added by the audiences
 * feature: listAgentEligibleUsers (read path / no-CTE workaround), the SQLite
 * UNIQUE-conflict parser, and setGroupMembers (multi-row insert + dedupe).
 *
 * Uses a fake DbAdapter — no real database required.
 *
 * @module web/lib/__tests__/db-agent-groups.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDb, type DbAdapter, type DbResult } from '@slackhive/shared';
import {
  listAgentEligibleUsers,
  parseAgentGroupsConflict,
  setGroupMembers,
} from '@/lib/db';

const mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<DbResult>>();

const fakeAdapter: DbAdapter = {
  query: mockQuery,
  transaction: async (fn) => fn(fakeAdapter),
  close: async () => {},
  type: 'sqlite',
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  setDb(fakeAdapter);
});

// ─── listAgentEligibleUsers ──────────────────────────────────────────────────

describe('listAgentEligibleUsers', () => {
  it('does NOT use a leading WITH/CTE — adapter routes those through the write path', async () => {
    await listAgentEligibleUsers('agent-1');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(sql.trim().toUpperCase().startsWith('WITH')).toBe(false);
  });

  it('passes the agentId twice (creator + access JOIN)', async () => {
    await listAgentEligibleUsers('agent-1');
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['agent-1', 'agent-1']);
  });

  it('maps source_rank=1 → admin, 2 → creator, 3 → access', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'u-admin',   username: 'admin',   role: 'admin',  top_rank: 1 },
        { id: 'u-creator', username: 'bob',     role: 'editor', top_rank: 2 },
        { id: 'u-access',  username: 'aman',    role: 'viewer', top_rank: 3 },
      ],
      rowCount: 3,
    });
    const result = await listAgentEligibleUsers('agent-1');
    expect(result).toEqual([
      { id: 'u-admin',   username: 'admin',   role: 'admin',  source: 'admin' },
      { id: 'u-creator', username: 'bob',     role: 'editor', source: 'creator' },
      { id: 'u-access',  username: 'aman',    role: 'viewer', source: 'access' },
    ]);
  });

  it('queries the three eligibility sources via UNION ALL', async () => {
    await listAgentEligibleUsers('agent-1');
    const [sql] = mockQuery.mock.calls[0];
    // sources: admins, creator, agent_access — all combined via UNION ALL with
    // a numeric source_rank that's MIN()'d for the strongest label.
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain("u.role IN ('admin', 'superadmin')");
    expect(sql).toContain('a.created_by = u.username');
    expect(sql).toContain('agent_access aa');
    expect(sql).toContain('MIN(source_rank)');
  });
});

// ─── parseAgentGroupsConflict ────────────────────────────────────────────────

describe('parseAgentGroupsConflict', () => {
  it('returns priority field for the priority unique-index error', () => {
    const err = new Error('UNIQUE constraint failed: agent_groups.agent_id, agent_groups.priority');
    expect(parseAgentGroupsConflict(err)).toEqual({
      field: 'priority',
      message: expect.stringContaining('priority'),
    });
  });

  it('returns name field for the name unique-constraint error', () => {
    const err = new Error('UNIQUE constraint failed: agent_groups.agent_id, agent_groups.name');
    expect(parseAgentGroupsConflict(err)).toEqual({
      field: 'name',
      message: expect.stringContaining('name'),
    });
  });

  it('tolerates double-spaces between table.column tokens', () => {
    const err = new Error('UNIQUE constraint failed:   agent_groups.agent_id,  agent_groups.priority');
    expect(parseAgentGroupsConflict(err)?.field).toBe('priority');
  });

  it('returns null for unrelated errors', () => {
    expect(parseAgentGroupsConflict(new Error('some other error'))).toBeNull();
    expect(parseAgentGroupsConflict(null)).toBeNull();
    expect(parseAgentGroupsConflict({ message: 'no field info' })).toBeNull();
  });

  it('returns null for a UNIQUE error from a DIFFERENT table', () => {
    const err = new Error('UNIQUE constraint failed: users.username');
    expect(parseAgentGroupsConflict(err)).toBeNull();
  });
});

// ─── setGroupMembers ─────────────────────────────────────────────────────────

describe('setGroupMembers', () => {
  it('issues a DELETE then a single multi-row INSERT (no N+1 inserts)', async () => {
    await setGroupMembers('group-1', ['user-a', 'user-b', 'user-c']);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [delSql, delParams] = mockQuery.mock.calls[0];
    expect(delSql).toContain('DELETE FROM agent_group_members');
    expect(delParams).toEqual(['group-1']);

    const [insSql, insParams] = mockQuery.mock.calls[1];
    expect(insSql).toContain('INSERT INTO agent_group_members');
    expect(insSql).toContain('VALUES ($1, $2), ($1, $3), ($1, $4)');
    expect(insParams).toEqual(['group-1', 'user-a', 'user-b', 'user-c']);
  });

  it('skips the INSERT entirely when the new list is empty', async () => {
    await setGroupMembers('group-1', []);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('DELETE FROM agent_group_members');
  });

  it('de-duplicates user IDs before inserting', async () => {
    await setGroupMembers('group-1', ['user-a', 'user-a', 'user-b']);
    const [insSql, insParams] = mockQuery.mock.calls[1];
    expect(insSql).toContain('VALUES ($1, $2), ($1, $3)');
    expect(insParams).toEqual(['group-1', 'user-a', 'user-b']);
  });

  it('drops empty/falsy user IDs', async () => {
    await setGroupMembers('group-1', ['user-a', '', 'user-b']);
    const [, insParams] = mockQuery.mock.calls[1];
    expect(insParams).toEqual(['group-1', 'user-a', 'user-b']);
  });
});
