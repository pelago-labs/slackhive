/**
 * @fileoverview Source-text invariants for how the coach exposes file sources.
 *
 * The coach no longer uses in-process MCP tools; it materializes the agent's
 * state as files in a READ-ONLY workspace and the model reads what it needs.
 * The security invariant is unchanged and still asserted here: the coach can
 * READ file sources but must NEVER be able to mutate them (wiki sources are
 * owner-managed and shared across agents). Source-text assertions keep this
 * cheap without standing up a full coach turn.
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

describe('coach file sources — read-only, never mutated', () => {
  it('materializes file sources into the read-only coach workspace', () => {
    expect(src).toContain('knowledge-sources');
    // Read-only workspace: Codex sandbox + Claude tool denylist.
    expect(src).toContain("sandboxMode: 'read-only'");
    expect(src).toMatch(/disallowedTools:\s*\[[^\]]*'Write'[^\]]*'Edit'[^\]]*'Bash'[^\]]*\]/);
  });

  it('scopes the file-source query to file-type rows for this agent', () => {
    // Security boundary: coach must not leak url/repo rows.
    expect(src).toMatch(/FROM wiki_sources[\s\S]*?JOIN agent_wiki_folders[\s\S]*?WHERE awf\.agent_id = \$1 AND ws\.type = 'file'/);
  });

  it('has no proposal path that mutates a file source', () => {
    // The coach can propose only instructions / skill / memory changes.
    expect(src).not.toContain('proposeFileSourceChange');
    expect(src).not.toContain("'propose_file_source_change'");
    expect(src).not.toMatch(/kind\s*===?\s*['"]file-source['"]/);
  });
});

describe('coach tools — legacy in-process toolbox removed', () => {
  it('no longer registers in-process SDK tools or the coach MCP allowlist', () => {
    expect(src).not.toContain('createSdkMcpServer');
    expect(src).not.toContain('buildToolbox');
    expect(src).not.toContain('mcp__coach__');
  });

  it('wiki-extract is retired', () => {
    expect(src).not.toContain('propose_wiki_extract');
    expect(src).not.toContain('wikiExtract');
  });
});
