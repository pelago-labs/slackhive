/**
 * @fileoverview MCP server connectivity test endpoint.
 *
 * POST /api/mcps/[id]/test
 *
 * For stdio MCPs: spawns the process, sends an MCP initialize request over
 * stdin/stdout, and verifies the server responds with a valid JSON-RPC result.
 * Times out after 10 seconds.
 *
 * For SSE/HTTP MCPs: sends a GET request to the configured URL and checks
 * for a 2xx response.
 *
 * @module web/api/mcps/[id]/test
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMcpServerById, getEnvVarValues } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import { spawn } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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

    // SSE / HTTP — just check the URL is reachable
    const cfg = server.config as McpSseConfig & { envRefs?: Record<string, string> };
    const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
    if (cfg.envRefs && Object.keys(cfg.envRefs).length > 0) {
      try {
        const envVarValues = await getEnvVarValues();
        for (const [headerKey, storeKey] of Object.entries(cfg.envRefs)) {
          const val = envVarValues[storeKey];
          if (val) headers[headerKey] = headers[headerKey] ? `${headers[headerKey]}${val}` : val;
        }
      } catch { /* skip if env vars unavailable */ }
    }
    const res = await fetch(cfg.url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok || res.status === 405) {
      // 405 Method Not Allowed is fine — the endpoint exists
      return NextResponse.json({ ok: true, message: `Reachable (HTTP ${res.status})` });
    }
    return NextResponse.json({ ok: false, error: `HTTP ${res.status}: ${res.statusText}` });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message });
  }
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
    command = 'tsx';
    args = [tmpScript];
  } else {
    command = cfg.command;
    args = cfg.args ?? [];
  }

  const cleanup = () => { if (tmpScript) unlink(tmpScript).catch(() => {}); };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        cleanup();
        resolve({ ok: false, error: `Timed out after ${TIMEOUT_MS / 1000}s — process did not respond` });
      }
    }, TIMEOUT_MS);

    const proc = spawn(command, args, {
      env: { ...process.env, NODE_PATH: '/app/node_modules', ...resolvedEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'slackhive-test', version: '1.0.0' },
      },
    }) + '\n';

    proc.stdin.write(initRequest);

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      const lines = stdout.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } }; error?: { message?: string } };
          if (msg.id === 1) {
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              proc.kill();
              cleanup();
              if (msg.error) {
                resolve({ ok: false, error: msg.error.message ?? 'MCP error' });
              } else {
                const serverName = msg.result?.serverInfo?.name ?? name;
                resolve({ ok: true, message: `Connected to "${serverName}" successfully` });
              }
            }
          }
        } catch {
          // incomplete line, keep buffering
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ ok: false, error: `Failed to start: ${err.message}${stderr ? ` — ${stderr.trim()}` : ''}` });
      }
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        cleanup();
        resolve({
          ok: false,
          error: `Process exited with code ${code}${stderr ? ` — ${stderr.trim()}` : ''}`,
        });
      }
    });
  });
}
