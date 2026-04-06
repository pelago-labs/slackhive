/**
 * @fileoverview Unit tests for Slack file attachment support in slack-handler.ts.
 *
 * Covers: getFileKind, downloadFile (text, image, PDF, oversized, unsupported).
 * fetch is globally mocked via vi.stubGlobal so no real network calls are made.
 *
 * @module runner/__tests__/slack-file-support.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFileKind, downloadFile } from '../slack-handler';
import type { SlackFile } from '../slack-handler';
import type { Logger } from 'winston';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const nopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

/** Fake Slack client — token is read via (client as any).token */
const fakeClient = { token: 'xoxb-test-token' };

function makeFile(overrides: Partial<SlackFile> = {}): SlackFile {
  return {
    id: 'F001',
    name: 'test.txt',
    mimetype: 'text/plain',
    filetype: 'text',
    url_private_download: 'https://files.slack.com/test.txt',
    size: 100,
    ...overrides,
  };
}

/** Mocks global fetch to return the given text body. */
function mockFetchText(text: string, status = 200) {
  const buf = Buffer.from(text, 'utf8');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  }));
}

/** Mocks global fetch to return the given binary buffer. */
function mockFetchBinary(data: Buffer, status = 200) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ─── getFileKind ──────────────────────────────────────────────────────────────

describe('getFileKind', () => {
  it('classifies text/plain as text', () => {
    expect(getFileKind(makeFile({ mimetype: 'text/plain', filetype: 'text' }))).toBe('text');
  });

  it('classifies text/markdown as text', () => {
    expect(getFileKind(makeFile({ mimetype: 'text/markdown', filetype: 'md' }))).toBe('text');
  });

  it('classifies application/json as text', () => {
    expect(getFileKind(makeFile({ mimetype: 'application/json', filetype: 'json' }))).toBe('text');
  });

  it('classifies text/csv as text', () => {
    expect(getFileKind(makeFile({ mimetype: 'text/csv', filetype: 'csv' }))).toBe('text');
  });

  it('classifies arbitrary text/* MIME as text', () => {
    expect(getFileKind(makeFile({ mimetype: 'text/x-python', filetype: 'py' }))).toBe('text');
  });

  it('classifies py filetype as text even without MIME', () => {
    expect(getFileKind(makeFile({ mimetype: undefined, filetype: 'py' }))).toBe('text');
  });

  it('classifies image/jpeg as image', () => {
    expect(getFileKind(makeFile({ mimetype: 'image/jpeg', filetype: 'jpg' }))).toBe('image');
  });

  it('classifies image/png as image', () => {
    expect(getFileKind(makeFile({ mimetype: 'image/png', filetype: 'png' }))).toBe('image');
  });

  it('classifies image/webp as image', () => {
    expect(getFileKind(makeFile({ mimetype: 'image/webp', filetype: 'webp' }))).toBe('image');
  });

  it('classifies jpg filetype as image even without MIME', () => {
    expect(getFileKind(makeFile({ mimetype: undefined, filetype: 'jpg' }))).toBe('image');
  });

  it('classifies application/pdf as pdf', () => {
    expect(getFileKind(makeFile({ mimetype: 'application/pdf', filetype: 'pdf' }))).toBe('pdf');
  });

  it('classifies pdf filetype as pdf even without MIME', () => {
    expect(getFileKind(makeFile({ mimetype: undefined, filetype: 'pdf' }))).toBe('pdf');
  });

  it('classifies image/gif as unsupported (not in whitelist)', () => {
    expect(getFileKind(makeFile({ mimetype: 'image/gif', filetype: 'gif' }))).toBe('unsupported');
  });

  it('classifies unknown MIME / filetype as unsupported', () => {
    expect(getFileKind(makeFile({ mimetype: 'application/zip', filetype: 'zip' }))).toBe('unsupported');
  });

  it('classifies file with no mimetype or filetype as unsupported', () => {
    expect(getFileKind(makeFile({ mimetype: undefined, filetype: undefined }))).toBe('unsupported');
  });
});

