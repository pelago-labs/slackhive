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
import { DEFAULT_CODEX_MODEL, agentIdentityBody, splitCodexModel, type CodexReasoningEffort } from '@slackhive/shared';

/** 1 MiB — generous so the inlined-memory AGENTS.md is never truncated (Codex default is 32 KiB). */
const PROJECT_DOC_MAX_BYTES = 1_048_576;

// Mirrors the SDK's (non-exported) CodexConfigObject so values aren't `unknown`.
type ConfigValue = string | number | boolean | ConfigValue[] | { [k: string]: ConfigValue };
export type ConfigObj = { [k: string]: ConfigValue };

/**
 * Base Codex client config shared by every entry point (agents, coach, one-shot
 * generators). Forces file-based auth so `~/.codex/auth.json` works identically
 * on macOS and Linux. buildCodexConfig() extends this with MCP/persona/doc knobs;
 * lightweight callers (coach, generate-text) use it directly.
 */
export function baseCodexConfig(): ConfigObj {
  return {
    cli_auth_credentials_store: 'file',
    // Compact the conversation well before the real context ceiling. Codex's
    // auto-compaction is unreliable on GPT-5.5 — the effective window is ~258K
    // (272K × 95%) while the catalog can claim 400K/1M, so a long thread
    // overflows BEFORE compaction triggers ("ran out of room in the model's
    // context window"; see openai/codex#19409, #19842). 220K sits safely under
    // every GPT-5.x window, so compaction fires in time on long Slack threads.
    model_auto_compact_token_limit: 220_000,
  };
}

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
export async function createCodexClient(config: ConfigObj, apiKey?: string, env?: Record<string, string>): Promise<CodexClient> {
  const { Codex } = await import('@openai/codex-sdk');
  const key = apiKey ?? codexApiKeyFromEnv();
  return new Codex({
    ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
    ...(key ? { apiKey: key } : {}),
    // The SDK does NOT inherit process.env when `env` is set, so callers pass a
    // complete env ({ ...process.env, ...agentVars }). Used so session-scoped MCP
    // servers (see isSessionScopedServer) can forward agent secrets via `env_vars`
    // in their project .codex/config.toml instead of writing them to disk.
    ...(env ? { env } : {}),
    config,
  });
}

/**
 * Resolve the effective Codex model id from a stored setting: strip any
 * `:<effort>` reasoning suffix (see splitCodexModel), fall back to the default
 * when unset, and guard against a Claude model id leaking in from a backend
 * switch (the agent's `model` column holds a Claude id).
 */
