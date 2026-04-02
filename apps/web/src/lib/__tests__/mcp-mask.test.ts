/**
 * @fileoverview Unit tests for mcp-mask.ts — maskMcpConfig, maskMcpServer, mergeMcpConfig.
 *
 * These tests cover the core security behaviour: secrets are never returned to
 * the client in plaintext, and sending back "********" placeholders on PATCH
 * never overwrites the real stored value.
 *
 * No database connection required — all tests use inline data.
 *
 * @module web/lib/__tests__/mcp-mask.test
 */

import { describe, it, expect } from 'vitest';
import { maskMcpConfig, maskMcpServer, mergeMcpConfig } from '@/lib/mcp-mask';
import type { McpServer } from '@slackhive/shared';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'mcp-1',
    name: 'test-mcp',
    type: 'stdio',
    config: { command: 'node', args: ['server.js'], env: { SECRET: 'real-secret', API_KEY: 'real-key' } },
    description: 'Test server',
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  };
}

// ─── maskMcpConfig ────────────────────────────────────────────────────────────

describe('maskMcpConfig', () => {
  it('masks all env values for stdio config', () => {
    const config = { command: 'node', args: ['s.js'], env: { SECRET: 'real-secret', KEY: 'real-key' } };
    const result = maskMcpConfig(config) as typeof config;
    expect(result.env.SECRET).toBe('********');
    expect(result.env.KEY).toBe('********');
  });

  it('preserves env keys after masking', () => {
    const config = { command: 'node', args: [], env: { DB_URL: 'postgres://...', TOKEN: 'abc' } };
    const result = maskMcpConfig(config) as typeof config;
    expect(Object.keys(result.env)).toEqual(['DB_URL', 'TOKEN']);
  });

  it('preserves non-secret fields (command, args) for stdio', () => {
    const config = { command: 'node', args: ['server.js'], env: { KEY: 'val' } };
    const result = maskMcpConfig(config) as typeof config;
    expect(result.command).toBe('node');
    expect(result.args).toEqual(['server.js']);
  });

  it('masks all header values for sse config', () => {
    const config = { url: 'https://api.example.com/sse', headers: { Authorization: 'Bearer tok', 'X-Key': 'secret' } };
    const result = maskMcpConfig(config) as typeof config;
    expect(result.headers.Authorization).toBe('********');
    expect(result.headers['X-Key']).toBe('********');
  });

  it('preserves url for sse config after masking headers', () => {
    const config = { url: 'https://api.example.com/sse', headers: { Authorization: 'Bearer tok' } };
    const result = maskMcpConfig(config) as typeof config;
    expect(result.url).toBe('https://api.example.com/sse');
  });

  it('masks header values for http config', () => {
    const config = { url: 'https://api.example.com/mcp', headers: { 'X-Api-Key': 'supersecret' } };
    const result = maskMcpConfig(config) as typeof config;
    expect((result as typeof config).headers['X-Api-Key']).toBe('********');
  });

  it('returns config unchanged when no env or headers present (stdio without env)', () => {
    const config = { command: 'node', args: ['s.js'] };
    const result = maskMcpConfig(config);
    expect(result).toEqual(config);
  });

  it('returns config unchanged when env is empty object', () => {
    const config = { command: 'node', args: [], env: {} };
    const result = maskMcpConfig(config) as typeof config;
    expect(result.env).toEqual({});
  });

  it('does not mutate the original config object', () => {
    const config = { command: 'node', args: [], env: { SECRET: 'real' } };
    maskMcpConfig(config);
    expect((config as typeof config).env.SECRET).toBe('real');
  });
});

// ─── maskMcpServer ────────────────────────────────────────────────────────────

