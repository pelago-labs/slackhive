/**
 * @fileoverview Tests for expandMarkdownHits — the excerpt expansion that lets the
 * trace page mask LLM-flagged values even when markdown reflows them across DOM text
 * nodes (emphasis runs, table cells).
 *
 * @module web/lib/__tests__/markdown-hits
 */
import { describe, expect, it } from 'vitest';
import type { ExtraMark } from '@slackhive/shared';
import { expandMarkdownHits } from '@/lib/markdown-hits';

const hit = (text: string): ExtraMark => ({ text, cat: 'pii', label: 'financial' });
const texts = (hits: ExtraMark[]): string[] => hits.map(h => h.text);

describe('expandMarkdownHits', () => {
  it('keeps the whole cleaned excerpt (markup stripped)', () => {
    const out = expandMarkdownHits([hit('*SGD 123,298.28* GMV')]);
    expect(texts(out)).toContain('SGD 123,298.28 GMV');
  });

  it('emits the emphasis-run so a bolded value matches its isolated <strong> text node', () => {
    // `*SGD 123,298.28* GMV` renders as <strong>SGD 123,298.28</strong> GMV, so the
    // full excerpt never matches the bold node — the run must be its own hit.
    const out = expandMarkdownHits([hit('*SGD 123,298.28* GMV')]);
    expect(texts(out)).toContain('SGD 123,298.28');
  });

  it('emits the bare number so a flagged value masks in its own table cell', () => {
    // A table renders the value alone ("123,298.28"); the longer excerpt is not a
    // substring of the cell, so the digit token must be registered on its own.
    const out = expandMarkdownHits([hit('*SGD 123,298.28* GMV')]);
    expect(texts(out)).toContain('123,298.28');
  });

  it('handles all emphasis kinds (_italic_, ~strike~, `code`)', () => {
    expect(texts(expandMarkdownHits([hit('_user@acme.com_')]))).toContain('user@acme.com');
    expect(texts(expandMarkdownHits([hit('~secret-token-1234~')]))).toContain('secret-token-1234');
    expect(texts(expandMarkdownHits([hit('`AKIA1234567890`')]))).toContain('AKIA1234567890');
  });

  it('dedupes identical (cat,label,text) entries', () => {
    // The full-excerpt pass and the emphasis-run pass both yield the same string here.
    const out = expandMarkdownHits([hit('*123,298.28*')]);
    expect(out.filter(h => h.text === '123,298.28')).toHaveLength(1);
  });

  it('preserves cat/label on every expanded fragment', () => {
    const out = expandMarkdownHits([{ text: '*SGD 999.00* total', cat: 'secret', label: 'amount' }]);
    expect(out.every(h => h.cat === 'secret' && h.label === 'amount')).toBe(true);
  });

  it('drops empty/whitespace-only results', () => {
    expect(expandMarkdownHits([hit('   ')])).toEqual([]);
    expect(expandMarkdownHits([hit('**')])).toEqual([]);
  });

  it('does not emit short or non-digit tokens as standalone hits', () => {
    // "GMV" (no digit) and "SGD" (<4 chars) must not become their own broad hits.
    const out = expandMarkdownHits([hit('SGD 12 GMV')]); // "12" is too short
    expect(texts(out)).not.toContain('GMV');
    expect(texts(out)).not.toContain('SGD');
    expect(texts(out)).not.toContain('12');
  });

  it('DOCUMENTED CAVEAT: an incidental >=4-digit token is registered and will match its every occurrence', () => {
    // This is the over-masking trade-off (review finding): a year/id inside an excerpt
    // becomes a standalone hit, so unrelated copies of that number also get masked.
    const out = expandMarkdownHits([hit('Order 2024 placed in 2024')]);
    expect(texts(out)).toContain('2024');
  });

  it('returns [] for no hits', () => {
    expect(expandMarkdownHits([])).toEqual([]);
  });
});
