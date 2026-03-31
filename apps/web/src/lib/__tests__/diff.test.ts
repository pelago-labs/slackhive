/**
 * @fileoverview Unit tests for the lineDiff utility in diff.ts.
 *
 * @module web/lib/__tests__/diff.test
 */

import { describe, it, expect } from 'vitest';
import { lineDiff } from '@/lib/diff';

describe('lineDiff', () => {
  it('returns a single same entry for two empty strings', () => {
    // ''.split('\n') yields [''], so one same entry with an empty line
    expect(lineDiff('', '')).toEqual([{ type: 'same', line: '' }]);
  });

  it('returns all same entries for identical strings', () => {
    const result = lineDiff('hello\nworld', 'hello\nworld');
    expect(result).toEqual([
      { type: 'same', line: 'hello' },
      { type: 'same', line: 'world' },
    ]);
  });

  it('returns add entries for new lines when old is empty', () => {
    // old = '' → [''], new = 'foo\nbar' → ['foo','bar']
    // '' does not match 'foo' or 'bar', so it becomes a remove; foo and bar become adds
    const result = lineDiff('', 'foo\nbar');
    const adds = result.filter(l => l.type === 'add').map(l => l.line);
    expect(adds).toEqual(['foo', 'bar']);
  });

  it('returns remove entries for old lines when new is empty', () => {
    // old = 'foo\nbar' → ['foo','bar'], new = '' → ['']
    // foo and bar become removes; '' becomes an add
    const result = lineDiff('foo\nbar', '');
    const removes = result.filter(l => l.type === 'remove').map(l => l.line);
    expect(removes).toEqual(['foo', 'bar']);
  });

  it('detects one line added in the middle', () => {
    const result = lineDiff('a\nb', 'a\nc\nb');
    expect(result).toContainEqual({ type: 'add', line: 'c' });
    expect(result.filter(l => l.type === 'same').map(l => l.line)).toEqual(['a', 'b']);
  });

  it('detects one line removed from the middle', () => {
    const result = lineDiff('a\nb\nc', 'a\nc');
    expect(result).toContainEqual({ type: 'remove', line: 'b' });
    expect(result.filter(l => l.type === 'same').map(l => l.line)).toEqual(['a', 'c']);
  });

  it('produces all removes then all adds for a complete replacement', () => {
    const result = lineDiff('old1\nold2', 'new1\nnew2');
    const types = result.map(l => l.type);
    // All removes should come before all adds
    const firstAdd = types.indexOf('add');
    const lastRemove = types.lastIndexOf('remove');
    expect(firstAdd).toBeGreaterThan(-1);
    expect(lastRemove).toBeGreaterThan(-1);
    expect(lastRemove).toBeLessThan(firstAdd);
    expect(result.filter(l => l.type === 'remove').map(l => l.line)).toEqual(['old1', 'old2']);
    expect(result.filter(l => l.type === 'add').map(l => l.line)).toEqual(['new1', 'new2']);
  });

  it('handles multiline: first same, middle change, last same', () => {
    const oldText = 'line1\noriginal\nline3';
    const newText = 'line1\nchanged\nline3';
    const result = lineDiff(oldText, newText);
    expect(result[0]).toEqual({ type: 'same', line: 'line1' });
    const middleEntries = result.slice(1, result.length - 1);
    expect(middleEntries).toContainEqual({ type: 'remove', line: 'original' });
    expect(middleEntries).toContainEqual({ type: 'add', line: 'changed' });
    expect(result[result.length - 1]).toEqual({ type: 'same', line: 'line3' });
  });
});
