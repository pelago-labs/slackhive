/**
 * @fileoverview Unit tests for sectionBlocksFromText — the shared text→Block-Kit
 * helper used by both buildPayloads and the inline feedback attach (answerBlocks).
 * It must keep every section block under Slack's 3000-char per-block cap, which is
 * what makes the inline feedback attach safe to graft onto an existing reply.
 *
 * @module runner/__tests__/slack-section-blocks
 */

import { describe, it, expect } from 'vitest';
import { sectionBlocksFromText } from '../adapters/slack-adapter';

const MAX = 3000;

describe('sectionBlocksFromText', () => {
  it('returns a single mrkdwn section for short text', () => {
    const blocks = sectionBlocksFromText('hello world');
    expect(blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'hello world' } }]);
  });

  it('splits text over 3000 chars into multiple section blocks, each within the cap', () => {
    const long = 'x'.repeat(MAX * 2 + 500); // ~3 blocks worth
    const blocks = sectionBlocksFromText(long);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      expect(b.type).toBe('section');
      expect(b.text.type).toBe('mrkdwn');
      expect((b.text.text as string).length).toBeLessThanOrEqual(MAX);
    }
    // No content is lost in the split.
    expect(blocks.map(b => b.text.text).join('')).toBe(long);
  });

  it('keeps text exactly at the cap as one block', () => {
    const blocks = sectionBlocksFromText('y'.repeat(MAX));
    expect(blocks).toHaveLength(1);
    expect((blocks[0].text.text as string).length).toBe(MAX);
  });
});
