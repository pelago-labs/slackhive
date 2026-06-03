import { describe, it, expect } from 'vitest';
import { isFetchableUrl } from '../wiki-source-url';

describe('isFetchableUrl', () => {
  it('accepts real http(s) URLs', () => {
    expect(isFetchableUrl('https://example.com/page')).toBe(true);
    expect(isFetchableUrl('http://localhost:3000/x')).toBe(true);
    expect(isFetchableUrl('  https://example.com/x  ')).toBe(true); // trims
  });

  it('rejects pasted markdown stored in the url column (the bug)', () => {
    expect(isFetchableUrl('# eSIM — NLQ Guidance\n\nThis article defines…')).toBe(false);
    expect(isFetchableUrl('## Session & Event Table Data Retention')).toBe(false);
  });

  it('rejects non-http(s) and malformed values', () => {
    expect(isFetchableUrl('ftp://example.com/x')).toBe(false);
    expect(isFetchableUrl('example.com')).toBe(false);
    expect(isFetchableUrl('/some/file/path.md')).toBe(false);
    expect(isFetchableUrl('not a url at all')).toBe(false);
  });

  it('rejects empty / nullish', () => {
    expect(isFetchableUrl('')).toBe(false);
    expect(isFetchableUrl(null)).toBe(false);
    expect(isFetchableUrl(undefined)).toBe(false);
  });
});
