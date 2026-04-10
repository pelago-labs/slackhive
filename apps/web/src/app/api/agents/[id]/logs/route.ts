/**
 * @fileoverview GET /api/agents/[id]/logs
 * Server-Sent Events (SSE) stream of live runner logs for a specific agent.
 *
 * Supports two modes:
 * - Docker mode: reads from runner container's stdout via `docker logs`
 * - Native mode: reads from the log file at ~/.slackhive/logs/runner.log
 *
 * @module web/api/agents/[id]/logs
 */

import { NextRequest } from 'next/server';
import { getAgentById } from '@/lib/db';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * GET /api/agents/[id]/logs
 * Returns an SSE stream of filtered log lines for the agent.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const agent = await getAgentById(id).catch(() => null);
  const slug = agent?.slug ?? id;

  const encoder = new TextEncoder();
  const isDocker = process.env.DATABASE_TYPE !== 'sqlite' && fs.existsSync('/var/run/docker.sock');

  const stream = new ReadableStream({
    start(controller) {
      function send(line: string) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
        } catch { /* stream closed */ }
      }

      // Match lines for this agent OR general system lines (no agent field)
      function isRelevantLine(line: string): boolean {
        if (line.includes(`"agent":"${slug}"`)) return true;
        // Also show system-level logs (startup, errors without agent context)
        if (!line.includes('"agent":')) return true;
        return false;
      }

      function processLines(data: string, partialBuffer: { value: string }) {
        partialBuffer.value += data;
        const lines = partialBuffer.value.split('\n');
        partialBuffer.value = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() && isRelevantLine(line)) send(line);
        }
      }

      if (isDocker) {
        // Docker mode: tail container logs
        const proc = spawn('docker', [
          'logs', '--follow', '--tail=200',
          'slackhive-runner-1',
        ]);

        const buffer = { value: '' };
        proc.stdout.on('data', (chunk: Buffer) => processLines(chunk.toString(), buffer));
        proc.stderr.on('data', (chunk: Buffer) => processLines(chunk.toString(), buffer));
        proc.on('close', () => {
          try { controller.close(); } catch { /* already closed */ }
        });
        _req.signal.addEventListener('abort', () => {
          proc.kill();
          try { controller.close(); } catch { /* already closed */ }
        });
      } else {
        // Native mode: tail the log file
        const logDir = process.env.LOG_DIR ?? path.join(
          process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
          '.slackhive', 'logs'
        );
        const logFile = path.join(logDir, 'runner.log');

        if (!fs.existsSync(logFile)) {
          send(JSON.stringify({ level: 'info', message: 'Waiting for runner logs...', timestamp: new Date().toISOString() }));
        }

        // Use tail -F (capital F follows by name, survives rotation)
        const proc = spawn('tail', ['-n', '200', '-F', logFile]);

        const buffer = { value: '' };
        proc.stdout.on('data', (chunk: Buffer) => processLines(chunk.toString(), buffer));
        proc.stderr.on('data', () => {}); // Suppress tail stderr (e.g. "file truncated")
        proc.on('close', () => {
          try { controller.close(); } catch { /* already closed */ }
        });
        _req.signal.addEventListener('abort', () => {
          proc.kill();
          try { controller.close(); } catch { /* already closed */ }
        });
      }
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
