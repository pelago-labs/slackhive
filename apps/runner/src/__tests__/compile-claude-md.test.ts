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

  it('no longer emits the /recall skill', () => {
    expect(src).not.toContain('RECALL_SKILL');
    expect(src).not.toContain("commands, 'recall.md'");
  });

  it('ships a /wiki skill when the wiki dir exists (ungated on contents)', () => {
    expect(src).toContain('WIKI_SKILL');
    // The ungated write — no `readdirSync(wikiDir).length > 0` guard on the main path.
    expect(src).toMatch(/if \(fs\.existsSync\(wikiDir\)\) \{\s*\n\s*fs\.writeFileSync\(path\.join\(commandsDir, 'wiki\.md'\)/);
  });

  it('inlines the wiki index into CLAUDE.md', () => {
    expect(src).toContain('buildWikiIndexSection');
    expect(src).toContain('# Knowledge Base');
  });
});
