/**
 * @fileoverview Persistent MCP server manager.
 *
 * Keeps stdio MCP servers alive as long-running processes for the duration of
 * an agent's lifetime, rather than spawning fresh processes per query. Each
 * stdio MCP is proxied as a local SSE endpoint so the Claude Agent SDK can
 * connect to it via HTTP instead of spawning a new process every turn.
 *
 * Architecture:
 *   stdio MCP process ←→ Client (MCP SDK) ←→ ProxyServer ←→ SSE HTTP server
 *                                                               ↑
 *                                              Claude Agent SDK connects here
 *
 * @module runner/mcp-process-manager
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpStdioConfig } from '@slackhive/shared';
import { agentLogger } from './logger.js';
import type { Logger } from 'winston';

interface ManagedProxy {
  client: Client;
  httpServer: http.Server;
  port: number;
  /** SSE endpoint (Claude Agent SDK). */
  url: string;
  /** Streamable-HTTP endpoint (OpenAI Codex). */
  streamableUrl: string;
}

/** Read and JSON-parse a request body. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Manages persistent MCP server processes for a single agent.
 * Call `startAll()` when the agent starts, `stopAll()` when it stops.
 */
export class McpProcessManager {
  private readonly proxies = new Map<string, ManagedProxy>();
  private nextPort: number;
  private readonly log: Logger;
  private readonly workDir: string;

  constructor(agentSlug: string, workDir: string, basePort: number) {
    this.log = agentLogger(agentSlug);
    this.workDir = workDir;
    this.nextPort = basePort;
  }

  /**
   * Starts a persistent stdio MCP process and exposes it as an SSE proxy.
   * Returns the SSE URL to pass to the Claude Agent SDK.
   */
  async startServer(
    name: string,
    config: McpStdioConfig,
    envVarValues: Record<string, string> = {}
  ): Promise<string> {
    // Stop any existing proxy for this server
    await this.stopServer(name);

    // Build resolved environment
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(config.env ?? {}),
    };
    for (const [subKey, storeKey] of Object.entries((config.envRefs ?? {}) as Record<string, string>)) {
      if (envVarValues[storeKey] !== undefined) env[subKey] = envVarValues[storeKey];
    }
    // These MCP proxies are long-lived and shared across an agent's sessions, so
    // there's no per-session cwd to hand them (unlike the Claude SDK path, which
    // spawns inline-TS servers per query with a per-session SESSION_WORK_DIR).
    // Without it, session-aware servers like git.ts fall back to /tmp; default it
    // to the agent's persistent workDir so their state (e.g. cloned repos) lives
    // under ~/.slackhive/agents/<slug>/ instead of an ephemeral temp dir.
    if (!env.SESSION_WORK_DIR) env.SESSION_WORK_DIR = this.workDir;

    // For inline TypeScript source, write to disk first
    let command = config.command;
    let args = config.args ?? [];
    if (config.tsSource) {
      const scriptDir = path.join(this.workDir, '.mcp-scripts');
      const scriptPath = path.join(scriptDir, `${name}.ts`);
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(scriptPath, config.tsSource as string, 'utf8');
      // Walk up from __dirname to find every node_modules directory on the way
      // to the filesystem root. Handles both Docker (/app/node_modules) and
      // npm-workspace layouts (repo-root/node_modules with hoisted deps) on
      // Mac and Linux without guessing how many `../..` levels to use.
      const nmDirs: string[] = [];
      let cur = path.resolve(__dirname);
      while (cur !== path.dirname(cur)) {
        const nm = path.join(cur, 'node_modules');
        if (fs.existsSync(nm)) nmDirs.push(nm);
        cur = path.dirname(cur);
      }
      command = nmDirs
        .map(nm => path.join(nm, '.bin', 'tsx'))
        .find(p => fs.existsSync(p)) ?? 'tsx';
      args = [scriptPath];
      env.NODE_PATH = nmDirs.join(path.delimiter);
    }

    // Connect to the stdio MCP process
    const transport = new StdioClientTransport({ command, args, env });
    const client = new Client(
      { name: 'slackhive-proxy', version: '1.0.0' },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
    } catch (err) {
      this.log.error('Failed to connect to MCP server', { server: name, error: (err as Error).message });
      throw err;
    }

    this.log.info('MCP server connected', { server: name, command });

    const caps = client.getServerCapabilities() ?? {};

