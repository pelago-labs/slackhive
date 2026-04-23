/**
 * @fileoverview Unit tests for mcp-json.ts — parseMcpJson and serializeMcpJson.
 *
 * Covers the Cursor / Claude Desktop / VS Code paste shape, `${env:NAME}`
 * substitution, masked-secret round-trip, and malformed-input error paths.
 *
 * @module web/lib/__tests__/mcp-json.test
 */

import { describe, it, expect } from 'vitest';
import { parseMcpJson, serializeMcpJson } from '@/lib/mcp-json';

// ─── parseMcpJson: shapes ─────────────────────────────────────────────────────

describe('parseMcpJson — input shapes', () => {
  it('accepts the wrapped { mcpServers: { name: cfg } } shape', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: {
        elasticsearch: { command: 'npx', args: ['-y', '@elastic/mcp-server-elasticsearch'] },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe('elasticsearch');
    expect(result.config).toEqual({ command: 'npx', args: ['-y', '@elastic/mcp-server-elasticsearch'] });
  });

  it('accepts the bare { command, args } shape with name=null', () => {
    const result = parseMcpJson(JSON.stringify({ command: 'node', args: ['server.js'] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe(null);
    expect(result.config).toEqual({ command: 'node', args: ['server.js'] });
  });

  it('warns when mcpServers has multiple entries and uses the first', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: {
        first: { command: 'a' },
        second: { command: 'b' },
        third: { command: 'c' },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe('first');
    expect(result.warnings[0]).toMatch(/first/);
    expect(result.warnings[0]).toMatch(/ignored 2/);
  });
});

// ─── parseMcpJson: ${env:NAME} ─────────────────────────────────────────────────

describe('parseMcpJson — env substitution', () => {
  it('lifts ${env:NAME} values in env into envRefs', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: {
        es: {
          command: 'npx',
          env: { ES_URL: '${env:ES_URL}', ES_API_KEY: '${env:ELASTIC_SECRET}' },
        },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({
      command: 'npx',
      envRefs: { ES_URL: 'ES_URL', ES_API_KEY: 'ELASTIC_SECRET' },
    });
  });

  it('preserves inline non-ref env values', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: { x: { command: 'node', env: { LOG_LEVEL: 'debug', REGION: 'us-east-1' } } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({
      command: 'node',
      env: { LOG_LEVEL: 'debug', REGION: 'us-east-1' },
    });
  });

  it('drops "********" placeholders so mergeMcpConfig preserves the stored secret', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: { x: { command: 'node', env: { API_KEY: '********', DEBUG: 'true' } } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({ command: 'node', env: { DEBUG: 'true' } });
  });

  it('handles a prefixed header ref like "Bearer ${env:GH_TOKEN}"', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: {
        gh: { url: 'https://api.github.com', headers: { Authorization: 'Bearer ${env:GH_TOKEN}' } },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({
      url: 'https://api.github.com',
      headers: { Authorization: 'Bearer ' },
      envRefs: { Authorization: 'GH_TOKEN' },
    });
  });

  it('warns on mid-string ${env:NAME} refs and keeps the literal value', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: {
        es: { command: 'node', env: { ES_URL: 'https://${env:HOST}/api' } },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Value stays literal — not lifted into envRefs, not silently dropped.
    expect(result.config).toEqual({
      command: 'node',
      env: { ES_URL: 'https://${env:HOST}/api' },
    });
    expect(result.warnings.some(w => w.includes('env.ES_URL') && w.includes('end of the value'))).toBe(true);
  });

  it('warns on multiple ${env:...} refs in the same value', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: {
        x: { url: 'https://x', headers: { Mix: '${env:USER}@${env:HOST}' } },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some(w => w.includes('headers.Mix'))).toBe(true);
  });
});

// ─── parseMcpJson: error paths ─────────────────────────────────────────────────

describe('parseMcpJson — errors', () => {
  it('rejects empty input', () => {
    expect(parseMcpJson('')).toEqual({ ok: false, error: 'Config is empty' });
    expect(parseMcpJson('   \n  ')).toEqual({ ok: false, error: 'Config is empty' });
  });

  it('returns an error for malformed JSON (line is best-effort)', () => {
    const bad = '{\n  "command": "node",\n  "args": ["x",]\n}';
    const result = parseMcpJson(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON|token|parse/i);
    if (result.line !== undefined) expect(result.line).toBeGreaterThanOrEqual(1);
  });

  it('extracts a line number when the runtime reports "position N"', () => {
    // Some Node/V8 versions emit `Unexpected token ... in JSON at position N`
    // and others emit `...snippet...`. Stub JSON.parse to throw a controlled
    // message so the lineFromOffset path is exercised deterministically.
    const src = 'a\nb\nc\nd'; // positions: a=0, \n=1, b=2, \n=3, c=4, \n=5, d=6
    const err = new Error('Unexpected token at position 4'); // position 4 → line 3
    const origParse = JSON.parse;
    JSON.parse = () => { throw err; };
    try {
      const result = parseMcpJson(src);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.line).toBe(3);
    } finally {
      JSON.parse = origParse;
    }
  });

  it('rejects arrays at top level', () => {
    const result = parseMcpJson('[1,2,3]');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/object/);
  });

  it('rejects a server with neither command nor url', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { x: { args: ['y'] } } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/command.*url/);
  });

  it('rejects an empty mcpServers block', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: {} }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/empty/);
  });

  it('rejects non-string args', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { x: { command: 'node', args: [1, 2] } } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/args/);
  });
});

