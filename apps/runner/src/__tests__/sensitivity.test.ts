import { describe, it, expect } from 'vitest';
import {
  detectSensitive, detectInText, mergeHits, markSensitive, humanizeTag,
} from '@slackhive/shared';

describe('detectInText — the model\'s own output (PII + secrets only)', () => {
  it('does NOT flag the mere mention of data words in prose', () => {
    expect(detectInText('send me your email')).toBeNull();
    expect(detectInText('email the address to payroll about the payment')).toBeNull();
    expect(detectInText('what is my salary')).toBeNull();
  });

  it('flags a real email address / secret value', () => {
    expect(detectInText('my email is bob@acme.com')?.reason).toContain('pii:email');
    expect(detectInText('key sk-ABCDEFGHIJKLMNOPQRSTUVWX')?.reason).toContain('secret:openai_key');
  });

  it('treats bare numbers, metrics, dates and ids as clean', () => {
    for (const s of ['25,000 target', '$9.83M', '300,000 customers', '118000000', '1700000000000', '2026-06-11', 'SKU 1234567890123', 'ID 9876543210']) {
      expect(detectInText(s), s).toBeNull();
    }
  });

  it('flags phones only with a + country code or (area) parens, not bare 3-3-4', () => {
    expect(detectInText('+1 415-555-0186')?.reason).toContain('pii:phone');
    expect(detectInText('(415) 555-0186')?.reason).toContain('pii:phone');
    expect(detectInText('123-456-7890')).toBeNull();      // order/ref number
    expect(detectInText('call 415 555 0186')).toBeNull();
  });

  it('flags a Luhn-valid card but not a random long digit run', () => {
    expect(detectInText('card 4111 1111 1111 1111')?.reason).toContain('pii:card');
    expect(detectInText('SKU 1234567890123')).toBeNull();
  });

  it('returns null for empty/undefined', () => {
    expect(detectInText('')).toBeNull();
    expect(detectInText(undefined)).toBeNull();
  });

  it('identifies DB credentials: connection strings and env-style password keys', () => {
    expect(detectInText('postgres://admin:hunter2@db.internal:5432/app')?.reason).toContain('secret:connection_string');
    expect(detectInText('mysql://u:p4ssw0rd@10.0.0.1/sales')?.reason).toContain('secret:connection_string');
    expect(detectInText('DB_PASSWORD=s3cr3tValue')?.reason).toContain('secret:password');
    expect(detectInText('PGPASSWORD=topSecret1')?.reason).toContain('secret:password');
    expect(detectInText('password: hunter2')?.reason).toContain('secret:password');
    // A bare username or a plain URL (no embedded creds) is not flagged.
    expect(detectInText('user is admin')).toBeNull();
    expect(detectInText('see https://example.com/db')).toBeNull();
  });
});

describe('detectSensitive — tool calls', () => {
  it('flags a database tool by name + data keyword in args', () => {
    const hit = detectSensitive('redshift_query', 'select email from users', 'rows');
    expect(hit?.categories).toEqual(expect.arrayContaining(['tool', 'data']));
    expect(hit?.reason).toContain('tool:database');
    expect(hit?.reason).toContain('data:email');
  });

  it('flags PII/secret values appearing in the result', () => {
    expect(detectSensitive('fetch', 'q', 'contact bob@acme.com')?.reason).toContain('pii:email');
  });

  it('returns null when nothing is sensitive', () => {
    expect(detectSensitive('calculator', '2 + 2', '4')).toBeNull();
  });
});

describe('markSensitive — highlight segmentation', () => {
  it('segments reconstruct the original string exactly', () => {
    const input = 'reach me at +1 415-555-0186 or bob@acme.com please';
    expect(markSensitive(input, 'text').map(s => s.text).join('')).toBe(input);
  });

  it('flags the phone + email substrings with the right category', () => {
    const segs = markSensitive('+1 415-555-0186 and bob@acme.com', 'text').filter(s => s.cat);
    expect(segs.map(s => s.label)).toEqual(expect.arrayContaining(['pii:phone', 'pii:email']));
  });

  it('text scope excludes data keywords; all scope includes them', () => {
    expect(markSensitive('select email from t', 'text').some(s => s.cat === 'data')).toBe(false);
    expect(markSensitive('select email from t', 'all').some(s => s.cat === 'data')).toBe(true);
  });

  it('returns a single unflagged segment when nothing matches', () => {
    expect(markSensitive('just some numbers 25,000 and 2026-06-11', 'text')).toEqual([
      { text: 'just some numbers 25,000 and 2026-06-11', cat: null, label: null },
    ]);
  });

  it('does not highlight bare grouped numbers as phones', () => {
    expect(markSensitive('order 123-456-7890', 'text').some(s => s.cat)).toBe(false);
  });
});

describe('humanizeTag', () => {
  it('maps known tags to readable labels', () => {
    expect(humanizeTag('pii:phone')).toEqual({ category: 'pii', label: 'Phone number' });
    expect(humanizeTag('secret:aws_key')).toEqual({ category: 'secret', label: 'AWS key' });
    expect(humanizeTag('tool:database')).toEqual({ category: 'tool', label: 'Database access' });
  });
  it('humanizes dynamic data keywords (title case + acronyms)', () => {
    expect(humanizeTag('data:salary')).toEqual({ category: 'data', label: 'Salary' });
    expect(humanizeTag('data:ssn')).toEqual({ category: 'data', label: 'SSN' });
    expect(humanizeTag('data:credit_card')).toEqual({ category: 'data', label: 'Credit card' });
  });
});

describe('mergeHits', () => {
  it('unions categories + tags across hits and ignores nulls', () => {
    const merged = mergeHits([
      detectInText('bob@acme.com'),
      detectSensitive('redshift', 'select salary from p', undefined),
      null,
    ]);
    expect(merged?.categories).toEqual(expect.arrayContaining(['pii', 'tool', 'data']));
    expect(merged?.reason).toContain('pii:email');
    expect(merged?.reason).toContain('data:salary');
  });
  it('returns null when all hits are null', () => {
    expect(mergeHits([null, null])).toBeNull();
  });
});