// ─── downloadFile — text files ────────────────────────────────────────────────

describe('downloadFile — text files', () => {
  it('returns kind=text with file label and content', async () => {
    mockFetchText('hello world');
    const result = await downloadFile(fakeClient, makeFile({ name: 'readme.txt' }), nopLog);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('text');
    if (result!.kind === 'text') {
      expect(result!.content).toContain('[File: readme.txt]');
      expect(result!.content).toContain('hello world');
    }
  });

  it('uses file title as label when name is absent', async () => {
    mockFetchText('content');
    const result = await downloadFile(
      fakeClient,
      makeFile({ name: undefined, title: 'My Doc', id: 'F999' }),
      nopLog
    );
    expect(result!.kind).toBe('text');
    if (result!.kind === 'text') expect(result!.content).toContain('[File: My Doc]');
  });

  it('falls back to file id when name and title are absent', async () => {
    mockFetchText('content');
    const result = await downloadFile(
      fakeClient,
      makeFile({ name: undefined, title: undefined, id: 'F999' }),
      nopLog
    );
    expect(result!.kind).toBe('text');
    if (result!.kind === 'text') expect(result!.content).toContain('[File: F999]');
  });

  it('sends Authorization header with bot token', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('data').buffer,
    });
    vi.stubGlobal('fetch', fetchSpy);
    await downloadFile(fakeClient, makeFile(), nopLog);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: 'Bearer xoxb-test-token' } })
    );
  });

  it('returns null when url_private_download is missing', async () => {
    const result = await downloadFile(
      fakeClient,
      makeFile({ url_private_download: undefined }),
      nopLog
    );
    expect(result).toBeNull();
  });

  it('returns null for unsupported file type', async () => {
    const result = await downloadFile(
      fakeClient,
      makeFile({ mimetype: 'application/zip', filetype: 'zip' }),
      nopLog
    );
    expect(result).toBeNull();
  });

  it('returns null when fetch returns non-OK status', async () => {
    mockFetchText('', 403);
    const result = await downloadFile(fakeClient, makeFile(), nopLog);
    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const result = await downloadFile(fakeClient, makeFile(), nopLog);
    expect(result).toBeNull();
  });

  it('truncates text files larger than 512 KB', async () => {
    const bigContent = 'x'.repeat(600 * 1024);
    mockFetchText(bigContent);
    const result = await downloadFile(fakeClient, makeFile({ size: 600 * 1024 }), nopLog);
    expect(result!.kind).toBe('text');
    if (result!.kind === 'text') {
      expect(result!.content).toContain('truncated');
      expect(result!.content.length).toBeLessThan(bigContent.length);
    }
  });
});

// ─── downloadFile — image files ───────────────────────────────────────────────

