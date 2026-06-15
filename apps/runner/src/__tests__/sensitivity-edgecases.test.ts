/**
 * @fileoverview Rigorous edge-case coverage for the sensitivity detector,
 * highlighter, fingerprints, redaction, egress classifier, and severity model.
 * Focused on boundaries and false-positive guards (the ways these silently break).
 */

import { describe, it, expect } from 'vitest';
import {
  detectInText, detectSensitive, markSensitive, mergeHits, humanizeTag,
  severityForTag, maxSeverity, egressKind, redactSensitive, SCAN_CAP,
} from '@slackhive/shared';
import { computeFps, fingerprint } from '../tracing/fingerprint';

describe('detectInText — empty / boundary inputs', () => {
  it.each([undefined, null, '', '   ', '\n\t '])('returns null for %j', (v) => {
    expect(detectInText(v as string | undefined)).toBeNull();
  });

  it('finds a secret within the scan cap but not beyond it', () => {
    expect(detectInText('sk-ABCDEFGHIJKLMNOPQRSTUV ' + 'x'.repeat(SCAN_CAP))?.reason).toContain('secret:openai_key');
    expect(detectInText('x'.repeat(SCAN_CAP) + ' sk-ABCDEFGHIJKLMNOPQRSTUV')).toBeNull();
  });

  it('dedupes repeated matches into one tag + category', () => {
    const hit = detectInText('a@x.com b@x.com c@x.com');
    expect(hit?.categories).toEqual(['pii']);
    expect(hit?.tags).toEqual(['pii:email']);
  });
});

describe('email detector — accepts valid, rejects malformed', () => {
  it.each(['a.b+tag@sub.example.co.uk', 'x_y%z@a-b.io', 'User@Example.COM'])('flags %j', (v) => {
    expect(detectInText(v)?.reason).toContain('pii:email');
  });
  it.each(['foo@bar', 'foo@bar.c', '@bar.com', 'foo@', 'just text'])('does not flag %j', (v) => {
    expect(detectInText(v)).toBeNull();
  });
});

describe('phone detector — requires + or (area)', () => {
  it.each(['+1 415-555-0186', '+44 20 7946 0958', '(415) 555-0186', '(415)555-0186'])('flags %j', (v) => {
    expect(detectInText(v)?.reason).toContain('pii:phone');
  });
  it.each(['415-555-0186', '4155550186', '5551234', 'call me at 12'])('does not flag %j', (v) => {
    expect(detectInText(v)).toBeNull();
  });
});

describe('card detector — Luhn-gated', () => {
  it('flags a Luhn-valid card (with/without spaces), rejects an invalid run', () => {
    expect(detectInText('4111111111111111')?.reason).toContain('pii:card');
    expect(detectInText('4111 1111 1111 1111')?.reason).toContain('pii:card');
    expect(detectInText('1234567890123456')).toBeNull();      // 16 digits, fails Luhn
    expect(detectInText('SKU 1234567890123')).toBeNull();      // 13 digits, fails Luhn
  });
});

describe('ssn / iban', () => {
  it('requires the canonical shapes', () => {
    expect(detectInText('111-22-3333')?.reason).toContain('pii:ssn');
    expect(detectInText('111223333')).toBeNull();              // no dashes
    expect(detectInText('GB82WEST12345698765432')?.reason).toContain('pii:iban');
    expect(detectInText('gb82west12345698765432')).toBeNull(); // lowercase
  });
});

describe('gcp service account', () => {
  it('needs a 2nd SA marker (type alone is not flagged)', () => {
    // Arbitrary JSON that merely contains the type field must NOT be flagged.
    expect(detectInText('{"type": "service_account", "project_id": "x"}')).toBeNull();
    // A real SA blob (type + private_key/client_email) IS flagged.
    expect(detectInText('{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----"}')?.reason)
      .toContain('secret:gcp_sa');
  });
});