export function resolveCodexModel(stored: string | null | undefined): string {
  const { model } = splitCodexModel(stored ?? DEFAULT_CODEX_MODEL);
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
 *
 * NOTE: persona/identity is NOT set here. The SDK's `config` is only
 * `--config key=value` CLI overrides, and Codex has no `developer_instructions`
 * key (it's silently dropped). The persona is instead prepended to each turn's
 * prompt in CodexBackend (see `buildIdentityInstructions`), the one channel the
 * model reliably honors.
 */
export function buildCodexConfig(
  mcpServers: McpServer[],
  envVarValues: Record<string, string>,
  proxyUrlFor: (name: string) => string | undefined,
): ConfigObj {
  const config: ConfigObj = {
    ...baseCodexConfig(),
    project_doc_max_bytes: PROJECT_DOC_MAX_BYTES,
    memories: { use_memories: false },
  };
  const mcp = buildMcpServers(mcpServers, envVarValues, proxyUrlFor);
  if (Object.keys(mcp).length > 0) config.mcp_servers = mcp;
  return config;
}

/**
 * Always-on capability note prepended to every Codex turn. Codex exposes a built-in
 * image-generation tool that has no config disable, but the SDK surfaces no image
 * *output* item — so any image the model produces is silently dropped and never
 * reaches Slack (the model then falsely claims it attached one). Tell the model up
 * front it can't deliver images so it declines instead of wasting a (billable) call.
 * Reading/describing images the user attaches is unaffected.
 */
export const CODEX_CAPABILITY_NOTE =
  'Capability limit: you cannot produce images. Image generation/editing is unavailable here and any image you create will NOT reach the user. If asked to generate, edit, annotate, or highlight an image, say you are unable to and offer a text-based alternative. (You can still read and describe images the user attaches.)';

/**
 * Build the identity/persona block prepended to each Codex turn's prompt so the
 * agent adopts its voice. Codex's base "you are a coding agent" prompt outranks
 * the AGENTS.md project doc, and the SDK exposes no system/developer channel —
 * so the only reliable place is the prompt itself (conversation priority).
 * Mirrors the Identity section compile-instructions writes atop AGENTS.md.
 * Returns '' when the agent has no persona/description (nothing to assert).
 */
export function buildIdentityInstructions(agent: { name: string; persona?: string | null; description?: string | null }): string {
  const body = agentIdentityBody(agent);
  if (!body) return '';
  return `You are ${agent.name}. Respond fully in character — match this persona's voice, tone, and style in every message, not a generic assistant voice. Follow the detailed instructions in AGENTS.md.\n\n${body}`;
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
  reasoningEffort?: CodexReasoningEffort;
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
    ...(opts.reasoningEffort && { modelReasoningEffort: opts.reasoningEffort }),
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
 * A server is "session-scoped" when its inline-TS source reads SESSION_WORK_DIR —
 * i.e. it keeps per-thread state on disk (e.g. git.ts clones into
 * `$SESSION_WORK_DIR/repos`). The shared client/proxy can't give it a per-session
 * cwd, so these are NOT registered globally; instead CodexBackend writes a
 * per-session `.codex/config.toml` (project-scoped, with cwd + env = the session
 * dir) so Codex spawns one per thread. Stateless API servers stay shared.
 */
export function isSessionScopedServer(s: McpServer): boolean {
  const ts = (s.config as { tsSource?: unknown }).tsSource;
  return typeof ts === 'string' && ts.includes('SESSION_WORK_DIR');
}

/**
 * True if a Codex `config.toml` already declares a `[projects."<dir>"]` table for
 * `dir`, matching either TOML string form (basic `"..."` or literal `'...'`) so a
 * caller never appends a SECOND table for the same project — a duplicate TOML table
 * makes Codex's strict parser reject the whole config. Header-only scan (we don't
 * rewrite the file), so it's robust to quoting without clobbering Codex's own edits.
 */
export function tomlDeclaresProject(toml: string, dir: string): boolean {
  // [projects.<key>] on its own line, <key> a basic ("...") or literal ('...') string.
  // TOML allows whitespace inside the brackets and around the dotted-key dot, so we
  // tolerate it — a false negative here would risk appending a duplicate table.
  const re = /^[ \t]*\[[ \t]*projects[ \t]*\.[ \t]*("(?:[^"\\]|\\.)*"|'[^']*')[ \t]*\][ \t]*$/gm;
  const canonical = JSON.stringify(dir); // how this module emits the header's key
  let m: RegExpExecArray | null;
  while ((m = re.exec(toml)) !== null) {
    const tok = m[1];
    if (tok === canonical) return true; // exact form we'd write — also the fail-safe below
    if (tok[0] === "'") { if (tok.slice(1, -1) === dir) return true; continue; } // literal — verbatim
    // basic string — TOML basic escapes are a subset of JSON's, so JSON.parse unescapes it.
    // If it can't parse (e.g. TOML's \UXXXXXXXX, which JSON rejects), the exact-form
    // check above already covered our own entries; skip foreign ones we can't decode.
    try { if ((JSON.parse(tok) as string) === dir) return true; } catch { /* undecodable foreign key */ }
  }
  return false;
}

/**
 * The secrets that session-scoped MCP servers need, keyed by the var name the
 * server actually reads (the envRefs *subKey*) — NOT the platform store key. These
 * (and only these — not the agent's whole decrypted store) are placed into
 * codex-exec's env so the per-session `.codex/config.toml`'s `env_vars` can forward
 * them. Keying by subKey is what makes the forward resolve when envRefs remaps a
 * name (e.g. { GIT_TOKEN: "my-github-secret" }).
 */
export function sessionScopedSecrets(
  servers: McpServer[],
  envVarValues: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of servers) {
    if (!isSessionScopedServer(s)) continue;
    const refs = ((s.config as { envRefs?: Record<string, string> }).envRefs) ?? {};
    for (const [subKey, storeKey] of Object.entries(refs)) {
      const val = envVarValues[storeKey];
      if (val !== undefined) out[subKey] = val;
    }
  }
  return out;
}

/**
 * Translate SlackHive MCP servers into Codex `[mcp_servers.NAME]` config entries.
 * - Remote HTTP/SSE servers → passthrough url + resolved headers.
 * - stdio servers (incl. inline-TS) → the local proxy's Streamable-HTTP URL, so
 *   the proxy (empty client capabilities) shields elicitation and the server
 *   behaves headlessly. Falls back to direct stdio spawn if no proxy is up.
 * Session-scoped servers are skipped here — they're written per-session instead.
 */
function buildMcpServers(
  servers: McpServer[],
  envVarValues: Record<string, string>,
  proxyUrlFor: (name: string) => string | undefined,
): ConfigObj {
  const out: ConfigObj = {};
  for (const s of servers) {
    if (isSessionScopedServer(s)) continue; // registered per-session, not globally
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
