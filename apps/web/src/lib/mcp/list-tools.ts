/**
 * @fileoverview Shared MCP handshake helper.
 *
 * Performs a one-shot connect-and-list against an MCP server (stdio or
 * Streamable HTTP). Returns the advertised tool inventory with both
 * `name` and (optional) `description` per tool — strictly more info
 * than the original /test endpoint which only returned tool names.
 *
 * Two callers today:
 *   - POST /api/mcps/[id]/test    — connectivity probe shown in Settings → MCPs
 *   - GET  /api/mcps/[id]/tools   — populates the case-editor tool dropdown
 *                                   (caches result in mcp_servers.tool_list_cache)
 *
 * Times out after TIMEOUT_MS for the whole exchange.
 *
 * @module web/lib/mcp/list-tools
 */

import { spawn } from 'child_process';
import { writeFile, unlink, mkdir, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join, delimiter } from 'path';
import type {
  McpServer,
  McpTool,
  McpStdioConfig,
  McpSseConfig,
} from '@slackhive/shared';
import { getEnvVarValues } from '@/lib/db';

const TIMEOUT_MS = 30_000;

export interface ListMcpToolsResult {
  ok: boolean;
  /** Server's self-reported name (from serverInfo.name during handshake). */
  serverName?: string;
  /** Tool inventory advertised by the server. Empty array if server reports none. */
  tools: McpTool[];
  /** Set when ok = false. Human-readable failure reason. */
  error?: string;
  /**
   * Set when ok = true but the server doesn't expose tools/list. The
   * connection succeeded; we just have no inventory to show. UI shows
   * this as a soft empty-state, not an error.
   */
  toolsListUnsupported?: boolean;
}

/**
 * Top-level entry point — dispatches by transport type.
 */
export async function listMcpTools(server: McpServer): Promise<ListMcpToolsResult> {
  if (server.type === 'stdio') {
    return listStdioMcpTools(server.config as McpStdioConfig, server.name);
  }
  // sse + http both use the Streamable HTTP transport (spec 2025-03-26).
  return listStreamableHttpMcpTools(
    server.config as McpSseConfig & { envRefs?: Record<string, string> },
    server.name,
  );
}

// ─── stdio transport ─────────────────────────────────────────────────────────

/** Candidate node_modules roots to search, ordered by preference. */
function nmCandidates(): string[] {
  const cwd = process.cwd();
  return [
    join(cwd, 'node_modules'),
    join(cwd, '..', '..', 'node_modules'),
    '/app/node_modules',
  ];
}

async function resolveTsx(): Promise<string> {
  for (const nm of nmCandidates()) {
    const p = join(nm, '.bin', 'tsx');
    try {
      await access(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return 'tsx';
}

async function resolveNodePath(): Promise<string> {
  const found: string[] = [];
  for (const nm of nmCandidates()) {
    try {
      await access(nm);
      found.push(nm);
    } catch {
      /* skip */
    }
  }
  return found.join(delimiter);
}

async function listStdioMcpTools(
  cfg: McpStdioConfig,
  name: string,
): Promise<ListMcpToolsResult> {
  const resolvedEnv: Record<string, string> = { ...(cfg.env ?? {}) };
  if (cfg.envRefs && Object.keys(cfg.envRefs).length > 0) {
    try {
      const envVarValues = await getEnvVarValues();
      for (const [subKey, storeKey] of Object.entries(cfg.envRefs)) {
        if (envVarValues[storeKey] !== undefined) resolvedEnv[subKey] = envVarValues[storeKey];
      }
    } catch {
      /* ENV_SECRET_KEY not set — skip */
    }
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
  const cleanup = () => {
    if (tmpScript) unlink(tmpScript).catch(() => {});
  };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let serverName = name;

    const finish = (result: ListMcpToolsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      cleanup();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        tools: [],
        error: `Timed out after ${TIMEOUT_MS / 1000}s — process did not respond`,
      });
    }, TIMEOUT_MS);

    const proc = spawn(command, args, {
      env: { ...process.env, NODE_PATH: nodePath, ...resolvedEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    // Step 1: initialize (id=1)
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'slackhive-test', version: '1.0.0' },
        },
      }) + '\n',
    );

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      const newlineIdx = stdout.lastIndexOf('\n');
      if (newlineIdx === -1) return;
      const completeChunk = stdout.slice(0, newlineIdx);
      stdout = stdout.slice(newlineIdx + 1);

      for (const line of completeChunk.split('\n')) {
        if (!line.trim()) continue;
        let msg: {
          id?: number;
          result?: {
            serverInfo?: { name?: string };
            tools?: Array<{ name: string; description?: string }>;
          };
          error?: { message?: string };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (msg.id === 1) {
          if (msg.error) {
            finish({ ok: false, tools: [], error: msg.error.message ?? 'MCP error' });
            return;
          }
          serverName = msg.result?.serverInfo?.name ?? name;
          proc.stdin.write(
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
          );
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        } else if (msg.id === 2) {
          if (msg.error) {
            finish({ ok: true, tools: [], toolsListUnsupported: true, serverName });
          } else {
            const tools: McpTool[] = (msg.result?.tools ?? []).map((t) => ({
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
            }));
            finish({ ok: true, tools, serverName });
          }
        }
      }
    });

    proc.on('error', (err) => {
      finish({
        ok: false,
        tools: [],
        error: `Failed to start: ${err.message}${stderr ? ` — ${stderr.trim()}` : ''}`,
      });
    });

    proc.on('exit', (code) => {
      finish({
        ok: false,
        tools: [],
        error: `Process exited with code ${code}${stderr ? ` — ${stderr.trim()}` : ''}`,
      });
    });
  });
}

