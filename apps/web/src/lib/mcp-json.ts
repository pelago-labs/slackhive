/**
 * @fileoverview Paste-JSON helper for the MCP server editor.
 *
 * Converts between the Cursor / Claude Desktop / VS Code `mcpServers` JSON shape
 * and SlackHive's internal {@link McpServerConfig}. Supports `${env:NAME}`
 * substitution, which maps to the platform env-var store via the `envRefs` dict
 * that the runner resolves at spawn time.
 *
 * This runs entirely client-side. The backend never sees `${env:...}` tokens —
 * they're translated into the existing `envRefs` shape before the POST/PATCH.
 *
 * @module web/lib/mcp-json
 */

import type { McpServerConfig } from '@slackhive/shared';

/** The masked placeholder the API returns in place of real secrets. */
const MASK = '********';

/** Matches `${env:NAME}` with an optional prefix (e.g. `"Bearer ${env:TOKEN}"`). */
const ENV_REF_RE = /^(.*)\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Matches any `${env:NAME}` anywhere in a string — used to detect unsupported mid-string refs. */
const ENV_REF_ANY_RE = /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/;

export type ParseResult =
  | { ok: true; name: string | null; config: McpServerConfig; warnings: string[] }
  | { ok: false; error: string; line?: number };

/**
 * Parse a pasted JSON config string into a SlackHive {@link McpServerConfig}.
 *
 * Accepts two shapes:
 *  - Wrapped: `{ "mcpServers": { "<name>": { ... } } }` — the name comes from the key.
 *  - Bare: `{ "command": "...", ... }` — name comes back as `null` (caller supplies it).
 *
 * Inside any `env` or `headers` value, `${env:NAME}` is lifted into `envRefs`.
 * Literal `"********"` values are omitted — they signal "unchanged" and the
 * server-side `mergeMcpConfig()` helper fills them from the stored row.
 *
 * @param input Raw textarea contents.
 */
export function parseMcpJson(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Config is empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = (err as Error).message;
    const line = extractLine(trimmed, msg);
    return { ok: false, error: msg, line };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Top-level value must be a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;
  const warnings: string[] = [];
  let name: string | null = null;
  let serverRaw: Record<string, unknown>;

  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    const entries = Object.entries(obj.mcpServers as Record<string, unknown>);
    if (entries.length === 0) return { ok: false, error: '`mcpServers` block is empty' };
    if (entries.length > 1) warnings.push(`Only the first server ("${entries[0][0]}") was used — ignored ${entries.length - 1} others.`);
    const [firstName, firstVal] = entries[0];
    if (!firstVal || typeof firstVal !== 'object' || Array.isArray(firstVal)) {
      return { ok: false, error: `Server "${firstName}" is not an object` };
    }
    name = firstName;
    serverRaw = firstVal as Record<string, unknown>;
  } else {
    serverRaw = obj;
  }

  const result = translateServer(serverRaw);
  if (!result.ok) return result;
  return { ok: true, name, config: result.config, warnings: [...warnings, ...result.warnings] };
}

/**
 * Serialize a SlackHive config back into the Cursor-compatible JSON shape.
 * `envRefs` entries become `${env:NAME}` (or `"<prefix>${env:NAME}"` for
 * prefixed header refs). Masked secrets are preserved as `"********"` so
 * the merge-on-save path leaves them untouched.
 */
export function serializeMcpJson(name: string, config: McpServerConfig): string {
  const c = config as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const hasCommand = typeof c.command === 'string';
  const hasUrl = typeof c.url === 'string';

  if (hasCommand) out.command = c.command;
  if (Array.isArray(c.args)) out.args = c.args;
  if (hasUrl) out.url = c.url;
  if (typeof c.type === 'string') out.type = c.type;

  const envRefs = (c.envRefs as Record<string, string> | undefined) ?? {};

  // env and headers are surfaced independently — if a config somehow has both
  // (corrupted row), neither is silently dropped.
  if (hasCommand) {
    const env = (c.env as Record<string, string> | undefined) ?? {};
    const merged = mergeRefsIntoMap(env, envRefs);
    if (Object.keys(merged).length > 0) out.env = merged;
  }
  if (hasUrl) {
    const headers = (c.headers as Record<string, string> | undefined) ?? {};
    const merged = mergeRefsIntoMap(headers, envRefs);
    if (Object.keys(merged).length > 0) out.headers = merged;
  }

  const wrapped = { mcpServers: { [name || 'server']: out } };
  return JSON.stringify(wrapped, null, 2);
}

// ─── Internals ────────────────────────────────────────────────────────────────

interface TranslateOk { ok: true; config: McpServerConfig; warnings: string[] }
type TranslateResult = TranslateOk | { ok: false; error: string };