describe('maskMcpServer', () => {
  it('returns a server with masked env values', () => {
    const server = makeServer();
    const result = maskMcpServer(server);
    const cfg = result.config as { env: Record<string, string> };
    expect(cfg.env.SECRET).toBe('********');
    expect(cfg.env.API_KEY).toBe('********');
  });

  it('preserves all non-config fields on the server', () => {
    const server = makeServer({ name: 'my-mcp', type: 'stdio', enabled: false });
    const result = maskMcpServer(server);
    expect(result.id).toBe('mcp-1');
    expect(result.name).toBe('my-mcp');
    expect(result.type).toBe('stdio');
    expect(result.enabled).toBe(false);
  });

  it('does not mutate the original server object', () => {
    const server = makeServer();
    maskMcpServer(server);
    const cfg = server.config as { env: Record<string, string> };
    expect(cfg.env.SECRET).toBe('real-secret');
  });
});

// ─── mergeMcpConfig ───────────────────────────────────────────────────────────

describe('mergeMcpConfig', () => {
  it('preserves existing secret when incoming value is "********"', () => {
    const existing = { command: 'node', args: [], env: { SECRET: 'real-secret' } };
    const incoming = { command: 'node', args: [], env: { SECRET: '********' } };
    const result = mergeMcpConfig(existing, incoming) as typeof existing;
    expect(result.env.SECRET).toBe('real-secret');
  });

  it('uses new value when incoming is not "********"', () => {
    const existing = { command: 'node', args: [], env: { SECRET: 'old-secret' } };
    const incoming = { command: 'node', args: [], env: { SECRET: 'new-secret' } };
    const result = mergeMcpConfig(existing, incoming) as typeof existing;
    expect(result.env.SECRET).toBe('new-secret');
  });

  it('handles mixed masked and real values in same PATCH', () => {
    const existing = { command: 'node', args: [], env: { SECRET: 'real-secret', NEW_KEY: 'old-val' } };
    const incoming = { command: 'node', args: [], env: { SECRET: '********', NEW_KEY: 'updated' } };
    const result = mergeMcpConfig(existing, incoming) as typeof existing;
    expect(result.env.SECRET).toBe('real-secret');
    expect(result.env.NEW_KEY).toBe('updated');
  });

  it('removes a key deleted by the user (key absent from incoming)', () => {
    const existing = { command: 'node', args: [], env: { SECRET: 'real', OLD_KEY: 'val' } };
    const incoming = { command: 'node', args: [], env: { SECRET: '********' } };
    const result = mergeMcpConfig(existing, incoming) as typeof existing;
    expect('OLD_KEY' in result.env).toBe(false);
  });

  it('adds a new key introduced in the PATCH', () => {
    const existing = { command: 'node', args: [], env: { SECRET: 'real' } };
    const incoming = { command: 'node', args: [], env: { SECRET: '********', NEW_KEY: 'new-val' } };
    const result = mergeMcpConfig(existing, incoming) as { command: string; args: string[]; env: Record<string, string> };
    expect(result.env.SECRET).toBe('real');
    expect(result.env.NEW_KEY).toBe('new-val');
  });

  it('preserves existing header secret for sse config', () => {
    const existing = { url: 'https://api.example.com/sse', headers: { Authorization: 'Bearer real-token' } };
    const incoming = { url: 'https://api.example.com/sse', headers: { Authorization: '********' } };
    const result = mergeMcpConfig(existing, incoming) as typeof existing;
    expect(result.headers.Authorization).toBe('Bearer real-token');
  });

  it('updates url even when headers are masked', () => {
    const existing = { url: 'https://old.example.com/sse', headers: { Authorization: 'Bearer tok' } };
    const incoming = { url: 'https://new.example.com/sse', headers: { Authorization: '********' } };
    const result = mergeMcpConfig(existing, incoming) as typeof existing;
    expect(result.url).toBe('https://new.example.com/sse');
    expect(result.headers.Authorization).toBe('Bearer tok');
  });

  it('returns incoming unchanged when neither env nor headers exist', () => {
    const existing = { command: 'node', args: ['s.js'] };
    const incoming = { command: 'python', args: ['s.py'] };
    const result = mergeMcpConfig(existing, incoming);
    expect(result).toEqual(incoming);
  });

  it('does not mutate the existing config', () => {
    const existing = { command: 'node', args: [], env: { SECRET: 'real' } };
    const incoming = { command: 'node', args: [], env: { SECRET: 'new' } };
    mergeMcpConfig(existing, incoming);
    expect(existing.env.SECRET).toBe('real');
  });
});

