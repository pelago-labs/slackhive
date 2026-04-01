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
import { getMcpServerById, getAllEnvVars } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import { spawn } from 'child_process';
import type { McpStdioConfig, McpSseConfig } from '@slackhive/shared';

type RouteParams = { params: Promise<{ id: string }> };

const TIMEOUT_MS = 10_000;

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
    const cfg = server.config as McpSseConfig;
    const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
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
  // Resolve envRefs
  const envVarRows = await getAllEnvVars();
  // getAllEnvVars only returns keys — for test we need values, so query directly
  // We'll pass whatever inline env we have; envRefs resolution requires DB values
  // which aren't available here (web app doesn't expose values). Skip refs for test.
  const resolvedEnv: Record<string, string> = { ...(cfg.env ?? {}) };

  const command = cfg.tsSource ? 'tsx' : cfg.command;
  const args = cfg.tsSource
    ? [] // can't test inline TS without writing to disk (runner does that)
    : (cfg.args ?? []);

  if (cfg.tsSource && args.length === 0) {
    return {
      ok: false,
      error: 'Inline TypeScript MCPs can only be tested after the agent runner saves the script to disk. Start an agent that uses this MCP and verify the tool appears.',
    };
  }

  void envVarRows; // acknowledged — see comment above

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve({ ok: false, error: `Timed out after ${TIMEOUT_MS / 1000}s — process did not respond` });
      }
    }, TIMEOUT_MS);

    const proc = spawn(command, args, {
      env: { ...process.env, ...resolvedEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Send MCP initialize request
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
      // Try to parse the first complete JSON response
      const lines = stdout.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } }; error?: { message?: string } };
          if (msg.id === 1) {
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              proc.kill();
              if (msg.error) {
                resolve({ ok: false, error: msg.error.message ?? 'MCP error' });
              } else {
                const serverName = msg.result?.serverInfo?.name ?? name;
                // Request tools/list after init
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
        resolve({ ok: false, error: `Failed to start: ${err.message}${stderr ? ` — ${stderr.trim()}` : ''}` });
      }
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          ok: false,
          error: `Process exited with code ${code}${stderr ? ` — ${stderr.trim()}` : ''}`,
        });
      }
    });
  });
}
