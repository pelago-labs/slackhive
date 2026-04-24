/**
 * @fileoverview Helpers for extracting text from uploaded knowledge-base files.
 *
 * PDFs go through pdf-parse; whitelisted text extensions are decoded as utf-8.
 * Kept in lib/ (not app/) because Next.js only permits a fixed set of exports
 * from a route.ts module.
 *
 * @module web/lib/knowledge-extract
 */

const TEXT_EXTS = new Set([
  '.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.rst',
]);

/**
 * Pull text out of an uploaded file buffer. Returns null for unsupported types
 * so the caller can respond 415.
 */
export async function extractFileText(buf: Buffer, filename: string, mime: string): Promise<string | null> {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  if (ext === '.pdf' || mime === 'application/pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const out = await parser.getText();
      return out.text ?? '';
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  if (TEXT_EXTS.has(ext)) return buf.toString('utf8');
  return null;
}