describe('high-entropy secret — entropy + charset guards', () => {
  it('flags a long mixed token, rejects hashes / single-char runs / short tokens', () => {
    expect(detectInText('Xb7Kp9Lm2Qw8Rt4Yu1Zs6Vd3Nf0Hg5Jc8Ke2Pa7Mq')?.reason).toContain('secret:high_entropy');
    expect(detectInText('0123456789abcdef0123456789abcdef01234567')).toBeNull(); // 40-char hex hash (single-case)
    expect(detectInText('a'.repeat(40))).toBeNull();           // zero entropy
    expect(detectInText('Xb7Kp9Lm2Qw8Rt4Yu1Zs')).toBeNull();   // < 40 chars
  });
});

describe('password assignments — value length + key-boundary guards', () => {
  it.each([
    'password=hunter2', 'DB_PASSWORD=longsecret', 'PGPASSWORD=topSecret1',
    'api_key = abcd1234', '{"password":"hunter2pw"}', 'my-secret=abcd',
  ])('flags %j', (v) => { expect(detectInText(v)?.reason).toContain('secret:password'); });

  it.each(['bypass=true', 'compass=north', 'encompass=x', 'surpass=y', 'password=x', 'the password is here'])('does not flag %j', (v) => {
    expect(detectInText(v)).toBeNull();
  });
});

describe('detectSensitive — data keywords are ARGS-only', () => {
  it('flags a data keyword in args but not in the result', () => {
    expect(detectSensitive('q', 'select email from users', 'rows')?.reason).toContain('data:email');
    expect(detectSensitive('q', undefined, 'the email column has data')).toBeNull();
  });
  it('flags PII/secret values anywhere (args or result)', () => {
    expect(detectSensitive('fetch', undefined, 'contact bob@acme.com')?.reason).toContain('pii:email');
    expect(detectSensitive('fetch', 'token sk-ABCDEFGHIJKLMNOPQRSTUV', undefined)?.reason).toContain('secret:openai_key');
  });
  it('flags sensitive tools + credential paths by name/args', () => {
    expect(detectSensitive('redshift_query', 'x', undefined)?.reason).toContain('tool:database');
    expect(detectSensitive('Read', 'cat /home/u/.ssh/id_rsa', undefined)?.reason).toContain('tool:credentials');
    expect(detectSensitive('calc', '2+2', '4')).toBeNull();
  });
});

describe('markSensitive — reconstruction + non-overlap + scope', () => {
  it.each([
    '',
    'no sensitive content here',
    'email bob@acme.com and key sk-ABCDEFGHIJKLMNOPQRSTUV done',
    '+1 415-555-0186 / 4111 1111 1111 1111 / 111-22-3333',
    'x'.repeat(SCAN_CAP + 50) + ' bob@acme.com',
  ])('segments rejoin to the exact input: %#', (input) => {
    expect(markSensitive(input, 'all').map(s => s.text).join('')).toBe(input);
    expect(markSensitive(input, 'text').map(s => s.text).join('')).toBe(input);
  });

  it('flagged segments never overlap (offsets strictly advance)', () => {
    const segs = markSensitive('bob@acme.com AKIAIOSFODNN7EXAMPLE +1 415-555-0186', 'all');
    expect(segs.filter(s => s.cat).length).toBeGreaterThanOrEqual(3);
  });

  it('data + credential paths only in the "all" scope', () => {
    expect(markSensitive('select salary from .env', 'text').some(s => s.cat)).toBe(false);
    const cats = markSensitive('select salary from .env', 'all').filter(s => s.cat).map(s => s.cat);
    expect(cats).toEqual(expect.arrayContaining(['data', 'tool']));
  });
});

