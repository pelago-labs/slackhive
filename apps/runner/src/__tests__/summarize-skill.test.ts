/**
 * @fileoverview Tests for `cleanDescription` — the post-processor that
 * normalizes the Sonnet output before it lands in the DB. The model itself
 * is the wrong unit to test (network + nondeterminism); cleanDescription is
 * the deterministic surface that decides what actually gets stored.
 *
 * @module runner/__tests__/summarize-skill.test
 */

import { describe, it, expect } from 'vitest';
import { cleanDescription } from '../summarize-skill';

describe('cleanDescription', () => {
  it('trims surrounding whitespace and collapses internal whitespace', () => {
    expect(cleanDescription('   File a Notion bug   ticket  ')).toBe('File a Notion bug ticket');
  });

  it('strips wrapping double quotes', () => {
    expect(cleanDescription('"File a Notion bug ticket"')).toBe('File a Notion bug ticket');
  });

  it('strips wrapping single quotes', () => {
    expect(cleanDescription("'File a Notion bug ticket'")).toBe('File a Notion bug ticket');
  });

  it('drops a trailing period but keeps ? and !', () => {
    expect(cleanDescription('File a Notion bug ticket.')).toBe('File a Notion bug ticket');
    expect(cleanDescription('What does this skill do?')).toBe('What does this skill do?');
    expect(cleanDescription('Stop right there!')).toBe('Stop right there!');
  });

  it('clamps to 80 characters with an ellipsis', () => {
    const long = 'x'.repeat(120);
    const out = cleanDescription(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(80);
    expect(out!.endsWith('…')).toBe(true);
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(cleanDescription('')).toBeNull();
    expect(cleanDescription('    ')).toBeNull();
    expect(cleanDescription('""')).toBeNull();
  });

  it('collapses newlines so the result stays on one line', () => {
    expect(cleanDescription('File a Notion\nbug ticket')).toBe('File a Notion bug ticket');
  });
});