    // Build a fresh proxy MCP Server (forwarding to the shared upstream `client`)
    // for each transport. The SDK's Server/Protocol can only be connected to ONE
    // transport at a time — a second connect() throws "Already connected to a
    // transport". Codex opens a new Streamable-HTTP session per turn (and SSE +
    // HTTP can be live at once), so a single shared Server breaks on the second
    // connect. Minting one Server per transport sidesteps that; the upstream
    // `client` is shared and multiplexes concurrent requests over its own ids.
    const createProxyServer = (): Server => {
      const proxyServer = new Server(
        { name, version: '1.0.0' },
        { capabilities: caps }
      );
      if (caps.tools) {
        proxyServer.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
        proxyServer.setRequestHandler(CallToolRequestSchema, (req) =>
          client.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} })
        );
      }
      if (caps.resources) {
        proxyServer.setRequestHandler(ListResourcesRequestSchema, () => client.listResources());
        proxyServer.setRequestHandler(ReadResourceRequestSchema, (req) =>
          client.readResource({ uri: req.params.uri })
        );
      }
      if (caps.prompts) {
        proxyServer.setRequestHandler(ListPromptsRequestSchema, () => client.listPrompts());
        proxyServer.setRequestHandler(GetPromptRequestSchema, (req) =>
          client.getPrompt({ name: req.params.name, arguments: req.params.arguments })
        );
      }
      return proxyServer;
    };

    // Serve the proxy over SSE on a local port.
    // Use a mutable port holder so the closures reference the port actually bound
    // after the retry loop (not the first one we tried).
    const portRef = { port: this.nextPort };
    const sseTransports = new Map<string, SSEServerTransport>();
    // Streamable-HTTP sessions (Codex). Each gets its own proxy Server via
    // createProxyServer() — the SDK Server can't be shared across transports.
    const httpTransports = new Map<string, StreamableHTTPServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
      try {
        // ── SSE transport (Claude Agent SDK) ──────────────────────────────
        if (req.method === 'GET' && req.url === '/sse') {
          const sseTransport = new SSEServerTransport('/message', res);
          sseTransports.set(sseTransport.sessionId, sseTransport);
          res.on('close', () => sseTransports.delete(sseTransport.sessionId));
          await createProxyServer().connect(sseTransport);
        } else if (req.method === 'POST' && req.url?.startsWith('/message')) {
          const sessionId = new URL(req.url, `http://127.0.0.1:${portRef.port}`).searchParams.get('sessionId') ?? '';
          const sseTransport = sseTransports.get(sessionId);
          if (sseTransport) {
            await sseTransport.handlePostMessage(req, res);
          } else {
            res.writeHead(404).end('Session not found');
          }

        // ── Streamable-HTTP transport (Codex) ─────────────────────────────
        // The proxy connects to the real MCP server with empty client
        // capabilities (no elicitation), so eliciting servers return data
        // directly — matching how MCP behaves under the Claude Agent SDK.
        } else if (req.url?.startsWith('/mcp')) {
          const sessionId = req.headers['mcp-session-id'] as string | undefined;
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            let transport = sessionId ? httpTransports.get(sessionId) : undefined;
            if (!transport && isInitializeRequest(body)) {
              transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => { httpTransports.set(sid, transport!); },
              });
              transport.onclose = () => { if (transport!.sessionId) httpTransports.delete(transport!.sessionId); };
              await createProxyServer().connect(transport);
            }
            if (!transport) { res.writeHead(400).end('No valid MCP session'); return; }
            await transport.handleRequest(req, res, body);
          } else if (req.method === 'GET' || req.method === 'DELETE') {
            const transport = sessionId ? httpTransports.get(sessionId) : undefined;
            if (!transport) { res.writeHead(400).end('No valid MCP session'); return; }
            await transport.handleRequest(req, res);
          } else {
            res.writeHead(405).end();
          }
        } else {
          res.writeHead(404).end();
        }
      } catch (err) {
        this.log.error('MCP proxy HTTP error', { server: name, error: (err as Error).message });
        if (!res.headersSent) res.writeHead(500).end();
      }
    });

    // Bind the HTTP server on a free port, walking forward on EADDRINUSE.
    // This handles two common cases:
    //   1. TCP TIME_WAIT — ports stay bound for ~60s after a runner crash or stop.
    //   2. slug-hash collisions between agents — two agents share a basePort,
    //      the second just takes the next free slot.
    // Scan size matches the per-agent slot width from claude-handler.ts (basePort + 50).
    const MAX_PORT_TRIES = 50;
    const startPort = this.nextPort;
    let boundPort = -1;
    let lastErr: Error | null = null;

    for (let i = 0; i < MAX_PORT_TRIES; i++) {
      const candidate = startPort + i;
      try {
        await new Promise<void>((resolve, reject) => {
          const onErr = (e: Error) => { httpServer.off('listening', onOk); reject(e); };
          const onOk = () => { httpServer.off('error', onErr); resolve(); };
          httpServer.once('error', onErr);
          httpServer.once('listening', onOk);
          httpServer.listen(candidate, '127.0.0.1');
        });
        boundPort = candidate;
        break;
      } catch (err) {
        lastErr = err as Error;
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
        this.log.warn('MCP port in use, retrying on next', { server: name, port: candidate });
      }
    }

    if (boundPort === -1) {
      throw new Error(
        `No free port in range ${startPort}..${startPort + MAX_PORT_TRIES - 1} for MCP "${name}": ${lastErr?.message ?? 'unknown'}`,
      );
    }

    portRef.port = boundPort;
    this.nextPort = boundPort + 1; // advance past the bound port for the next server in this agent

    const url = `http://127.0.0.1:${boundPort}/sse`;
    const streamableUrl = `http://127.0.0.1:${boundPort}/mcp`;
    this.proxies.set(name, { client, httpServer, port: boundPort, url, streamableUrl });
    this.log.info('MCP proxy listening', { server: name, url, streamableUrl });

    return url;
  }

  /** Returns the SSE URL for a running proxy, or undefined if not started. */
  getUrl(name: string): string | undefined {
    return this.proxies.get(name)?.url;
  }

  /** Returns the Streamable-HTTP URL (for Codex) for a running proxy. */
  getStreamableUrl(name: string): string | undefined {
    return this.proxies.get(name)?.streamableUrl;
  }

  /** Stops and cleans up a single MCP proxy. */
  async stopServer(name: string): Promise<void> {
    const proxy = this.proxies.get(name);
    if (!proxy) return;
    this.proxies.delete(name);
    await proxy.client.close().catch(() => {});
    // closeAllConnections drops dangling SSE sockets so httpServer.close
    // resolves promptly. Without it, a wedged consumer (e.g. a stuck Claude
    // SDK subprocess holding the stream open) can pin teardown indefinitely.
    proxy.httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => proxy.httpServer.close(() => resolve()));
    this.log.info('MCP proxy stopped', { server: name });
  }

  /** Stops all running MCP proxies. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.proxies.keys()].map((name) => this.stopServer(name)));
  }
}
