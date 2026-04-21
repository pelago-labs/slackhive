/**
 * @fileoverview MCP server connectivity test endpoint.
 *
 * POST /api/mcps/[id]/test
 *
 * For stdio MCPs: spawns the process and performs a real MCP handshake over
 * stdin/stdout — initialize → notifications/initialized → tools/list.
 *
 * For SSE/HTTP MCPs: performs the same handshake over the Streamable HTTP
 * transport (spec 2025-03-26) — POSTs JSON-RPC to the configured URL, echoes
 * any Mcp-Session-Id header the server assigns, and accepts responses in
 * either application/json or text/event-stream form.
 *
 * Returns the list of tools the server advertises so the UI can surface
 * "connects but registers no tools" as a signal distinct from "connects".
 *
 * Times out after TIMEOUT_MS (30s) for the whole exchange.
 *
 * @module web/api/mcps/[id]/test
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMcpServerById, getEnvVarValues } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import { spawn } from 'child_process';
import { writeFile, unlink, mkdir, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join, delimiter } from 'path';
import type { McpStdioConfig, McpSseConfig } from '@slackhive/shared';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

const TIMEOUT_MS = 30_000;

/**
 * POST /api/mcps/[id]/test
 * Runs a quick connectivity check against the MCP server.
 *
 * @returns {Promise<NextResponse>} { ok: true, message } or { ok: false, error }
 */
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const server = await getMcpServerById(id);
  if (!server) {
    return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
  }

  try {
    if (server.type === 'stdio') {
      const result = await testStdioMcp(server.config as McpStdioConfig, server.name);
      return NextResponse.json(result);
    }

    // SSE / HTTP — real MCP handshake over Streamable HTTP transport (spec 2025-03-26)
    const result = await testStreamableHttpMcp(
      server.config as McpSseConfig & { envRefs?: Record<string, string> },
      server.name,
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message });
  }
}

/** Candidate node_modules roots to search, ordered by preference. */
function nmCandidates(): string[] {
  const cwd = process.cwd(); // apps/web when launched from there, or workspace root
  return [
    join(cwd, 'node_modules'),                // workspace root (native)
    join(cwd, '..', '..', 'node_modules'),    // two up from apps/web (monorepo root)
    '/app/node_modules',                       // Docker
  ];
}

async function resolveTsx(): Promise<string> {
  for (const nm of nmCandidates()) {
    const p = join(nm, '.bin', 'tsx');
    try { await access(p); return p; } catch { /* try next */ }
  }
  return 'tsx'; // last resort: PATH lookup
}

async function resolveNodePath(): Promise<string> {
  const found: string[] = [];
  for (const nm of nmCandidates()) {
    try { await access(nm); found.push(nm); } catch { /* skip */ }
  }
  return found.join(delimiter);
}

/**
 * Spawns a stdio MCP process, sends an MCP initialize request, and verifies
 * the response. Resolves envRefs from the env_vars store before spawning.
 */
async function testStdioMcp(
  cfg: McpStdioConfig,
  name: string
): Promise<{ ok: boolean; message?: string; error?: string; tools?: string[] }> {
  const resolvedEnv: Record<string, string> = { ...(cfg.env ?? {}) };
  if (cfg.envRefs && Object.keys(cfg.envRefs).length > 0) {
    try {
      const envVarValues = await getEnvVarValues();
      for (const [subKey, storeKey] of Object.entries(cfg.envRefs)) {
        if (envVarValues[storeKey] !== undefined) resolvedEnv[subKey] = envVarValues[storeKey];
      }
    } catch { /* ENV_SECRET_KEY not set — skip */ }
  }

  let command: string;
  let args: string[];
  let tmpScript: string | null = null;

  if (cfg.tsSource) {
    const dir = join(tmpdir(), 'slackhive-mcp-test');
    await mkdir(dir, { recursive: true });
    tmpScript = join(dir, `test-${Date.now()}.ts`);
    await writeFile(tmpScript, cfg.tsSource, 'utf8');
    command = await resolveTsx();
    args = [tmpScript];
  } else {
    command = cfg.command;
    args = cfg.args ?? [];
  }

  const nodePath = await resolveNodePath();
  const cleanup = () => { if (tmpScript) unlink(tmpScript).catch(() => {}); };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let serverName = name;

    const finish = (result: { ok: boolean; message?: string; error?: string; tools?: string[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      cleanup();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `Timed out after ${TIMEOUT_MS / 1000}s — process did not respond` });
    }, TIMEOUT_MS);

    const proc = spawn(command, args, {
      env: { ...process.env, NODE_PATH: nodePath, ...resolvedEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Step 1: initialize (id=1)
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'slackhive-test', version: '1.0.0' },
      },
    }) + '\n');

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      // Consume complete lines; keep any trailing partial in the buffer.
      const newlineIdx = stdout.lastIndexOf('\n');
      if (newlineIdx === -1) return;
      const completeChunk = stdout.slice(0, newlineIdx);
      stdout = stdout.slice(newlineIdx + 1);

      for (const line of completeChunk.split('\n')) {
        if (!line.trim()) continue;
        let msg: {
          id?: number;
          result?: { serverInfo?: { name?: string }; tools?: Array<{ name: string }> };
          error?: { message?: string };
        };
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.id === 1) {
          if (msg.error) {
            finish({ ok: false, error: msg.error.message ?? 'MCP error' });
            return;
          }
          serverName = msg.result?.serverInfo?.name ?? name;
          // Step 2: notifications/initialized (required before tools/list), then tools/list (id=2)
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        } else if (msg.id === 2) {
          if (msg.error) {
            finish({ ok: true, message: `Connected to "${serverName}" — tools/list unsupported` });
          } else {
            const tools = (msg.result?.tools ?? []).map(t => t.name);
            const suffix = tools.length === 0
              ? 'no tools exposed'
              : `${tools.length} tool${tools.length === 1 ? '' : 's'} available`;
            finish({ ok: true, message: `Connected to "${serverName}" — ${suffix}`, tools });
          }
        }
      }
    });

    proc.on('error', (err) => {
      finish({ ok: false, error: `Failed to start: ${err.message}${stderr ? ` — ${stderr.trim()}` : ''}` });
    });

    proc.on('exit', (code) => {
      finish({
        ok: false,
        error: `Process exited with code ${code}${stderr ? ` — ${stderr.trim()}` : ''}`,
      });
    });
  });
}

