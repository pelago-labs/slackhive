import { describe, it, expect } from 'vitest';
import { parseFalsePositives, parseSmartFindings } from '../tracing/smart-verify';
import type { SmartCandidate, SmartScanTarget } from '../tracing/turn-tracer';

const cands: SmartCandidate[] = [
  { spanId: 's1', reason: 'pii:phone', sample: '+1 4…(15)' },
  { spanId: 's2', reason: 'secret:aws_key', sample: 'AKIA…(20)' },
  { spanId: 's3', reason: 'data:salary', sample: 'sala…(6)' },
];

describe('parseFalsePositives', () => {
  it('returns spanIds the model marked "no"', () => {
    expect(parseFalsePositives('1: no\n2: yes\n3: no', cands)).toEqual(['s1', 's3']);
  });
  it('tolerates loose formatting and is case-insensitive', () => {
    expect(parseFalsePositives('1 - NO\n2 : Yes\n3- yes', cands)).toEqual(['s1']);
  });
  it('keeps everything when nothing is a clear "no" (conservative)', () => {
    expect(parseFalsePositives('all look genuine', cands)).toEqual([]);
    expect(parseFalsePositives('1: yes\n2: yes\n3: yes', cands)).toEqual([]);
  });
  it('ignores out-of-range indices', () => {
    expect(parseFalsePositives('9: no\n2: no', cands)).toEqual(['s2']);
  });
});

const targets: SmartScanTarget[] = [
  { spanId: 'g1', kind: 'generation', content: 'call me at five five five oh one two six' },
  { spanId: 't1', kind: 'tool', content: 'nothing interesting here' },
  { spanId: 'g2', kind: 'generation', content: 'the password is hunter two' },
];

describe('parseSmartFindings', () => {
  it('parses "id | kind | severity | excerpt" into a span finding', () => {
    const out = parseSmartFindings('1 | pii:phone | medium | five five five oh one two six\n2 | none\n3 | secret | critical | hunter two', targets);
    expect(out).toEqual([
      { spanId: 'g1', category: 'pii:phone', severity: 'medium', excerpt: 'five five five oh one two six' },
      { spanId: 'g2', category: 'secret', severity: 'critical', excerpt: 'hunter two' },
    ]);
  });
  it('accepts a colon after the id too', () => {
    expect(parseSmartFindings('1: pii:phone | medium | five five five', targets)[0])
      .toEqual({ spanId: 'g1', category: 'pii:phone', severity: 'medium', excerpt: 'five five five' });
  });
  it('allows multiple findings for the same item', () => {
    const out = parseSmartFindings('1 | pii:phone | medium | abc\n1 | pii:email | medium | def', targets);
    expect(out).toHaveLength(2);
    expect(out.every(f => f.spanId === 'g1')).toBe(true);
  });
  it('drops "none" and unparseable lines', () => {
    expect(parseSmartFindings('1 | none\n2 | none\nnonsense', targets)).toEqual([]);
  });
  it('defaults severity to medium when missing or invalid', () => {
    const out = parseSmartFindings('1 | pii:phone | bogus | x\n3 | secret', targets);
    expect(out[0].severity).toBe('medium');
    expect(out[1]).toMatchObject({ spanId: 'g2', category: 'secret', severity: 'medium', excerpt: '' });
  });
  it('ignores out-of-range indices', () => {
    expect(parseSmartFindings('9 | secret | high | x', targets)).toEqual([]);
  });
});