// ─── parseMcpJson: args with commas ────────────────────────────────────────────

describe('parseMcpJson — args preservation', () => {
  it('preserves args containing literal commas', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: { x: { command: 'node', args: ['--filter', 'tag=foo,bar', '--verbose'] } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({
      command: 'node',
      args: ['--filter', 'tag=foo,bar', '--verbose'],
    });
  });

  it('preserves args with spaces', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: { x: { command: 'sh', args: ['-c', 'echo hello world'] } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.config as { args: string[] }).args).toEqual(['-c', 'echo hello world']);
  });
});

// ─── serializeMcpJson ─────────────────────────────────────────────────────────

describe('serializeMcpJson', () => {
  it('emits the wrapped mcpServers shape', () => {
    const out = serializeMcpJson('es', { command: 'npx', args: ['-y', 'pkg'] });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ mcpServers: { es: { command: 'npx', args: ['-y', 'pkg'] } } });
  });

  it('re-emits envRefs as ${env:NAME}', () => {
    const out = serializeMcpJson('es', {
      command: 'npx',
      envRefs: { ES_URL: 'ES_URL', TOKEN: 'ELASTIC_SECRET' },
    });
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.es.env).toEqual({
      ES_URL: '${env:ES_URL}',
      TOKEN: '${env:ELASTIC_SECRET}',
    });
  });

  it('re-emits prefixed header refs as "Bearer ${env:NAME}"', () => {
    const out = serializeMcpJson('gh', {
      url: 'https://api.github.com',
      headers: { Authorization: 'Bearer ' },
      envRefs: { Authorization: 'GH_TOKEN' },
    });
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.gh.headers).toEqual({ Authorization: 'Bearer ${env:GH_TOKEN}' });
  });

  it('emits masked "********" for inline secrets (server-side merge will restore)', () => {
    const out = serializeMcpJson('x', {
      command: 'node',
      env: { API_KEY: '********', DEBUG: 'true' },
    });
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.x.env).toEqual({ API_KEY: '********', DEBUG: 'true' });
  });

  it('omits empty env and header maps', () => {
    const out = serializeMcpJson('x', { command: 'node' });
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.x).toEqual({ command: 'node' });
  });
});

// ─── Round-trip identity ───────────────────────────────────────────────────────

describe('round-trip parse → serialize → parse', () => {
  it('stdio with envRefs and inline env', () => {
    const input = {
      mcpServers: {
        es: {
          command: 'npx',
          args: ['-y', '@elastic/mcp-server-elasticsearch@0.1.1'],
          env: { ES_URL: '${env:ES_URL}', LOG_LEVEL: 'debug' },
        },
      },
    };
    const first = parseMcpJson(JSON.stringify(input));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const serialized = serializeMcpJson(first.name!, first.config);
    const second = parseMcpJson(serialized);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.name).toBe('es');
    expect(second.config).toEqual(first.config);
  });

  it('sse with header ref', () => {
    const input = {
      mcpServers: {
        gh: {
          url: 'https://api.github.com/mcp',
          headers: { Authorization: 'Bearer ${env:GH_TOKEN}' },
        },
      },
    };
    const first = parseMcpJson(JSON.stringify(input));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = parseMcpJson(serializeMcpJson(first.name!, first.config));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.config).toEqual(first.config);
  });
});
