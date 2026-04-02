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
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpStdioConfig } from '@slackhive/shared';
import { agentLogger } from './logger.js';
import type { Logger } from 'winston';

interface ManagedProxy {
  client: Client;
  httpServer: http.Server;
  port: number;
  url: string;
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

    // For inline TypeScript source, write to disk first
    let command = config.command;
    let args = config.args ?? [];
    if (config.tsSource) {
      const scriptDir = path.join(this.workDir, '.mcp-scripts');
      const scriptPath = path.join(scriptDir, `${name}.ts`);
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(scriptPath, config.tsSource as string, 'utf8');
      command = '/app/node_modules/.bin/tsx';
      args = [scriptPath];
      env.NODE_PATH = '/app/node_modules';
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

    // Build a proxy MCP Server that forwards calls to the client
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

    // Serve the proxy over SSE on a local port
    const port = this.nextPort++;
    const sseTransports = new Map<string, SSEServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/sse') {
          const sseTransport = new SSEServerTransport('/message', res);
          sseTransports.set(sseTransport.sessionId, sseTransport);
          res.on('close', () => sseTransports.delete(sseTransport.sessionId));
          await proxyServer.connect(sseTransport);
        } else if (req.method === 'POST' && req.url?.startsWith('/message')) {
          const sessionId = new URL(req.url, `http://127.0.0.1:${port}`).searchParams.get('sessionId') ?? '';
          const sseTransport = sseTransports.get(sessionId);
          if (sseTransport) {
            await sseTransport.handlePostMessage(req, res);
          } else {
            res.writeHead(404).end('Session not found');
          }
        } else {
          res.writeHead(404).end();
        }
      } catch (err) {
        this.log.error('MCP proxy HTTP error', { server: name, error: (err as Error).message });
        if (!res.headersSent) res.writeHead(500).end();
      }
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', resolve);
    });

    const url = `http://127.0.0.1:${port}/sse`;
    this.proxies.set(name, { client, httpServer, port, url });
    this.log.info('MCP proxy listening', { server: name, url });

    return url;
  }

  /** Returns the SSE URL for a running proxy, or undefined if not started. */
  getUrl(name: string): string | undefined {
    return this.proxies.get(name)?.url;
  }

  /** Stops and cleans up a single MCP proxy. */
  async stopServer(name: string): Promise<void> {
    const proxy = this.proxies.get(name);
    if (!proxy) return;
    this.proxies.delete(name);
    await proxy.client.close().catch(() => {});
    await new Promise<void>((resolve) => proxy.httpServer.close(() => resolve()));
    this.log.info('MCP proxy stopped', { server: name });
  }

  /** Stops all running MCP proxies. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.proxies.keys()].map((name) => this.stopServer(name)));
  }
}
