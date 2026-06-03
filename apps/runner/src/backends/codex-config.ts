/**
 * @fileoverview Pure helpers that map SlackHive's agent config onto the Codex
 * SDK: constructor-level `config` (per-agent MCP servers, doc/memory/auth knobs)
 * and per-thread `ThreadOptions` (sandbox, approval, model, web search). Kept
 * separate from the backend class so the parity mapping is easy to read/test.
 *
 * @module runner/backends/codex-config
 */

import type { Codex as CodexClient, ThreadOptions } from '@openai/codex-sdk';
import type { McpServer, McpStdioConfig, Permission } from '@slackhive/shared';
import { DEFAULT_CODEX_MODEL } from '@slackhive/shared';

/** 1 MiB — generous so the inlined-memory AGENTS.md is never truncated (Codex default is 32 KiB). */
const PROJECT_DOC_MAX_BYTES = 1_048_576;

// Mirrors the SDK's (non-exported) CodexConfigObject so values aren't `unknown`.
type ConfigValue = string | number | boolean | ConfigValue[] | { [k: string]: ConfigValue };
export type ConfigObj = { [k: string]: ConfigValue };

// ── Client + model (the one place that knows how to build a Codex client) ─────

/** Codex API key from env — subscription auth omits it (uses ~/.codex/auth.json). */
export function codexApiKeyFromEnv(): string | undefined {
  return process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || undefined;
}

/**
 * Construct the Codex client. Single source of truth for wiring
 * `codexPathOverride` (host binary), the API key (subscription omits it), and the
 * constructor `config` — shared by the backend, Coach, and the one-shot generator
 * so none of them re-implement the plumbing. ESM-only package → dynamic import.
 */
export async function createCodexClient(config: ConfigObj, apiKey?: string): Promise<CodexClient> {
  const { Codex } = await import('@openai/codex-sdk');
  const key = apiKey ?? codexApiKeyFromEnv();
  return new Codex({
    ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
    ...(key ? { apiKey: key } : {}),
    config,
  });
}

/**
 * Resolve the effective Codex model id from a stored setting: fall back to the
 * default when unset, and guard against a Claude model id leaking in from a
 * backend switch (the agent's `model` column holds a Claude id).
 */
export function resolveCodexModel(stored: string | null | undefined): string {
  const model = stored ?? DEFAULT_CODEX_MODEL;
  return /^claude/i.test(model) ? DEFAULT_CODEX_MODEL : model;
}

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
 *
 * `proxyUrlFor(name)` returns the local proxy's Streamable-HTTP URL for a stdio
 * server (the elicitation shield); stdio servers are wired to that URL so they
 * behave headlessly like they do under the Claude Agent SDK.
 */
export function buildCodexConfig(
  mcpServers: McpServer[],
  envVarValues: Record<string, string>,
  proxyUrlFor: (name: string) => string | undefined,
): ConfigObj {
  const config: ConfigObj = {
    cli_auth_credentials_store: 'file',
    project_doc_max_bytes: PROJECT_DOC_MAX_BYTES,
    memories: { use_memories: false },
  };
  const mcp = buildMcpServers(mcpServers, envVarValues, proxyUrlFor);
  if (Object.keys(mcp).length > 0) config.mcp_servers = mcp;
  return config;
}

/**
 * Per-thread options — the Codex equivalent of `buildSdkOptions`.
 *
 * sandboxMode is `danger-full-access` (with approvalPolicy `never`) because Codex
 * cancels MCP tool calls under the managed `workspace-write`/`read-only` sandboxes
 * in headless `exec` mode — it hits an interactive user-input/elicitation path that
 * exec can't service (known upstream bug: openai/codex#16685). This is also parity
 * with SlackHive's Claude path, which runs with no OS sandbox (its confinement is
 * the Bash command denylist + the Read/Write path-scope hook). cwd stays the
 * per-session workdir so the agent naturally operates there.
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
    sandboxMode: 'danger-full-access',
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

/**
 * Translate SlackHive MCP servers into Codex `[mcp_servers.NAME]` config entries.
 * - Remote HTTP/SSE servers → passthrough url + resolved headers.
 * - stdio servers (incl. inline-TS) → the local proxy's Streamable-HTTP URL, so
 *   the proxy (empty client capabilities) shields elicitation and the server
 *   behaves headlessly. Falls back to direct stdio spawn if no proxy is up.
 */
function buildMcpServers(
  servers: McpServer[],
  envVarValues: Record<string, string>,
  proxyUrlFor: (name: string) => string | undefined,
): ConfigObj {
  const out: ConfigObj = {};
  for (const s of servers) {
    const c = s.config as McpStdioConfig & Record<string, unknown>;

    // Remote HTTP / SSE transport → url + static headers
    const urlVal = (c as { url?: string }).url;
    if (s.type === 'http' || s.type === 'sse' || typeof urlVal === 'string') {
      const entry: ConfigObj = { url: String(urlVal ?? '') };
      const headers = resolveHeaders(c, envVarValues);
      if (Object.keys(headers).length > 0) entry.http_headers = headers;
      out[s.name] = entry;
      continue;
    }

    // stdio (incl. inline-TS) → route through the local proxy.
    const proxyUrl = proxyUrlFor(s.name);
    if (proxyUrl) {
      out[s.name] = { url: proxyUrl };
      continue;
    }

    // Fallback: proxy unavailable → let Codex spawn the stdio server directly.
    const entry: ConfigObj = { command: String(c.command ?? '') };
    if (Array.isArray(c.args)) entry.args = (c.args as unknown[]).map(String);
    const env = resolveEnvRefs(c, envVarValues);
    if (Object.keys(env).length > 0) entry.env = env;
    out[s.name] = entry;
  }
  return out;
}
