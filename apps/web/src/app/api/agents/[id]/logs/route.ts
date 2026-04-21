/**
 * @fileoverview GET /api/agents/[id]/logs
 * Server-Sent Events (SSE) stream of live runner logs for a specific agent.
 * Reads from the log file at ~/.slackhive/logs/runner.log.
 *
 * @module web/api/agents/[id]/logs
 */

import { NextRequest } from 'next/server';
import { getAgentById } from '@/lib/db';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const agent = await getAgentById(id).catch(() => null);
  const slug = agent?.slug ?? id;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      function send(line: string) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
        } catch { /* stream closed */ }
      }

      function isRelevantLine(line: string): boolean {
        return line.includes(`"agent":"${slug}"`);
      }

      function processLines(data: string, partialBuffer: { value: string }) {
        partialBuffer.value += data;
        const lines = partialBuffer.value.split('\n');
        partialBuffer.value = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() && isRelevantLine(line)) send(line);
        }
      }

      const logDir = process.env.LOG_DIR ?? path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
        '.slackhive', 'logs'
      );
      const logFile = path.join(logDir, 'runner.log');

      if (!fs.existsSync(logFile)) {
        send(JSON.stringify({ level: 'info', message: 'Waiting for runner logs...', timestamp: new Date().toISOString() }));
      }

      const proc = spawn('tail', ['-n', '200', '-F', logFile]);

      const buffer = { value: '' };
      proc.stdout.on('data', (chunk: Buffer) => processLines(chunk.toString(), buffer));
      proc.stderr.on('data', () => {});
      proc.on('close', () => {
        try { controller.close(); } catch { /* already closed */ }
      });
      _req.signal.addEventListener('abort', () => {
        proc.kill();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
