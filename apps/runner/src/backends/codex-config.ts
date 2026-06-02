/**
 * @fileoverview Pure helpers that map SlackHive's agent config onto the Codex
 * SDK: constructor-level `config` (per-agent MCP servers, doc/memory/auth knobs)
 * and per-thread `ThreadOptions` (sandbox, approval, model, web search). Kept
 * separate from the backend class so the parity mapping is easy to read/test.
 *
 * @module runner/backends/codex-config
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ThreadOptions } from '@openai/codex-sdk';
import type { McpServer, McpStdioConfig, Permission } from '@slackhive/shared';

/** 1 MiB — generous so the inlined-memory AGENTS.md is never truncated (Codex default is 32 KiB). */
const PROJECT_DOC_MAX_BYTES = 1_048_576;

// Mirrors the SDK's (non-exported) CodexConfigObject so values aren't `unknown`.
type ConfigValue = string | number | boolean | ConfigValue[] | { [k: string]: ConfigValue };
type ConfigObj = { [k: string]: ConfigValue };

/** Whether the agent has any Bash permission (→ shell commands need network for npm/git/pip). */
export function agentHasBash(permissions: Permission | null): boolean {
  const allowed = permissions?.allowedTools ?? [];
  return allowed.some((t) => t === 'Bash' || t.startsWith('Bash('));
}

/**
 * Constructor-level Codex `config` (flattened to dotted `--config` TOML by the SDK).
 * Carries the per-agent-stable settings: MCP servers, doc size, disabling Codex's
 * native memory (SlackHive manages memory), and forcing file-based auth so
 * `~/.codex/auth.json` works identically on macOS and Linux/Ubuntu.
 */
export function buildCodexConfig(
  mcpServers: McpServer[],
  envVarValues: Record<string, string>,
  workDir: string,
): ConfigObj {
  const config: ConfigObj = {
    cli_auth_credentials_store: 'file',
    project_doc_max_bytes: PROJECT_DOC_MAX_BYTES,
    memories: { use_memories: false },
  };
  const mcp = buildMcpServers(mcpServers, envVarValues, workDir);
  if (Object.keys(mcp).length > 0) config.mcp_servers = mcp;
  return config;
}

/**
 * Per-thread options — the Codex equivalent of `buildSdkOptions`:
 * - acceptEdits → approvalPolicy:'never'
 * - path-scope hook → sandbox 'workspace-write' + cwd + additionalDirectories
 * - network only when the agent has Bash (npm/git/pip need it); web search always on
 */
export function buildThreadOptions(opts: {
  sessionWorkDir: string;
  workDir: string;
  model: string;
  networkAccess: boolean;
}): ThreadOptions {
  return {
    workingDirectory: opts.sessionWorkDir,
    skipGitRepoCheck: true,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    additionalDirectories: [opts.workDir],
    networkAccessEnabled: opts.networkAccess,
    webSearchEnabled: true,
    webSearchMode: 'live',
    model: opts.model,
  };
}

// ── MCP translation ─────────────────────────────────────────────────────────

function resolveEnvRefs(c: Record<string, unknown>, envVarValues: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...((c.env as Record<string, string>) ?? {}) };
  const refs = (c.envRefs ?? {}) as Record<string, string>;
  for (const [subKey, storeKey] of Object.entries(refs)) {
    const v = envVarValues[storeKey];
    if (v !== undefined) merged[subKey] = v;
  }
  return merged;
}

function resolveHeaders(c: Record<string, unknown>, envVarValues: Record<string, string>): Record<string, string> {
  const headers = (c.headers as Record<string, string>) ?? {};
  const refs = (c.envRefs ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const envKey = refs[key];
    if (envKey && envVarValues[envKey]) out[key] = value ? `${value}${envVarValues[envKey]}` : envVarValues[envKey];
    else out[key] = value;
  }
  return out;
}

/** Find a runnable `tsx` for inline-TypeScript MCP servers (mirrors claude-backend). */
function resolveTsxPath(): string {
  const nmDirs: string[] = [];
  let cur = path.resolve(__dirname);
  while (cur !== path.dirname(cur)) {
    const nm = path.join(cur, 'node_modules');
    if (fs.existsSync(nm)) nmDirs.push(nm);
    cur = path.dirname(cur);
  }
  return nmDirs.map((nm) => path.join(nm, '.bin', 'tsx')).find((p) => fs.existsSync(p)) ?? 'tsx';
}

/** Translate SlackHive MCP servers into Codex `[mcp_servers.NAME]` config entries. */
function buildMcpServers(servers: McpServer[], envVarValues: Record<string, string>, workDir: string): ConfigObj {
  const out: ConfigObj = {};
  for (const s of servers) {
    const c = s.config as McpStdioConfig & Record<string, unknown>;

    // HTTP / SSE transport → url + static headers
    const urlVal = (c as { url?: string }).url;
    if (s.type === 'http' || s.type === 'sse' || typeof urlVal === 'string') {
      const entry: ConfigObj = { url: String(urlVal ?? '') };
      const headers = resolveHeaders(c, envVarValues);
      if (Object.keys(headers).length > 0) entry.http_headers = headers;
      out[s.name] = entry;
      continue;
    }

    // Inline TypeScript MCP → write to disk and run via tsx
    if (c.tsSource) {
      const scriptDir = path.join(workDir, '.mcp-scripts');
      const scriptPath = path.join(scriptDir, `${s.name}.ts`);
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(scriptPath, c.tsSource as string, 'utf8');
      const nodePath = (process.env.NODE_PATH ?? '');
      out[s.name] = {
        command: resolveTsxPath(),
        args: [scriptPath],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          NODE_PATH: nodePath,
          ...resolveEnvRefs(c, envVarValues),
        },
      };
      continue;
    }

    // stdio command server
    const entry: ConfigObj = { command: String(c.command ?? '') };
    if (Array.isArray(c.args)) entry.args = (c.args as unknown[]).map(String);
    const env = resolveEnvRefs(c, envVarValues);
    if (Object.keys(env).length > 0) entry.env = env;
    out[s.name] = entry;
  }
  return out;
}