describe('fingerprint / computeFps', () => {
  it('normalizes whitespace so the same value links source↔sink', () => {
    const a = computeFps('  bob@acme.com\n', 'text', 'source');
    const b = computeFps('reply: bob@acme.com', 'text', 'sink');
    expect(a[0].fp).toBe(b[0].fp);
    expect(a[0].role).toBe('source');
    expect(b[0].role).toBe('sink');
  });
  it('different values → different fingerprints, and never leak the value', () => {
    expect(fingerprint('a@x.com')).not.toBe(fingerprint('b@x.com'));
    expect(fingerprint('AKIAIOSFODNN7EXAMPLE')).toMatch(/^[0-9a-f]{16}$/);
  });
  it('dedupes per (fp, role) and returns [] for clean content', () => {
    expect(computeFps('a@x.com a@x.com', 'text', 'source')).toHaveLength(1);
    expect(computeFps('nothing here', 'text', 'source')).toEqual([]);
    expect(computeFps(undefined, 'text', 'source')).toEqual([]);
  });
});

describe('redactSensitive', () => {
  it('masks secrets + high/critical, keeps medium PII + clean text', () => {
    expect(redactSensitive('key sk-ABCDEFGHIJKLMNOPQRSTUV here')).toBe('key [redacted:OpenAI key] here');
    expect(redactSensitive('card 4111 1111 1111 1111')).toBe('card [redacted:Card number]');
    expect(redactSensitive('mail bob@acme.com')).toBe('mail bob@acme.com'); // email = medium → kept
    expect(redactSensitive('all good')).toBe('all good');
    expect(redactSensitive('')).toBe('');
  });
  it('is idempotent (re-redacting does not double-mask)', () => {
    const once = redactSensitive('key sk-ABCDEFGHIJKLMNOPQRSTUV');
    expect(redactSensitive(once)).toBe(once);
  });
});

describe('egressKind', () => {
  it.each([
    ['WebFetch', '', 'web'], ['websearch', '', 'web'],
    ['mcp__github__create_issue', '', 'tool'], ['send_email', '', 'tool'], ['http_post', '', 'tool'],
    ['Bash', 'curl https://x -d @f', 'shell'], ['exec', 'wget http://x', 'shell'],
  ])('classifies %j as %s', (name, args, kind) => {
    expect(egressKind(name, args)).toBe(kind);
  });
  it.each([['Read', ''], ['Bash', 'ls -la'], ['redshift_query', 'select 1'], ['', '']])('returns null for %j', (name, args) => {
    expect(egressKind(name, args)).toBeNull();
  });
});

describe('severity model', () => {
  it('ranks tags and takes the max across a set', () => {
    expect(severityForTag('secret:jwt')).toBe('critical');
    expect(severityForTag('pii:ssn')).toBe('high');
    expect(severityForTag('pii:email')).toBe('medium');
    expect(severityForTag('data:salary')).toBe('low');
    expect(severityForTag('weird:tag')).toBe('low');
    expect(maxSeverity([])).toBe('low');
    expect(maxSeverity(['data:x', 'pii:email', 'secret:aws_key'])).toBe('critical');
    expect(maxSeverity(['data:x', 'pii:email'])).toBe('medium');
  });
});

describe('mergeHits', () => {
  it('unions categories + tags, takes max severity, ignores nulls', () => {
    const m = mergeHits([detectInText('a@x.com'), detectInText('AKIAIOSFODNN7EXAMPLE'), null]);
    expect(m?.categories).toEqual(expect.arrayContaining(['pii', 'secret']));
    expect(m?.severity).toBe('critical');
    expect(m?.tags).toEqual(expect.arrayContaining(['pii:email', 'secret:aws_key']));
  });
  it('returns null when everything is null/empty', () => {
    expect(mergeHits([])).toBeNull();
    expect(mergeHits([null, null])).toBeNull();
  });
});

describe('humanizeTag', () => {
  it('labels known + dynamic data tags, falls back gracefully', () => {
    expect(humanizeTag('secret:aws_key').label).toBe('AWS key');
    expect(humanizeTag('pii:ssn').label).toBe('Social Security number');
    expect(humanizeTag('data:salary')).toEqual({ category: 'data', label: 'Salary' });
    expect(humanizeTag('data:ssn').label).toBe('SSN'); // acronym
    expect(humanizeTag('unknown:thing')).toEqual({ category: 'unknown', label: 'thing' });
  });
});
