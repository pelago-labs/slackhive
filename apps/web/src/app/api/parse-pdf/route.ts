import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    if (!file.type.includes('pdf')) return NextResponse.json({ error: 'File must be a PDF' }, { status: 400 });
    if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: 'PDF too large (max 10MB)' }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pages.push(content.items.map((item: any) => item.str ?? '').join(' '));
    }
    const text = pages.join('\n\n').trim();

    if (!text) return NextResponse.json({ error: 'Could not extract text from PDF. It may be scanned or image-based.' }, { status: 422 });

    return NextResponse.json({ text, pages: pdf.numPages });
  } catch (err) {
    return NextResponse.json({ error: `Failed to parse PDF: ${(err as Error).message}` }, { status: 500 });
  }
}
