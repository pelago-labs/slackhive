/**
 * @fileoverview Source-text assertions for the coach's file-source MCP tools.
 *
 * The coach runs inside the Agent SDK, so unit-mocking the full turn is
 * expensive. These tests assert on the source itself — the tool names, the
 * SQL queries, and the proposal shapes — so a refactor that silently breaks
 * contracts with the UI or the knowledge-sources DB surfaces immediately.
 *
 * @module runner/__tests__/coach-file-source-tools.test
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.resolve(process.cwd(), 'src/coach-handler.ts'),
  'utf-8',
);

describe('coach file-source tools', () => {
  it('registers list_file_sources and read_file_source as read-only tools (no propose)', () => {
    expect(src).toContain("'list_file_sources'");
    expect(src).toContain("'read_file_source'");
    // Wiki sources are shared across agents — coach must not mutate them.
    // propose_file_source_change must NOT be in the toolbox.
    expect(src).toMatch(/return \[[^\]]*listFileSources[^\]]*readFileSource[^\]]*\]/s);
    expect(src).not.toMatch(/return \[[^\]]*proposeFileSourceChange[^\]]*\]/s);
  });

  it('whitelists read-only wiki tool names for the SDK allowlist', () => {
    expect(src).toContain("'mcp__coach__list_file_sources'");
    expect(src).toContain("'mcp__coach__read_file_source'");
    expect(src).not.toContain("'mcp__coach__propose_file_source_change'");
  });

  it('list_file_sources queries only file-type rows for this agent', () => {
    // Security boundary: coach must not leak url/repo rows. Sources are now
    // accessed via wiki_sources joined through agent_wiki_folders.
    expect(src).toMatch(/FROM wiki_sources[\s\S]*?JOIN agent_wiki_folders[\s\S]*?WHERE awf\.agent_id = \$1 AND ws\.type = 'file'/);
  });

  it('read_file_source scopes the lookup to this agent + file type', () => {
    expect(src).toMatch(/WHERE ws\.id = \$1 AND awf\.agent_id = \$2 AND ws\.type = 'file'/);
  });

  it('propose_file_source_change is not in the coach toolbox', () => {
    // Wiki sources are owned by folder owners and shared across agents.
    // The coach must never be able to mutate them — read-only access only.
    expect(src).not.toContain("'propose_file_source_change'");
    expect(src).not.toContain('proposeFileSourceChange');
  });
});

describe('coach tools — wiki-extract retired', () => {
  it('propose_wiki_extract tool is gone', () => {
    expect(src).not.toContain("'propose_wiki_extract'");
    expect(src).not.toContain('mcp__coach__propose_wiki_extract');
  });

  it('no proposal still carries a wikiExtract attachment', () => {
    expect(src).not.toContain('wikiExtract:');
    expect(src).not.toContain('wikiExtractSchema');
  });

  it('system prompt no longer mentions wiki downloads', () => {
    expect(src).not.toContain('Download wiki page');
    expect(src).not.toMatch(/download(able)?\s+\.md/i);
    expect(src).not.toContain('propose_wiki_extract');
  });

  it('system prompt routes domain knowledge through wiki file sources', () => {
    // Coach reads wiki sources but cannot propose changes — wiki is owner-managed.
    expect(src).toContain('list_file_sources');
    expect(src).toContain('knowledge/sources/');
  });
});
