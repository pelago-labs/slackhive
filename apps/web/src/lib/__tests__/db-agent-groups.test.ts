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
  getUserSlackIdById,
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

  it('maps source_rank → source AND derives accessLevel per row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'u-admin',   username: 'admin',     role: 'admin',  top_rank: 1, access_level: null },
        { id: 'u-creator', username: 'bob',       role: 'editor', top_rank: 2, access_level: null },
        { id: 'u-trigger', username: 'aman',      role: 'viewer', top_rank: 3, access_level: 'trigger' },
        { id: 'u-view',    username: 'altaf',     role: 'viewer', top_rank: 3, access_level: 'view' },
        { id: 'u-edit',    username: 'collab',    role: 'editor', top_rank: 3, access_level: 'edit' },
      ],
      rowCount: 5,
    });
    const result = await listAgentEligibleUsers('agent-1');
    expect(result).toEqual([
      { id: 'u-admin',   username: 'admin',  role: 'admin',  source: 'admin',   accessLevel: 'admin' },
      { id: 'u-creator', username: 'bob',    role: 'editor', source: 'creator', accessLevel: 'owner' },
      { id: 'u-trigger', username: 'aman',   role: 'viewer', source: 'access',  accessLevel: 'trigger' },
      { id: 'u-view',    username: 'altaf',  role: 'viewer', source: 'access',  accessLevel: 'view' },
      { id: 'u-edit',    username: 'collab', role: 'editor', source: 'access',  accessLevel: 'edit' },
    ]);
  });

  it('access_level fallback: missing/unknown value → trigger (least privilege)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'u-1', username: 'a', role: 'viewer', top_rank: 3, access_level: null },
        { id: 'u-2', username: 'b', role: 'viewer', top_rank: 3, access_level: 'something-weird' },
      ],
      rowCount: 2,
    });
    const result = await listAgentEligibleUsers('agent-1');
    expect(result.map(u => u.accessLevel)).toEqual(['trigger', 'trigger']);
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
    // The third UNION arm now carries aa.access_level so the audience picker
    // can distinguish trigger-only users from view/edit collaborators.
    expect(sql).toContain('aa.access_level');
    expect(sql).toContain('MAX(access_level)');
  });
});

// ─── getUserSlackIdById ──────────────────────────────────────────────────────

describe('getUserSlackIdById', () => {
  it('returns the slack_user_id for a known user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ slack_user_id: 'U_ABC' }], rowCount: 1 });
    expect(await getUserSlackIdById('user-1')).toBe('U_ABC');
  });

  it('returns null when the user does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await getUserSlackIdById('missing')).toBeNull();
  });

  it('returns null when the user has no Slack mapping (admin-created user)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ slack_user_id: null }], rowCount: 1 });
    expect(await getUserSlackIdById('user-2')).toBeNull();
  });

  it('passes the user id as the only parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getUserSlackIdById('user-3');
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['user-3']);
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
  it('runs DELETE + multi-row INSERT inside a transaction (atomic replace)', async () => {
    // The transaction signature is generic (`<T>(fn) => Promise<T>`), which
    // doesn't unify with vi.fn's inferred return type — cast to any here so
    // the spy still records calls. We assert call count below.
    const txSpy = vi.fn(async (fn: (tx: DbAdapter) => Promise<unknown>) => fn(fakeAdapter));
    const adapter: DbAdapter = { ...fakeAdapter, transaction: txSpy as unknown as DbAdapter['transaction'] };
    setDb(adapter);

    await setGroupMembers('group-1', ['user-a', 'user-b', 'user-c']);
    expect(txSpy).toHaveBeenCalledTimes(1);
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
