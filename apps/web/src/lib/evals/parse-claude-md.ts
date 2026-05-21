/**
 * @fileoverview Extract structured references from an agent's raw
 * `claudeMd` markdown string.
 *
 * Several Tier 1 checks need to compare references found *inside*
 * the markdown — MCP tool calls, skill paths, wiki links, Step 0
 * trigger patterns — against what the agent has declared elsewhere
 * (linked MCP servers, skill rows, wiki folders). This module pulls
 * those references out.
 *
 * Filesystem-free — takes the raw string directly from `agent.claudeMd`.
 *
 * @module web/lib/evals/parse-claude-md
 */

import type { ParsedClaudeMd } from './types';

/** Parse an agent's `claudeMd` markdown into its structured references. */
export function parseClaudeMd(raw: string): ParsedClaudeMd {
  return {
    raw,
    triggers: extractStep0Triggers(raw),
    mcpReferences: extractMcpRefs(raw),
    skillReferences: extractMarkdownLinkPaths(raw, 'skills'),
    wikiReferences: extractMarkdownLinkPaths(raw, 'wiki'),
  };
}

function extractStep0Triggers(raw: string): string[] {
  const match = raw.match(/##\s+Step\s+0[^\n]*\n([\s\S]*?)(?=\n##\s+|$)/i);
  if (!match) return [];
  const patterns = [...match[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  // Strip backtick-quoted strings that are clearly not user-facing triggers:
  // file paths, MCP tool ids, file extensions. Real triggers are natural-
  // language phrases.
  const filtered = patterns.filter(
    (p) => !p.includes('/') && !p.startsWith('mcp__') && !p.endsWith('.md'),
  );
  return filtered;
}

function extractMcpRefs(raw: string): string[] {
  const matches = [...raw.matchAll(/\bmcp__[a-z][a-z0-9_-]*__[a-z_][a-z0-9_-]*\b/g)].map(
    (m) => m[0],
  );
  return Array.from(new Set(matches));
}

function extractMarkdownLinkPaths(raw: string, dir: 'skills' | 'wiki'): string[] {
  const pattern = new RegExp(`\\[[^\\]]*\\]\\((${dir}\\/[^)\\s]+\\.md)\\)`, 'g');
  const matches = [...raw.matchAll(pattern)].map((m) => m[1]);
  return Array.from(new Set(matches));
}
