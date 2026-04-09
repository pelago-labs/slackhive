/**
 * @fileoverview GET /api/agents/[id]/logs
 * Server-Sent Events (SSE) stream of live runner logs for a specific agent.
 * Reads from the runner container's stdout via Docker logs API.
 *
 * NOTE: In Docker Compose, this uses `docker logs --follow --tail=100 <runner>`.
 * The runner prefixes each log line with `[agentSlug]` so we filter by agent.
 *
 * @module web/api/agents/[id]/logs
 */

import { NextRequest } from 'next/server';
import { getAgentById } from '@/lib/db';
import { spawn } from 'child_process';

/**
 * GET /api/agents/[id]/logs
 * Returns an SSE stream of filtered log lines for the agent.
 *
 * @param {NextRequest} _req
 * @param {{ params: Promise<{ id: string }> }} ctx
 * @returns {Response} SSE stream.
 */
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
      // Tail the runner container logs, filtering for lines containing [slug]
      const proc = spawn('docker', [
        'logs', '--follow', '--tail=200',
        'slackhive-runner-1',
      ]);

      function send(line: string) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      }

      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.includes(`"agent":"${slug}"`)) send(line);
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.includes(`"agent":"${slug}"`)) send(line);
        }
      });

      proc.on('close', () => {
        try { controller.close(); } catch { /* already closed */ }
      });

      // Clean up if client disconnects
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
