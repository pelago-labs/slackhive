/**
 * @fileoverview Tests for updateAgent's platform-credential MERGE semantics: a
 * partial PATCH (e.g. the onboarding stepper saving only the app-level token)
 * must preserve credentials captured earlier (OAuth bot token, signing secret),
 * and an empty-string value must clear just that key.
 *
 * No real database — a fake DbAdapter is injected via setDb().
 *
 * @module web/lib/__tests__/db-update-agent-creds-merge.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDb, encrypt, decrypt, type DbAdapter, type DbResult } from '@slackhive/shared';

const TEST_KEY = 'test-encryption-key-for-merge';
vi.mock('@/lib/secrets', async () => {
  const actual = await vi.importActual<typeof import('@/lib/secrets')>('@/lib/secrets');
  return { ...actual, getEncryptionKey: () => TEST_KEY };
});

import { updateAgent } from '@/lib/db';

const mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<DbResult>>();
const fakeAdapter: DbAdapter = {
  query: mockQuery,
  transaction: async (fn) => fn(fakeAdapter),
  close: async () => {},
  type: 'sqlite',
};

const AGENT_ROW = {
  id: 'agent-1', slug: 'a1', name: 'A1', persona: null, description: null,
  model: 'gpt-5.6-sol', status: 'stopped', enabled: true, is_boss: false,
  reports_to: [], claude_md: '', verbose: 1, created_by: 'system',
  created_at: new Date(), updated_at: new Date(),
};

function setupMock(existingBlob: Record<string, string> | null) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id, credentials FROM platform_integrations')) {
      return existingBlob
        ? { rows: [{ id: 'pi-1', credentials: encrypt(JSON.stringify(existingBlob), TEST_KEY) }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('platform_integrations')) return { rows: [], rowCount: 1 };
    return { rows: [{ ...AGENT_ROW }], rowCount: 1 };
  });
}

function savedBlob(): Record<string, string> {
  const call = mockQuery.mock.calls.find(c => c[0].includes('UPDATE platform_integrations SET credentials'));
  if (!call) throw new Error('no credentials UPDATE issued');
  return JSON.parse(decrypt((call[1] as string[])[0], TEST_KEY));
}

beforeEach(() => {
  mockQuery.mockReset();
  setDb(fakeAdapter);
});

describe('updateAgent platform credential merge', () => {
  it('appToken-only PATCH preserves the existing botToken and signingSecret', async () => {
    setupMock({ botToken: 'xoxb-captured', signingSecret: 'sig-1' });
    await updateAgent('agent-1', { platformCredentials: { appToken: 'xapp-1-new' } });
    expect(savedBlob()).toEqual({ botToken: 'xoxb-captured', signingSecret: 'sig-1', appToken: 'xapp-1-new' });
  });

  it('empty-string value clears only that key', async () => {
    setupMock({ botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 'sig-x' });
    await updateAgent('agent-1', { platformCredentials: { signingSecret: '' } });
    expect(savedBlob()).toEqual({ botToken: 'xoxb-x', appToken: 'xapp-x' });
  });

  it('full PATCH overwrites all provided keys', async () => {
    setupMock({ botToken: 'xoxb-old', appToken: 'xapp-old' });
    // botToken present → updateAgent fetches the bot profile; stub the network.
    global.fetch = vi.fn(async () => ({ json: async () => ({ ok: false }) })) as unknown as typeof fetch;
    await updateAgent('agent-1', { platformCredentials: { botToken: 'xoxb-new', appToken: 'xapp-new' } });
    expect(savedBlob()).toEqual({ botToken: 'xoxb-new', appToken: 'xapp-new' });
  });

  it('starts from empty when no integration row exists (INSERT path)', async () => {
    setupMock(null);
    global.fetch = vi.fn(async () => ({ json: async () => ({ ok: false }) })) as unknown as typeof fetch;
    await updateAgent('agent-1', { platformCredentials: { botToken: 'xoxb-first' } });
    const call = mockQuery.mock.calls.find(c => c[0].includes('INSERT INTO platform_integrations'));
    expect(call).toBeTruthy();
    const blob = JSON.parse(decrypt((call![1] as string[])[3], TEST_KEY));
    expect(blob).toEqual({ botToken: 'xoxb-first' });
  });
});
