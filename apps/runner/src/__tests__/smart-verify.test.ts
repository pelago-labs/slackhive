import { describe, it, expect } from 'vitest';
import { parseFalsePositives } from '../tracing/smart-verify';
import type { SmartCandidate } from '../tracing/turn-tracer';

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