// ─── Streamable HTTP transport ────────────────────────────────────────────────

/**
 * Tests an MCP server over the Streamable HTTP transport (spec 2025-03-26).
 * Performs a full handshake: initialize → notifications/initialized → tools/list.
 * Echoes Mcp-Session-Id on subsequent requests when the server sets it.
 * Accepts responses in either application/json or text/event-stream form.
 */
async function testStreamableHttpMcp(
  cfg: McpSseConfig & { envRefs?: Record<string, string> },
  name: string,
): Promise<{ ok: boolean; message?: string; error?: string; tools?: string[] }> {
  // Build request headers: required MCP headers + configured extras + resolved envRef secrets.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(cfg.headers ?? {}),
  };
  if (cfg.envRefs && Object.keys(cfg.envRefs).length > 0) {
    try {
      const envVarValues = await getEnvVarValues();
      for (const [headerKey, storeKey] of Object.entries(cfg.envRefs)) {
        const val = envVarValues[storeKey];
        if (val) headers[headerKey] = headers[headerKey] ? `${headers[headerKey]}${val}` : val;
      }
    } catch { /* env vars unavailable — continue without */ }
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    // 1. initialize
    const initRes = await fetch(cfg.url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'slackhive-test', version: '1.0.0' },
        },
      }),
    });

    if (!initRes.ok) {
      // Per spec backwards-compat note: 4xx on POST likely means a legacy HTTP+SSE server
      // (separate /sse EventStream + POST endpoint). We don't implement fallback.
      if (initRes.status === 404 || initRes.status === 405) {
        return {
          ok: false,
          error: `HTTP ${initRes.status} on POST — server may be using the deprecated HTTP+SSE transport (not supported).`,
        };
      }
      return { ok: false, error: `HTTP ${initRes.status}: ${initRes.statusText}` };
    }

    const sessionId = initRes.headers.get('mcp-session-id');
    const initMsg = await readJsonRpcResponse(initRes, 1);
    if (initMsg.error) {
      return { ok: false, error: initMsg.error.message ?? 'MCP error during initialize' };
    }
    const serverName = initMsg.result?.serverInfo?.name ?? name;

    // All subsequent requests echo the session id if the server assigned one.
    const sessionHeaders = sessionId ? { ...headers, 'Mcp-Session-Id': sessionId } : headers;

    // 2. notifications/initialized (required before any other request; returns 202 with empty body)
    const notifyRes = await fetch(cfg.url, {
      method: 'POST',
      headers: sessionHeaders,
      signal,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    if (!notifyRes.ok && notifyRes.status !== 202) {
      // Non-fatal: some servers are lenient about the notification response code.
      console.warn(`notifications/initialized returned HTTP ${notifyRes.status}`);
    }

    // 3. tools/list
    const toolsRes = await fetch(cfg.url, {
      method: 'POST',
      headers: sessionHeaders,
      signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    if (toolsRes.status === 404) {
      return { ok: false, error: 'Session expired (HTTP 404) after initialize' };
    }
    if (!toolsRes.ok) {
      return { ok: true, message: `Connected to "${serverName}" — tools/list unsupported` };
    }
    const toolsMsg = await readJsonRpcResponse(toolsRes, 2);
    if (toolsMsg.error) {
      return { ok: true, message: `Connected to "${serverName}" — tools/list unsupported` };
    }
    const tools = (toolsMsg.result?.tools ?? []).map((t: { name: string }) => t.name);
    const suffix = tools.length === 0
      ? 'no tools exposed'
      : `${tools.length} tool${tools.length === 1 ? '' : 's'} available`;
    return { ok: true, message: `Connected to "${serverName}" — ${suffix}`, tools };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Reads a single JSON-RPC response from either a plain JSON body or an
 * SSE stream. Streamable HTTP servers may return either; clients MUST support both.
 * Finds the first response whose id matches expectedId.
 */
async function readJsonRpcResponse(
  res: Response,
  expectedId: number,
): Promise<{ id?: number; result?: any; error?: { message?: string } }> {
  const contentType = res.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    // SSE: events are separated by blank lines; each event has one or more `data:` lines.
    for (const block of text.split(/\r?\n\r?\n/)) {
      const dataLines: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('\n');
      try {
        const obj = JSON.parse(payload);
        if (obj.id === expectedId) return obj;
      } catch { /* skip frames that aren't JSON-RPC */ }
    }
    throw new Error(`No JSON-RPC response with id=${expectedId} in SSE stream`);
  }

  // Default: application/json (or unspecified — best-effort)
  return res.json();
}
