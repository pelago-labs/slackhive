import { describe, expect, it } from 'vitest';
import { formatTokens } from '../formatTokens';

describe('formatTokens', () => {
  it('renders small integers verbatim', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(86)).toBe('86');
    expect(formatTokens(999)).toBe('999');
  });

  it('rounds 1K–999K to the nearest thousand', () => {
    expect(formatTokens(1000)).toBe('1K');
    expect(formatTokens(1499)).toBe('1K');
    expect(formatTokens(1500)).toBe('2K');
    expect(formatTokens(12_345)).toBe('12K');
    expect(formatTokens(999_499)).toBe('999K');
  });

  it('renders 1M+ with one decimal', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(formatTokens(42_000_000)).toBe('42.0M');
  });

  it('coerces invalid inputs to "0"', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(-1)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
  });
});
