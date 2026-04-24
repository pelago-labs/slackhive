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
  it('registers list_file_sources / read_file_source / propose_file_source_change in the toolbox', () => {
    expect(src).toContain("'list_file_sources'");
    expect(src).toContain("'read_file_source'");
    expect(src).toContain("'propose_file_source_change'");
    // And wires them into the returned toolbox array.
    expect(src).toMatch(/return \[[^\]]*listFileSources[^\]]*readFileSource[^\]]*proposeFileSourceChange[^\]]*\]/s);
  });

  it('whitelists the new MCP tool names for the SDK allowlist', () => {
    expect(src).toContain("'mcp__coach__list_file_sources'");
    expect(src).toContain("'mcp__coach__read_file_source'");
    expect(src).toContain("'mcp__coach__propose_file_source_change'");
  });

  it('list_file_sources queries only file-type rows for this agent', () => {
    // Filtering on type='file' and agent_id is the security boundary — coach
    // must not leak url/repo rows (meta-only, different semantics).
    expect(src).toMatch(/FROM knowledge_sources[\s\S]*?WHERE agent_id = \$1 AND type = 'file'/);
  });

  it('read_file_source scopes the lookup to this agent + file type', () => {
    expect(src).toMatch(/WHERE id = \$1 AND agent_id = \$2 AND type = 'file'/);
  });

  it('enforces a 1 MB content cap on propose_file_source_change', () => {
    expect(src).toContain('MAX_FILE_SOURCE_BYTES = 1_048_576');
    expect(src).toMatch(/Buffer\.byteLength\(content, 'utf8'\) > MAX_FILE_SOURCE_BYTES/);
  });

  it('propose_file_source_change rejects colliding names on create', () => {
    // Unique (agent_id, name) index would throw at apply time. We surface it
    // up-front so the coach retries with action=update instead.
    expect(src).toMatch(/SELECT id FROM knowledge_sources WHERE agent_id = \$1 AND name = \$2/);
    expect(src).toContain('use action=update with sourceId=');
  });

  it('propose_file_source_change always queues — never auto-applies', () => {
    // File-source proposals are destructive and must show the diff before
    // anything lands. Unlike claude-md/skill, there is no autoApply shortcut.
    const block = src.match(/const proposeFileSourceChange = defTool\([\s\S]*?\);/);
    expect(block).not.toBeNull();
    expect(block![0]).not.toContain('ctx.autoApply');
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

  it('system prompt routes domain knowledge through file sources', () => {
    expect(src).toContain('propose_file_source_change');
    expect(src).toContain('knowledge/sources/');
  });
});
