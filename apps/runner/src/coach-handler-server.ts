/**
 * @fileoverview Adapter between the runner's internal HTTP server and the
 * coach handler. Parses the request, runs a coach turn, and emits
 * Server-Sent Events back to the web process, which pipes them to the browser.
 *
 * Request body (JSON):
 *   { agentId: string, userMessage: string, attachment?: string,
 *     autoApply?: boolean }
 *
 * Response: `text/event-stream` with events documented in {@link CoachStreamEvent}.
 *
 * @module runner/coach-handler-server
 */
import type { ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import type { CoachMessage } from '@slackhive/shared';
import {
  runCoachTurn,
  loadCoachSession,
  saveCoachSession,
  type CoachStreamEvent,
} from './coach-handler';
import { logger } from './logger';

function writeSse(res: ServerResponse, event: CoachStreamEvent): void {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch (err) {
    logger.warn('coach: failed to write SSE event', { error: (err as Error).message });
  }
}

export async function handleCoachStream(
  body: string,
  res: ServerResponse,
): Promise<void> {
  let parsed: { agentId?: string; userMessage?: string; attachment?: string; autoApply?: boolean };
  try { parsed = JSON.parse(body); }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }

  const agentId = parsed.agentId;
  const userMessage = (parsed.userMessage ?? '').trim();
  if (!agentId || !userMessage) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agentId and userMessage required' }));
    return;
  }
  const autoApply = !!parsed.autoApply;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Load prior session to resume.
  const prior = await loadCoachSession(agentId) as {
    sdkSessionId?: string;
    messages?: CoachMessage[];
  };
  const priorMessages: CoachMessage[] = Array.isArray(prior.messages) ? prior.messages : [];

  // Capture the user message immediately so UI can show optimistic state on reload.
  const userMsg: CoachMessage = {
    id: randomUUID(),
    role: 'user',
    text: parsed.attachment ? `${userMessage}\n\n[attachment: failed conversation]` : userMessage,
    createdAt: new Date().toISOString(),
  };

  // Write an "in-progress" snapshot BEFORE calling the model so the
  // Instructions tab (which may already be open / polling) can render
  // the user bubble + a drafting indicator while the turn runs.
  const draftingMsg: CoachMessage = {
    id: randomUUID(),
    role: 'assistant',
    text: '',
    toolCalls: [],
    proposals: [],
    createdAt: new Date().toISOString(),
    inProgress: true,
  };
  await saveCoachSession(agentId, {
    sdkSessionId: prior.sdkSessionId,
    messages: [...priorMessages, userMsg, draftingMsg].slice(-50),
  });

  try {
    const result = await runCoachTurn({
      agentId,
      userMessage,
      attachment: parsed.attachment,
      sdkSessionId: prior.sdkSessionId,
      autoApply,
      emit: (ev) => writeSse(res, ev),
    });

    const assistantMsg: CoachMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: result.assistantText,
      toolCalls: result.toolCalls,
      proposals: result.proposals,
      createdAt: new Date().toISOString(),
    };

    await saveCoachSession(agentId, {
      sdkSessionId: result.sdkSessionId ?? prior.sdkSessionId,
      messages: [...priorMessages, userMsg, assistantMsg].slice(-50),
    });
  } catch (err) {
    // Error already emitted by runCoachTurn. Still persist the user message so
    // the thread isn't lost.
    await saveCoachSession(agentId, {
      sdkSessionId: prior.sdkSessionId,
      messages: [...priorMessages, userMsg].slice(-50),
    });
    logger.error('coach turn aborted', { agentId, error: (err as Error).message });
  } finally {
    res.end();
  }
}
