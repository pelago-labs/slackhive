/**
 * @fileoverview Tests for `extractFileText` — the server-side helper that
 * turns an uploaded file buffer into text for storage in knowledge_sources.
 * Routes PDFs through pdf-parse; utf-8 decodes text formats; rejects
 * unsupported extensions with null.
 *
 * @module web/lib/__tests__/knowledge-extract
 */
import { describe, it, expect } from 'vitest';
import { extractFileText } from '@/lib/knowledge-extract';

describe('extractFileText', () => {
  it('decodes .md / .txt / .json / .yaml etc. as utf-8', async () => {
    const cases = [
      { name: 'notes.md',   body: '# Hello\nworld' },
      { name: 'rows.csv',   body: 'a,b\n1,2' },
      { name: 'data.json',  body: '{"ok":true}' },
      { name: 'doc.html',   body: '<p>hi</p>' },
      { name: 'cfg.yaml',   body: 'key: value' },
      { name: 'out.txt',    body: 'plain text' },
    ];
    for (const c of cases) {
      const got = await extractFileText(Buffer.from(c.body, 'utf8'), c.name, '');
      expect(got).toBe(c.body);
    }
  });

  it('returns null for unsupported extensions', async () => {
    const got = await extractFileText(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'logo.png', 'image/png');
    expect(got).toBeNull();
  });

  it('returns null for no-extension inputs (defensive)', async () => {
    const got = await extractFileText(Buffer.from('anything'), 'no-ext', '');
    expect(got).toBeNull();
  });

  it('respects extension case — .PDF / .MD are still accepted', async () => {
    const got = await extractFileText(Buffer.from('# Shout'), 'LOUD.MD', '');
    expect(got).toBe('# Shout');
  });

  it('extracts text from a PDF via pdf-parse', async () => {
    // Minimal inline PDF with a text object saying "hello".
    // Hand-crafted bytes so the test doesn't depend on a fixture file.
    const pdf = Buffer.from(
      '%PDF-1.3\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n' +
      '4 0 obj\n<< /Length 44 >>\nstream\n' +
      'BT /F1 12 Tf 50 100 Td (hello-pdf) Tj ET\n' +
      'endstream\nendobj\n' +
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
      'xref\n0 6\n' +
      '0000000000 65535 f \n' +
      '0000000009 00000 n \n' +
      '0000000060 00000 n \n' +
      '0000000114 00000 n \n' +
      '0000000221 00000 n \n' +
      '0000000303 00000 n \n' +
      'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n369\n%%EOF\n',
      'utf8'
    );

    const got = await extractFileText(pdf, 'greeting.pdf', 'application/pdf');
    // pdf-parse may normalize whitespace; just assert the text is present.
    expect(got).not.toBeNull();
    expect(got!).toContain('hello-pdf');
  });
});
