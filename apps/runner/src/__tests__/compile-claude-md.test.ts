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
    path.resolve(process.cwd(), 'src/compile-instructions.ts'),
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

  it('defines and EXPORTS the verbose narration directive (consumed at message time)', () => {
    // The directive still lives here for cohesion with other agent-prompt
    // constants, but it's no longer injected into CLAUDE.md at compile time.
    // Per-message injection in message-handler.ts lets audience.verbose
    // override agent.verbose per sender.
    expect(src).toMatch(/export\s+const\s+VERBOSE_NARRATION_DIRECTIVE/);
    expect(src).toContain('Share your direction');
    // Body must explicitly say not every tool call needs narration so we
    // don't regress into the per-tool chatter version.
    expect(src).toMatch(/Not every tool call needs narration/);
  });

  it('does NOT bake the verbose directive into CLAUDE.md at compile time', () => {
    // The old `if (agent.verbose === true) sections.push(VERBOSE_NARRATION_DIRECTIVE)`
    // block is gone — verbose is resolved per-sender in message-handler.ts.
    // If this regresses (someone adds the bake-time injection back), the test
    // catches it before the bake-then-override anti-pattern returns.
    expect(src).not.toMatch(/sections\.push\(\s*VERBOSE_NARRATION_DIRECTIVE\s*\)/);
  });

  it('Slack formatting rules teach strikethrough, mentions, and `>` blockquotes', () => {
    // These three pieces were lifted out of a per-agent skill into the
    // platform-wide rules. Pin them by content (not exact wording) so a
    // future refactor can't silently delete a rule. Backticks in the source
    // are escaped (template literal), so we assert on the inner tokens.
    expect(src).toContain('Strikethrough:');
    expect(src).toContain('~text~');
    expect(src).toContain('<@USER_ID>');
    expect(src).toContain('<#CHANNEL_ID>');
    expect(src).toMatch(/Blockquotes:.*> text/);
    // The "Never use" line must NOT forbid `>` anymore — that was the bug.
    expect(src).not.toMatch(/Never use:.*>\s*blockquotes/);
  });

  it('uses obviously-fake example IDs in the Mentions block (no real user/channel IDs)', () => {
    // Real Slack IDs in the prompt risk the model copy-pasting them into a
    // reply and pinging someone unintended. Pin the placeholder pattern.
    expect(src).toContain('<@U12345ABCDE>');
    expect(src).toContain('<#C12345ABCDE>');
  });

  it('exports SLACK_FORMATTING_SECTION as the single source of truth (re-used by slack-adapter)', () => {
    // Adapter must import this constant rather than redefining the rules
    // — duplication has bitten us before (the two strings drifted).
    expect(src).toMatch(/export\s+const\s+SLACK_FORMATTING_SECTION\s*=/);
  });
});
