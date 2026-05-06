/**
 * @fileoverview Unit tests for compile-claude-md content.
 *
 * Tests cover:
 * - CLAUDE.md inlines learned memories so the model always sees them
 * - CLAUDE.md still contains memory-writing guidance (how to save new memories)
 * - The deprecated /recall skill is no longer emitted
 * - Wiki index section is inlined when the wiki dir exists
 *
 * @module runner/__tests__/compile-claude-md.test
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('compile-claude-md source content', () => {
  const src = fs.readFileSync(
    path.resolve(process.cwd(), 'src/compile-claude-md.ts'),
    'utf-8'
  );

  it('inlines learned memories into CLAUDE.md', () => {
    expect(src).toContain('# Learned Memories (active)');
    expect(src).toContain('buildInlinedMemoriesSection');
  });

  it('retains memory-writing guidance (save path)', () => {
    expect(src).toContain('# Saving New Memories');
    expect(src).toContain('memory/{type}_{name}.md');
  });

  it('memory-writing guidance enforces conciseness and redirects verbose content', () => {
    // The 1-3 sentence rule prevents agents from dumping full reference docs into memory.
    expect(src).toContain('1–3 sentences');
    // Explicit "Memory ≠ documentation" header makes the boundary obvious.
    expect(src).toContain('Memory ≠ documentation');
    // Tables/configs and multi-step procedures must be redirected, not stored as memory.
    expect(src).toMatch(/Tables.*wiki folder/);
    expect(src).toMatch(/procedures.*skill/);
  });

  it('no longer emits the /recall skill', () => {
    expect(src).not.toContain('RECALL_SKILL');
    expect(src).not.toContain("commands, 'recall.md'");
  });

  it('ships a /wiki skill when any assigned wiki folder has content', () => {
    expect(src).toContain('WIKI_SKILL');
    // Wiki skill is written when hasWiki is true (any assigned folder has content).
    expect(src).toMatch(/if \(hasWiki\) \{\s*\n\s*fs\.writeFileSync\(path\.join\(commandsDir, 'wiki\.md'\)/);
  });

  it('inlines the wiki index into CLAUDE.md', () => {
    expect(src).toContain('buildWikiIndexSection');
    expect(src).toContain('# Knowledge Base');
  });

  it('materializes file-type knowledge sources to disk every compile', () => {
    // The materializer must be called from compileClaudeMd so reload picks up
    // added/edited/deleted file sources without a Build Wiki click.
    expect(src).toContain('writeFileSourcesToDisk');
    expect(src).toMatch(/await writeFileSourcesToDisk\(workDir, agent\.id\)/);
    // And it must point the /wiki skill at knowledge/sources/ for raw lookups.
    expect(src).toContain('knowledge/sources/');
  });
});