function translateServer(raw: Record<string, unknown>): TranslateResult {
  const warnings: string[] = [];
  const hasCommand = typeof raw.command === 'string';
  const hasUrl = typeof raw.url === 'string';

  if (!hasCommand && !hasUrl) {
    return { ok: false, error: 'Server must have either `command` (stdio) or `url` (sse/http)' };
  }

  if (hasCommand) {
    const cfg: Record<string, unknown> = { command: raw.command };
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || !raw.args.every(a => typeof a === 'string')) {
        return { ok: false, error: '`args` must be an array of strings' };
      }
      cfg.args = raw.args;
    }
    const split = splitEnvAndRefs(raw.env, 'env');
    if (split.error) return { ok: false, error: split.error };
    if (split.values && Object.keys(split.values).length > 0) cfg.env = split.values;
    if (split.refs && Object.keys(split.refs).length > 0) cfg.envRefs = split.refs;
    if (split.warnings) warnings.push(...split.warnings);
    if (typeof raw.tsSource === 'string') cfg.tsSource = raw.tsSource;
    return { ok: true, config: cfg as unknown as McpServerConfig, warnings };
  }

  // sse / http
  const cfg: Record<string, unknown> = { url: raw.url };
  if (raw.type === 'sse' || raw.type === 'http') cfg.type = raw.type;
  const split = splitEnvAndRefs(raw.headers, 'headers');
  if (split.error) return { ok: false, error: split.error };
  if (split.values && Object.keys(split.values).length > 0) cfg.headers = split.values;
  if (split.refs && Object.keys(split.refs).length > 0) cfg.envRefs = split.refs;
  if (split.warnings) warnings.push(...split.warnings);
  return { ok: true, config: cfg as unknown as McpServerConfig, warnings };
}

/**
 * Walk an `env` or `headers` object and split each value into either:
 *  - a literal value (stays in the output map), or
 *  - an env-ref (moves to the `refs` map; if it had a prefix, the prefix
 *    stays in the output map under the same key — that's how the runner
 *    reassembles `"Bearer " + <secret>`).
 *
 * `"********"` values are dropped entirely — they signal "unchanged" and
 * `mergeMcpConfig()` on the server will refill them from the stored row.
 */
function splitEnvAndRefs(
  input: unknown,
  field: 'env' | 'headers',
): {
  values?: Record<string, string>;
  refs?: Record<string, string>;
  warnings?: string[];
  error?: string;
} {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: `\`${field}\` must be an object` };
  }
  const values: Record<string, string> = {};
  const refs: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (typeof raw !== 'string') {
      return { error: `\`${field}.${key}\` must be a string` };
    }
    if (raw === MASK) continue; // unchanged — server-side merge restores it
    const m = raw.match(ENV_REF_RE);
    // The `.*` in ENV_REF_RE is greedy, so `"${env:A}@${env:B}"` matches as
    // prefix=`"${env:A}@"`, refName=`B` — that would silently ship the prefix
    // as a literal. Reject the match if the prefix still contains `${env:...}`.
    if (m && !ENV_REF_ANY_RE.test(m[1])) {
      const prefix = m[1];
      const refName = m[2];
      refs[key] = refName;
      if (prefix) values[key] = prefix; // runner prepends this to the resolved secret
    } else {
      // Mid-string or multi-ref substitution isn't supported by the runner's
      // prefix-only envRefs model. Warn loudly so the value doesn't silently
      // ship as a literal `${env:...}` string to the subprocess.
      if (ENV_REF_ANY_RE.test(raw)) {
        warnings.push(
          `\`${field}.${key}\`: \${env:NAME} must be at the end of the value (e.g. "Bearer \${env:TOKEN}"). Mid-string substitution isn't supported — the value will be used literally.`,
        );
      }
      values[key] = raw;
    }
  }
  return { values, refs, warnings };
}

/**
 * Inverse of {@link splitEnvAndRefs}: fold `envRefs` back into an `env` /
 * `headers` map for display, producing `${env:NAME}` strings (optionally
 * prefixed with any value left behind in the map under the same key).
 */
function mergeRefsIntoMap(
  values: Record<string, string>,
  refs: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, refName] of Object.entries(refs)) {
    const prefix = values[key];
    out[key] = `${prefix && prefix !== MASK ? prefix : ''}\${env:${refName}}`;
    seen.add(key);
  }
  for (const [key, val] of Object.entries(values)) {
    if (seen.has(key)) continue;
    out[key] = val;
  }
  return out;
}

function lineFromOffset(s: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < s.length; i++) {
    if (s[i] === '\n') line++;
  }
  return line;
}

/**
 * Best-effort line extraction from a `JSON.parse` error. Handles both the old
 * "at position N" format and the newer `..."<snippet>"` context-quoting format
 * by locating the snippet inside the original input.
 */
function extractLine(src: string, msg: string): number | undefined {
  const posMatch = msg.match(/position (\d+)/);
  if (posMatch) return lineFromOffset(src, parseInt(posMatch[1], 10));
  const snippetMatch = msg.match(/\.\.\."([^"]{3,})"/);
  if (snippetMatch) {
    const idx = src.indexOf(snippetMatch[1]);
    if (idx >= 0) return lineFromOffset(src, idx);
  }
  return undefined;
}
