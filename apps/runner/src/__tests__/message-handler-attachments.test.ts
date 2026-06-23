/**
 * @fileoverview Large attachments are staged to the agent's cwd (./attachments/)
 * and referenced by path so the agent reads/chunks them with its own tools —
 * the same on Claude and Codex, since both expose getSessionWorkDir and have file
 * tools. Small files still inline. Replaces the old truncate-at-512KB behaviour.
 *
 * @module runner/__tests__/message-handler-attachments
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Agent, IncomingMessage, PlatformAdapter } from '@slackhive/shared';
import { MessageHandler } from '../message-handler';

let workDir: string;
let captured: { prompt?: unknown };

function makeAdapter(buffer: Uint8Array): PlatformAdapter {
  return {
    platform: 'test',
    formattingRules: '',
    postMessage: vi.fn(async () => 'm'),
    postPayload: vi.fn(async () => 'm'),
    updateMessage: vi.fn(async () => undefined),
    postReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    getThreadMessages: vi.fn(async () => []),
    getUserDisplayName: vi.fn(async () => 'tester'),
    downloadFile: vi.fn(async () => buffer),
    resolveLinkedMessage: vi.fn(async () => null),
    buildPayloads: vi.fn((t: string) => [{ text: t }]),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as PlatformAdapter;
}

/** Fake backend exposing the same surface both real backends now have. */
function makeBackend() {
  return {
    getSessionKey: (u: string, c: string, t?: string) => `${u}-${c}-${t ?? 'direct'}`,
    getSessionWorkDir: () => { fs.mkdirSync(workDir, { recursive: true }); return workDir; },
    streamQuery: vi.fn(async function* (prompt: unknown) { captured.prompt = prompt; }),
  };
}

function makeAgent(): Agent {
  return {
    id: 'a', slug: 'att-test', name: 'Att', persona: null, description: null,
    model: 'claude-sonnet-4-6', status: 'running', enabled: true, isBoss: false,
    verbose: false, reportsTo: [], tags: [], claudeMd: '', createdBy: 'system',
    createdAt: new Date(), updatedAt: new Date(),
    slackBotToken: '', slackAppToken: '', slackSigningSecret: '',
  } as unknown as Agent;
}

function makeMsg(files: unknown[]): IncomingMessage {
  return { id: 'm1', platform: 'test', userId: 'U', channelId: 'C', threadId: 't', text: 'read this', isDM: false, raw: {}, files } as unknown as IncomingMessage;
}

beforeEach(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-att-')); captured = {}; });
afterEach(() => { vi.restoreAllMocks(); });

describe('MessageHandler — large attachments staged to disk', () => {
  it('writes a >32KB text file to ./attachments and references it instead of inlining', async () => {
    const big = Buffer.from('A'.repeat(40 * 1024)); // 40 KB > 32 KB inline cap
    const handler = new MessageHandler(makeAdapter(big), makeBackend() as never, makeAgent(), null);
    await handler.handleMessage(makeMsg([{ url: 'http://x/big.csv', name: 'big.csv', mimeType: 'text/csv' }]));

    const prompt = String(captured.prompt);
    expect(prompt).toContain('saved to ./attachments/big.csv');
    expect(prompt).not.toContain('AAAA'); // content NOT inlined
    const staged = path.join(workDir, 'attachments', 'big.csv');
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.readFileSync(staged).byteLength).toBe(40 * 1024); // full file, not truncated
  });

  it('inlines a small (<=32KB) text file as before', async () => {
    const small = Buffer.from('hello small file');
    const handler = new MessageHandler(makeAdapter(small), makeBackend() as never, makeAgent(), null);
    await handler.handleMessage(makeMsg([{ url: 'http://x/s.txt', name: 's.txt', mimeType: 'text/plain' }]));

    const prompt = String(captured.prompt);
    expect(prompt).toContain('[File: s.txt]');
    expect(prompt).toContain('hello small file');
    expect(fs.existsSync(path.join(workDir, 'attachments', 's.txt'))).toBe(false);
  });

  it('sanitizes the filename when staging', async () => {
    const big = Buffer.from('B'.repeat(40 * 1024));
    const handler = new MessageHandler(makeAdapter(big), makeBackend() as never, makeAgent(), null);
    await handler.handleMessage(makeMsg([{ url: 'http://x/odd', name: '../etc/we ird?.log', mimeType: 'text/plain' }]));

    const prompt = String(captured.prompt);
    expect(prompt).toContain('./attachments/');
    // no path traversal / unsafe chars in the staged name
    const att = path.join(workDir, 'attachments');
    const names = fs.existsSync(att) ? fs.readdirSync(att) : [];
    expect(names).toHaveLength(1);
    expect(names[0]).toBe('.._etc_we_ird_.log');
  });
});
