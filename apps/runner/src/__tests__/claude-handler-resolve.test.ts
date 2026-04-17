/**
 * @fileoverview Unit tests for ClaudeHandler.resolveServerConfig and resolveEnvRefs.
 *
 * Tests cover:
 * - envRefs resolution: subprocess env var is set from the env vars store value
 * - envRefs missing key: warning logged, key omitted
 * - Inline env + envRefs merged: both contribute to the resolved env object
 * - envRefs stripped from the returned config (SDK doesn't understand it)
 * - tsSource: source written to disk, config rewritten to use tsx
 * - Plain stdio config without envRefs returned unchanged
 *
 * ClaudeHandler is instantiated with a minimal Agent and no MCP servers so the
 * constructor side-effects (port hashing, McpProcessManager) are contained.
 * The private methods are accessed via `(handler as any)` to avoid exposing them.
 *
 * No database, no Slack, no filesystem writes for the non-tsSource tests.
 *
 * @module runner/__tests__/claude-handler-resolve.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, afterEach } from 'vitest';
import { ClaudeHandler } from '../claude-handler.js';
import type { Agent } from '@slackhive/shared';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: '',
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
    slackSigningSecret: 'secret',
    model: 'claude-opus-4-6',
    status: 'stopped',
    enabled: true,
    isBoss: false,
    verbose: true,
    reportsTo: [],
    claudeMd: '',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeHandler(envVarValues: Record<string, string> = {}, workDir = '/tmp/test-handler'): ClaudeHandler {
  return new ClaudeHandler(makeAgent(), [], null, workDir, envVarValues);
}

// ─── resolveServerConfig — envRefs ───────────────────────────────────────────

describe('resolveServerConfig — envRefs resolution', () => {
  it('resolves an envRef to the store value', () => {
    const handler = makeHandler({ REDSHIFT_DATABASE_URL: 'postgres://host/db' });
    const config = {
      command: 'node',
      args: ['server.js'],
      envRefs: { DATABASE_URL: 'REDSHIFT_DATABASE_URL' },
    };
    const result = (handler as any).resolveServerConfig('my-mcp', config) as Record<string, unknown>;
    const env = result.env as Record<string, string>;
    expect(env.DATABASE_URL).toBe('postgres://host/db');
  });

  it('strips envRefs from the resolved config', () => {
    const handler = makeHandler({ MY_KEY: 'my-value' });
    const config = { command: 'node', args: [], envRefs: { ENV_KEY: 'MY_KEY' } };
    const result = (handler as any).resolveServerConfig('srv', config) as Record<string, unknown>;
    expect(result.envRefs).toBeUndefined();
  });

  it('merges inline env with resolved envRefs', () => {
    const handler = makeHandler({ STORE_KEY: 'store-value' });
    const config = {
      command: 'node',
      args: [],
      env: { INLINE_VAR: 'inline-value' },
      envRefs: { REF_VAR: 'STORE_KEY' },
    };
    const result = (handler as any).resolveServerConfig('srv', config) as Record<string, unknown>;
    const env = result.env as Record<string, string>;
    expect(env.INLINE_VAR).toBe('inline-value');
    expect(env.REF_VAR).toBe('store-value');
  });

  it('omits the key when the store entry does not exist', () => {
    const handler = makeHandler({}); // empty store
    const config = { command: 'node', args: [], envRefs: { MISSING: 'NOT_IN_STORE' } };
    const result = (handler as any).resolveServerConfig('srv', config) as Record<string, unknown>;
    const env = (result.env ?? {}) as Record<string, string>;
    expect('MISSING' in env).toBe(false);
  });

  it('returns config unchanged when envRefs is absent', () => {
    const handler = makeHandler({ KEY: 'val' });
    const config = { command: 'node', args: ['s.js'], env: { LOCAL: 'x' } };
    const result = (handler as any).resolveServerConfig('srv', config);
    expect(result).toEqual(config);
  });

  it('returns config unchanged when envRefs is an empty object', () => {
    const handler = makeHandler({ KEY: 'val' });
    const config = { command: 'node', args: [], envRefs: {} };
    const result = (handler as any).resolveServerConfig('srv', config);
    expect(result).toEqual(config);
  });
});

// ─── resolveServerConfig — tsSource ──────────────────────────────────────────

describe('resolveServerConfig — tsSource rewrites to tsx', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes tsSource to disk and sets command to tsx', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-handler-test-'));
    const handler = makeHandler({}, tmpDir);
    const src = 'console.log("hello from ts mcp");';
    const config = { command: 'ignored', args: [], tsSource: src };
    const result = (handler as any).resolveServerConfig('my-ts-mcp', config) as Record<string, unknown>;
    expect(result.command).toBe('/app/node_modules/.bin/tsx');
    expect(Array.isArray(result.args)).toBe(true);
    const scriptPath = (result.args as string[])[0];
    expect(scriptPath).toContain('my-ts-mcp.ts');
    expect(fs.readFileSync(scriptPath, 'utf8')).toBe(src);
  });

  it('strips tsSource from the resolved config', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-handler-test-'));
    const handler = makeHandler({}, tmpDir);
    const config = { command: 'ignored', args: [], tsSource: '// source' };
    const result = (handler as any).resolveServerConfig('srv', config) as Record<string, unknown>;
    expect(result.tsSource).toBeUndefined();
  });

  it('merges envRefs when tsSource is present', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-handler-test-'));
    const handler = makeHandler({ DB_URL: 'postgres://host/db' }, tmpDir);
    const config = {
      command: 'ignored',
      args: [],
      tsSource: '// source',
      envRefs: { DATABASE_URL: 'DB_URL' },
    };
    const result = (handler as any).resolveServerConfig('srv', config) as Record<string, unknown>;
    const env = result.env as Record<string, string>;
    expect(env.DATABASE_URL).toBe('postgres://host/db');
  });
});