// ─── maskMcpConfig — envRefs and tsSource pass-through ───────────────────────

describe('maskMcpConfig — envRefs and tsSource are not secrets', () => {
  it('passes envRefs through unchanged when masking env values', () => {
    const config = {
      command: 'tsx',
      args: ['server.ts'],
      env: { EXTRA: 'val' },
      envRefs: { DATABASE_URL: 'REDSHIFT_DATABASE_URL' },
    };
    const result = maskMcpConfig(config) as typeof config;
    expect(result.envRefs).toEqual({ DATABASE_URL: 'REDSHIFT_DATABASE_URL' });
    expect(result.env.EXTRA).toBe('********');
  });

  it('passes tsSource through unchanged when masking env values', () => {
    const config = {
      command: 'tsx',
      args: ['server.ts'],
      env: { SECRET: 'val' },
      tsSource: 'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
    };
    const result = maskMcpConfig(config) as typeof config;
    expect(result.tsSource).toBe(config.tsSource);
    expect(result.env.SECRET).toBe('********');
  });

  it('passes envRefs and tsSource through even with no inline env', () => {
    const config = {
      command: 'tsx',
      args: [],
      envRefs: { DB: 'MY_DB_URL' },
      tsSource: '// inline source',
    };
    const result = maskMcpConfig(config) as typeof config;
    expect(result.envRefs).toEqual({ DB: 'MY_DB_URL' });
    expect(result.tsSource).toBe('// inline source');
  });
});

// ─── mergeMcpConfig — envRefs handling ────────────────────────────────────────

describe('mergeMcpConfig — envRefs are config fields, not secrets', () => {
  it('replaces envRefs with incoming value', () => {
    const existing = { command: 'tsx', args: [], envRefs: { DB: 'OLD_KEY' } };
    const incoming = { command: 'tsx', args: [], envRefs: { DB: 'NEW_KEY' } };
    const result = mergeMcpConfig(existing, incoming) as typeof existing;
    expect(result.envRefs).toEqual({ DB: 'NEW_KEY' });
  });

  it('removes envRefs when incoming omits them', () => {
    const existing = { command: 'tsx', args: [], envRefs: { DB: 'SOME_KEY' } };
    const incoming = { command: 'tsx', args: [] };
    const result = mergeMcpConfig(existing, incoming) as unknown as Record<string, unknown>;
    expect(result.envRefs).toBeUndefined();
  });
});

// ─── mergeMcpConfig — header branch gaps (lines 81-84) ───────────────────────

describe('mergeMcpConfig — header key deletion and new key for sse/http', () => {
  it('removes a header key deleted by the user', () => {
    const existing = { url: 'https://api.example.com/sse', headers: { Authorization: 'Bearer tok', 'X-Old': 'val' } };
    const incoming = { url: 'https://api.example.com/sse', headers: { Authorization: '********' } };
    const result = mergeMcpConfig(existing, incoming) as typeof existing;
    expect('X-Old' in result.headers).toBe(false);
    expect(result.headers.Authorization).toBe('Bearer tok');
  });

  it('adds a new header key introduced in the PATCH', () => {
    const existing = { url: 'https://api.example.com/sse', headers: { Authorization: 'Bearer tok' } };
    const incoming = { url: 'https://api.example.com/sse', headers: { Authorization: '********', 'X-New': 'newval' } };
    const result = mergeMcpConfig(existing, incoming) as typeof existing;
    expect(result.headers.Authorization).toBe('Bearer tok');
    expect((result.headers as Record<string, string>)['X-New']).toBe('newval');
  });

  it('uses new real header value when not masked', () => {
    const existing = { url: 'https://api.example.com/sse', headers: { Authorization: 'Bearer old' } };
    const incoming = { url: 'https://api.example.com/sse', headers: { Authorization: 'Bearer new' } };
    const result = mergeMcpConfig(existing, incoming) as typeof existing;
    expect(result.headers.Authorization).toBe('Bearer new');
  });
});
