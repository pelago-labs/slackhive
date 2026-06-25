/**
 * @fileoverview Per-case SSE runner — executes one eval case against an
 * agent by hitting the runner's /test endpoint, consuming the SSE stream,
 * and returning a structured trace.
 *
 * Server-side only. Talks to the runner directly at
 * http://127.0.0.1:RUNNER_INTERNAL_PORT/test rather than going through
 * slackhive's web /api/agents/[id]/test proxy.
 *
 * Trace shape:
 *   { finalReply, toolCalls, errored, errorMessage? }
 *
 * The `finalReply` is the concatenated text emitted by the *target agent
 * being evaluated*. If a boss agent delegates to specialists, their text
 * events are excluded — only `ev.agent.id === agentId` matches.
 *
 * @module web/lib/evals/run-case
 */

import type { ToolCallTrace } from '@slackhive/shared';
import { runnerBase } from '@/lib/runner';

export interface Trace {
  finalReply: string;
  toolCalls: ToolCallTrace[];
  /** True if the runner emitted an `error` SSE event mid-stream. */
  errored: boolean;
  errorMessage?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Runs one case against an agent.
 *
 * @param agentId   The target agent's id.
 * @param question  The user message to send.
 * @param sessionId Caller-provided session id (typically a fresh UUID).
 *                  Reusing one across cases shares the agent's context.
 * @param opts.timeoutMs  Hard timeout in ms (default 120000).
 */
export async function runCase(
  agentId: string,
  question: string,
  sessionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<Trace> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const res = await fetch(`${runnerBase()}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId, message: question, user: null }),
      signal: abort.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Runner /test responded ${res.status} ${res.statusText}: ${text}`);
    }

    return await consumeStream(res.body, agentId);
  } finally {
    clearTimeout(timer);
  }
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  agentId: string,
): Promise<Trace> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const textByAgent = new Map<string, string>();
  const toolCalls: ToolCallTrace[] = [];
  let errored = false;
  let errorMessage: string | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';

    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(6)) as RunnerEvent;
        handleEvent(ev, agentId, textByAgent, toolCalls, (msg) => {
          errored = true;
          errorMessage = msg;
        });
      } catch {
        // malformed frame — skip
      }
    }
  }

  return {
    finalReply: textByAgent.get(agentId) ?? '',
    toolCalls,
    errored,
    errorMessage,
  };
}

type RunnerEvent =
  | { type: 'text'; content?: string; agent?: { id?: string; name?: string } }
  | { type: 'tool'; name?: string; input?: unknown; agent?: { id?: string; name?: string } }
  | { type: 'notice'; text?: string; agent?: { id?: string; name?: string } }
  | { type: 'error'; message?: string; text?: string }
  | { type: 'done' };

function handleEvent(
  ev: RunnerEvent,
  agentId: string,
  textByAgent: Map<string, string>,
  toolCalls: ToolCallTrace[],
  reportError: (msg: string) => void,
): void {
  if (ev.type === 'text') {
    const id = ev.agent?.id ?? agentId;
    textByAgent.set(id, (textByAgent.get(id) ?? '') + (ev.content ?? ''));
    return;
  }
  if (ev.type === 'tool') {
    toolCalls.push({
      toolId: String(ev.name ?? ''),
      input: ev.input && typeof ev.input === 'object'
        ? (ev.input as Record<string, unknown>)
        : {},
    });
    return;
  }
  if (ev.type === 'error') {
    reportError(String(ev.message ?? ev.text ?? 'Runner reported an error'));
    return;
  }
  // 'notice' and 'done' are no-ops for eval purposes
}

/**
 * Tears down a runner test session. Best-effort — swallows errors since
 * the orchestrator is already past the point of caring (we have the trace).
 */
export async function cleanupCaseSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${runnerBase()}/test`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch {
    // best-effort
  }
}
