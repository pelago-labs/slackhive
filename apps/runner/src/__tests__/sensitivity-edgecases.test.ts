/**
 * @fileoverview Rigorous edge-case coverage for the sensitivity detector,
 * highlighter, fingerprints, redaction, egress classifier, and severity model.
 * Focused on boundaries and false-positive guards (the ways these silently break).
 */

import { describe, it, expect } from 'vitest';
import {
  detectInText, detectSensitive, markSensitive, markSensitiveWith, mergeHits, humanizeTag,
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
  it('masks a secret located BEYOND the highlight SCAN_CAP (no unscanned tail leak)', () => {
    const tail = 'leak sk-ABCDEFGHIJKLMNOPQRSTUV done';
    const out = redactSensitive('x '.repeat(SCAN_CAP) + tail);
    expect(out).toContain('[redacted:OpenAI key]');
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUV');
  });
  it('masks a card spanning a SCAN_CAP window boundary', () => {
    // Pad so the card straddles the 16k window cut; the overlap must still catch it.
    const pad = 'x '.repeat((SCAN_CAP - 8) / 2);
    const out = redactSensitive(pad + 'card 4111 1111 1111 1111 end');
    expect(out).not.toContain('4111 1111 1111 1111');
    expect(out).toContain('[redacted:Card number]');
  });
  it('masks a long match straddling a SCAN_CAP window boundary (no leaked tail)', () => {
    // A high-entropy token far longer than the window overlap, positioned to cross
    // the 16k boundary: one window sees it truncated, the next whole — the union of
    // ranges must cover the FULL token so its tail isn't emitted unmasked.
    const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const token = b64.repeat(24).slice(0, 1500);          // ~1500 chars, high entropy
    const text = 'x '.repeat(SCAN_CAP / 2) + token + ' end'; // token starts at offset SCAN_CAP
    const out = redactSensitive(text, 'text', 'all');
    expect(out).not.toContain(token);
    expect(out).not.toContain(token.slice(-200));          // the tail specifically
    expect(out).toContain('[redacted:High-entropy secret]');
  });
  it('keeps a secret masked at level "secrets" even when straddling a >16KB window edge near a credential path', () => {
    // A secret value placed right at the 16k window boundary, preceded by a
    // tool:credentials path token that overlaps it — the window-merge must adopt the
    // higher-priority secret label so level 'secrets' still masks the value.
    const pad = 'x '.repeat(SCAN_CAP / 2 - 20);
    const text = `${pad}.aws/credentials sk-ABCDEFGHIJKLMNOPQRSTUV tail`;
    const out = redactSensitive(text, 'all', 'secrets');
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUV'); // secret masked, not left as a weak 'tool' label
  });
  it('does not auto-strip heuristic high-entropy tokens below the "all" level', () => {
    const blob = 'aA1' + 'bC2dE3fG4hI5jK6lM7nO8pQ9rS0'.repeat(2); // ~40+ char mixed token
    const text = `data uri ${blob} here`;
    // secrets / pii levels keep it (avoid corrupting benign long tokens)...
    expect(redactSensitive(text, 'text', 'secrets')).toBe(text);
    expect(redactSensitive(text, 'text', 'pii')).toBe(text);
    // ...but the explicit "all" level still masks everything flagged.
    expect(redactSensitive(text, 'text', 'all')).toContain('[redacted:High-entropy secret]');
  });
});

describe('markSensitiveWith — value-stable output (memoization)', () => {
  it('returns identical segments for equal-content but different-reference extras', () => {
    const text = 'call me at five five five oh one two six';
    const a = markSensitiveWith(text, 'text', [{ text: 'five five five', cat: 'pii', label: 'pii:phone' }]);
    const b = markSensitiveWith(text, 'text', [{ text: 'five five five', cat: 'pii', label: 'pii:phone' }]);
    // The trace memo keys on the hits' VALUE, not reference; equal content must
    // yield deep-equal output so a fresh array each poll doesn't change the result.
    expect(a).toEqual(b);
    expect(a.some(s => s.llm && s.label === 'pii:phone')).toBe(true);
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
  it('classifies write-verb MCP tools as sinks but not read-only ones', () => {
    expect(egressKind('mcp__slack__post_message', '')).toBe('tool');
    expect(egressKind('mcp__github__create_issue', '')).toBe('tool');
    expect(egressKind('mcp__crm__update_record', '')).toBe('tool');
    // Read-only tools must NOT be flagged as outbound sinks (no spurious flows).
    expect(egressKind('mcp__db__query', '')).toBeNull();
    expect(egressKind('mcp__slack__get_thread', '')).toBeNull();
    expect(egressKind('get_slack_thread', '')).toBeNull();
    expect(egressKind('mcp__notion__list_pages', '')).toBeNull();
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
