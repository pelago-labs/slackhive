/**
 * @fileoverview SSE handler for the runner's /test endpoint.
 *
 * Runs a test-mode turn against the agent's real runtime (ClaudeHandler +
 * MessageHandler) but with a TestAdapter instead of a platform adapter, so
 * the response streams back into the SlackHive UI instead of posting to
 * Slack/Discord/Telegram.
 *
 * Multi-agent (boss delegating to specialists) is handled by the
 * {@link TestOrchestrator}: when a participant's outgoing payload contains
 * `<@U...>` mentions, the orchestrator lazy-spins each mentioned agent as
 * its own participant in the same session and injects the sender's message
 * as if Slack had delivered an `app_mention`. That runs fully here; nothing
 * hits a real Slack workspace.
 *
 * Session lifecycle is owned by AgentRunner:
 *   - getOrCreateTeamSession lazily spins the session + root participant
 *   - ensureParticipant (called by the orchestrator) lazy-adds more
 *   - destroyTestSession tears everything down on DELETE or idle
 *
 * @module runner/test-handler-server
 */
import type { ServerResponse } from 'http';
import type { AgentRunner } from './agent-runner';
import type { TestEvent } from './adapters/test-adapter';
import { TestOrchestrator } from './test-orchestrator';
import { logger } from './logger';

function writeSse(res: ServerResponse, event: TestEvent): void {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch (err) {
    logger.warn('test: failed to write SSE event', { error: (err as Error).message });
  }
}

export async function handleTestStream(
  body: string,
  res: ServerResponse,
  runner: AgentRunner,
): Promise<void> {
  let parsed: { agentId?: string; sessionId?: string; message?: string; user?: string | null };
  try { parsed = JSON.parse(body); }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }

  const agentId = parsed.agentId;
  const sessionId = parsed.sessionId;
  const message = (parsed.message ?? '').trim();
  const user = parsed.user?.trim() || null;
  if (!agentId || !sessionId || !message) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agentId, sessionId, message required' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let session;
  try {
    session = await runner.getOrCreateTeamSession(agentId, sessionId);
  } catch (err) {
    writeSse(res, { type: 'error', message: (err as Error).message });
    writeSse(res, { type: 'done' });
    res.end();
    return;
  }

  const orchestrator = new TestOrchestrator(runner, session, ev => writeSse(res, ev));

  try {
    await orchestrator.runTurn(message, user);
    writeSse(res, { type: 'done' });
  } catch (err) {
    writeSse(res, { type: 'error', message: (err as Error).message });
    writeSse(res, { type: 'done' });
    logger.error('test turn failed', { agentId, sessionId, error: (err as Error).message });
  } finally {
    // Reset every participant's emit to a no-op so any stray async writes
    // after `done` don't crash on the closed response.
    for (const p of session.participants.values()) {
      p.adapter.setEmit(() => {});
      p.adapter.setOutgoingHook(async () => {});
    }
    res.end();
  }
}

export async function handleTestDelete(
  body: string,
  res: ServerResponse,
  runner: AgentRunner,
): Promise<void> {
  let parsed: { agentId?: string; sessionId?: string };
  try { parsed = JSON.parse(body); }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  if (!parsed.agentId || !parsed.sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agentId and sessionId required' }));
    return;
  }
  await runner.destroyTestSession(parsed.agentId, parsed.sessionId);
  res.writeHead(204);
  res.end();
}
