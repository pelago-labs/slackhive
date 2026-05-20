import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeMdData } from '../types';

export function loadClaudeMd(agentDir: string): ClaudeMdData {
  const filePath = join(agentDir, 'CLAUDE.md');
  const raw = readFileSync(filePath, 'utf-8');
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
  // Filter out backtick-quoted strings that are clearly not user-facing trigger phrases:
  // file paths, MCP tool ids, file extensions. Real triggers are natural-language phrases.
  const filtered = patterns.filter(
    (p) => !p.includes('/') && !p.startsWith('mcp__') && !p.endsWith('.md'),
  );
  return Array.from(new Set(filtered));
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