describe('downloadFile — image files', () => {
  it('returns kind=block with ImageBlockParam for JPEG', async () => {
    mockFetchBinary(Buffer.from([0xff, 0xd8])); // JPEG magic bytes
    const result = await downloadFile(
      fakeClient,
      makeFile({ name: 'photo.jpg', mimetype: 'image/jpeg', filetype: 'jpg' }),
      nopLog
    );
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('block');
    if (result!.kind === 'block') {
      expect(result!.block.type).toBe('image');
      const src = (result!.block as any).source;
      expect(src.type).toBe('base64');
      expect(src.media_type).toBe('image/jpeg');
      expect(typeof src.data).toBe('string');
      expect(src.data.length).toBeGreaterThan(0);
    }
  });

  it('returns kind=block with ImageBlockParam for PNG', async () => {
    mockFetchBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    const result = await downloadFile(
      fakeClient,
      makeFile({ name: 'chart.png', mimetype: 'image/png', filetype: 'png' }),
      nopLog
    );
    expect(result!.kind).toBe('block');
    if (result!.kind === 'block') {
      const src = (result!.block as any).source;
      expect(src.media_type).toBe('image/png');
    }
  });

  it('returns kind=block with ImageBlockParam for WebP', async () => {
    mockFetchBinary(Buffer.from('RIFF....WEBP'));
    const result = await downloadFile(
      fakeClient,
      makeFile({ name: 'image.webp', mimetype: 'image/webp', filetype: 'webp' }),
      nopLog
    );
    expect(result!.kind).toBe('block');
    if (result!.kind === 'block') {
      const src = (result!.block as any).source;
      expect(src.media_type).toBe('image/webp');
    }
  });

  it('uses filetype to derive media_type when MIME is absent', async () => {
    mockFetchBinary(Buffer.from([0xff, 0xd8]));
    const result = await downloadFile(
      fakeClient,
      makeFile({ mimetype: undefined, filetype: 'jpg' }),
      nopLog
    );
    expect(result!.kind).toBe('block');
    if (result!.kind === 'block') {
      expect((result!.block as any).source.media_type).toBe('image/jpeg');
    }
  });

  it('encodes image bytes as valid base64', async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    mockFetchBinary(bytes);
    const result = await downloadFile(
      fakeClient,
      makeFile({ mimetype: 'image/png', filetype: 'png' }),
      nopLog
    );
    if (result!.kind === 'block') {
      const decoded = Buffer.from((result!.block as any).source.data, 'base64');
      expect(decoded).toEqual(bytes);
    }
  });

  it('returns text error block for image exceeding 20 MB', async () => {
    const result = await downloadFile(
      fakeClient,
      makeFile({ mimetype: 'image/png', filetype: 'png', size: 21 * 1024 * 1024 }),
      nopLog
    );
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('text');
    if (result!.kind === 'text') expect(result!.content).toContain('too large');
  });
});

// ─── downloadFile — PDF files ─────────────────────────────────────────────────

describe('downloadFile — PDF files', () => {
  it('returns kind=block with DocumentBlockParam for PDF', async () => {
    mockFetchBinary(Buffer.from('%PDF-1.4'));
    const result = await downloadFile(
      fakeClient,
      makeFile({ name: 'report.pdf', mimetype: 'application/pdf', filetype: 'pdf' }),
      nopLog
    );
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('block');
    if (result!.kind === 'block') {
      expect(result!.block.type).toBe('document');
      const src = (result!.block as any).source;
      expect(src.type).toBe('base64');
      expect(src.media_type).toBe('application/pdf');
      expect(typeof src.data).toBe('string');
    }
  });

  it('sets title on DocumentBlockParam', async () => {
    mockFetchBinary(Buffer.from('%PDF-1.4'));
    const result = await downloadFile(
      fakeClient,
      makeFile({ name: 'summary.pdf', mimetype: 'application/pdf', filetype: 'pdf' }),
      nopLog
    );
    if (result!.kind === 'block') {
      expect((result!.block as any).title).toBe('summary.pdf');
    }
  });

  it('encodes PDF bytes as valid base64', async () => {
    const bytes = Buffer.from('%PDF-1.4 fake content');
    mockFetchBinary(bytes);
    const result = await downloadFile(
      fakeClient,
      makeFile({ mimetype: 'application/pdf', filetype: 'pdf' }),
      nopLog
    );
    if (result!.kind === 'block') {
      const decoded = Buffer.from((result!.block as any).source.data, 'base64');
      expect(decoded).toEqual(bytes);
    }
  });

  it('classifies pdf filetype without MIME as PDF', async () => {
    mockFetchBinary(Buffer.from('%PDF'));
    const result = await downloadFile(
      fakeClient,
      makeFile({ mimetype: undefined, filetype: 'pdf' }),
      nopLog
    );
    expect(result!.kind).toBe('block');
    if (result!.kind === 'block') {
      expect((result!.block as any).source.media_type).toBe('application/pdf');
    }
  });

  it('returns text error block for PDF exceeding 20 MB', async () => {
    const result = await downloadFile(
      fakeClient,
      makeFile({ mimetype: 'application/pdf', filetype: 'pdf', size: 25 * 1024 * 1024 }),
      nopLog
    );
    expect(result!.kind).toBe('text');
    if (result!.kind === 'text') expect(result!.content).toContain('too large');
  });
});