// ─── Streamable HTTP transport ────────────────────────────────────────────────

async function listStreamableHttpMcpTools(
  cfg: McpSseConfig & { envRefs?: Record<string, string> },
  name: string,
): Promise<ListMcpToolsResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(cfg.headers ?? {}),
  };
  if (cfg.envRefs && Object.keys(cfg.envRefs).length > 0) {
    try {
      const envVarValues = await getEnvVarValues();
      for (const [headerKey, storeKey] of Object.entries(cfg.envRefs)) {
        const val = envVarValues[storeKey];
        if (val) headers[headerKey] = headers[headerKey] ? `${headers[headerKey]}${val}` : val;
      }
    } catch {
      /* env vars unavailable — continue without */
    }
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
      if (initRes.status === 404 || initRes.status === 405) {
        return {
          ok: false,
          tools: [],
          error: `HTTP ${initRes.status} on POST — server may be using the deprecated HTTP+SSE transport (not supported).`,
        };
      }
      return { ok: false, tools: [], error: `HTTP ${initRes.status}: ${initRes.statusText}` };
    }

    const sessionId = initRes.headers.get('mcp-session-id');
    const initMsg = await readJsonRpcResponse(initRes, 1);
    if (initMsg.error) {
      return {
        ok: false,
        tools: [],
        error: initMsg.error.message ?? 'MCP error during initialize',
      };
    }
    const serverName = initMsg.result?.serverInfo?.name ?? name;

    const sessionHeaders = sessionId ? { ...headers, 'Mcp-Session-Id': sessionId } : headers;

    // 2. notifications/initialized
    const notifyRes = await fetch(cfg.url, {
      method: 'POST',
      headers: sessionHeaders,
      signal,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    if (!notifyRes.ok && notifyRes.status !== 202) {
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
      return { ok: false, tools: [], error: 'Session expired (HTTP 404) after initialize' };
    }
    if (!toolsRes.ok) {
      return { ok: true, tools: [], toolsListUnsupported: true, serverName };
    }
    const toolsMsg = await readJsonRpcResponse(toolsRes, 2);
    if (toolsMsg.error) {
      return { ok: true, tools: [], toolsListUnsupported: true, serverName };
    }
    const tools: McpTool[] = ((toolsMsg.result?.tools ?? []) as Array<{
      name: string;
      description?: string;
    }>).map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
    }));
    return { ok: true, tools, serverName };
  } catch (err) {
    return { ok: false, tools: [], error: (err as Error).message };
  }
}

async function readJsonRpcResponse(
  res: Response,
  expectedId: number,
): Promise<{
  id?: number;
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string; description?: string }>;
  };
  error?: { message?: string };
}> {
  const contentType = res.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
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
      } catch {
        /* skip frames that aren't JSON-RPC */
      }
    }
    throw new Error(`No JSON-RPC response with id=${expectedId} in SSE stream`);
  }

  return res.json();
}
