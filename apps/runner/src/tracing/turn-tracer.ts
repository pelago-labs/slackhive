/**
 * @fileoverview TurnTracer — drives the OpenTelemetry span tree for one agent
 * turn, so the message-handler can stay readable. One `invoke_agent` span per
 * turn (parent), a `generation` span per assistant LLM step (carrying reasoning
 * + text), an `execute_tool` span per tool call (full args/result), and `event`
 * spans for system markers.
 *
 * Timing model: tool spans use real start (tool_use seen) → end (tool_result
 * seen). Generation spans can't be observed starting (the SDK only hands us the
 * finished assistant message), so we approximate their start as the end of the
 * previous step (`lastBoundaryMs`) — i.e. the LLM "think + generate" gap. This
 * yields a clean, accurate waterfall.
 *
 * Content (input/output/reasoning) is gated by `TRACE_CAPTURE_CONTENT` (default
 * on; `=0` stores ~2 KB previews only).
 *
 * @module runner/tracing/turn-tracer
 */

import { type Span, type Attributes, trace, context, SpanStatusCode } from '@opentelemetry/api';
import { getTracer, ATTR } from './otel';
import { detectSensitive, detectInText, mergeHits, egressKind, type SensitiveHit } from '@slackhive/shared';
import { computeFps, type FpEntry } from './fingerprint';

const PREVIEW_LIMIT = 2000;

function captureContent(): boolean {
  return process.env.TRACE_CAPTURE_CONTENT !== '0';
}

/** Full body when capture is on, else a ~2 KB preview. */
function body(s: string | null | undefined): string | undefined {
  if (s == null || s === '') return undefined;
  if (captureContent()) return s;
  return s.length > PREVIEW_LIMIT ? s.slice(0, PREVIEW_LIMIT - 1) + '…' : s;
}

export interface BeginTurnInput {
  sessionId: string;
  activityId: string;
  agentId: string;
  agentName: string;
  provider: string;
  model: string;
  userMessage?: string;
  initiatorKind: 'user' | 'agent';
  initiatorUserId?: string;
  initiatorHandle?: string;
  /** Per-agent sensitivity mode. `off` skips all detection/flows. @default 'deterministic' */
  sensitivityCheck?: 'off' | 'deterministic' | 'smart';
}

export interface GenerationInput {
  reasoning?: string;
  text?: string;
  toolNames?: string[];
  finishReason?: string;
}

export interface TurnEndInput {
  finalAnswer?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  finishReason?: string;
  status: 'ok' | 'error';
  errorMessage?: string;
}

export class TurnTracer {
  private readonly turn: Span;
  private readonly ctx: ReturnType<typeof trace.setSpan>;
  private readonly base: Attributes;
  private readonly model: string;
  /** When false (mode 'off'), detection + flow fingerprinting are skipped. */
  private readonly detect: boolean;
  private lastBoundaryMs: number;
  private readonly tools = new Map<string, { span: Span; name: string; args?: string }>();
  private readonly hits: (SensitiveHit | null)[] = [];
  private ended = false;

  constructor(input: BeginTurnInput) {
    this.base = {
      [ATTR.CONVERSATION_ID]: input.sessionId,
      [ATTR.ACTIVITY_ID]: input.activityId,
      [ATTR.AGENT_ID]: input.agentId,
      [ATTR.PROVIDER]: input.provider,
    };
    this.turn = getTracer().startSpan(`invoke_agent ${input.agentName}`, {
      attributes: {
        ...this.base,
        [ATTR.OPERATION]: 'invoke_agent',
        [ATTR.KIND]: 'agent',
        [ATTR.AGENT_NAME]: input.agentName,
        [ATTR.REQUEST_MODEL]: input.model,
        'slackhive.initiator.kind': input.initiatorKind,
        ...(input.initiatorUserId ? { 'slackhive.initiator.user_id': input.initiatorUserId } : {}),
        ...(input.initiatorHandle ? { 'slackhive.initiator.handle': input.initiatorHandle } : {}),
        ...(body(input.userMessage) ? { [ATTR.INPUT]: body(input.userMessage)! } : {}),
      },
    });
    this.model = input.model;
    this.detect = input.sensitivityCheck !== 'off';
    this.ctx = trace.setSpan(context.active(), this.turn);
    this.lastBoundaryMs = Date.now();
    // The user's message is a flow SOURCE (sensitive values entering the turn).
    if (this.detect) setFps(this.turn, computeFps(input.userMessage, 'text', 'source'));
  }

  /** Record one assistant LLM step as a `generation` span spanning the gap
   * since the previous step. Reasoning + text are stored as content (gated). */
  recordGeneration(input: GenerationInput): void {
    const now = Date.now();
    const start = Math.min(this.lastBoundaryMs, now);
    const attrs: Attributes = {
      ...this.base,
      [ATTR.OPERATION]: 'chat',
      [ATTR.KIND]: 'generation',
      [ATTR.RESPONSE_MODEL]: this.model,
    };
    if (body(input.reasoning)) attrs[ATTR.REASONING] = body(input.reasoning)!;
    if (body(input.text)) attrs[ATTR.OUTPUT] = body(input.text)!;
    if (input.toolNames?.length) attrs['slackhive.tool_requests'] = input.toolNames.join(', ');
    if (input.finishReason) attrs[ATTR.FINISH_REASON] = input.finishReason;
    const span = getTracer().startSpan('chat', { startTime: start, attributes: attrs }, this.ctx);
    // Scan the model's OWN output (answer/reasoning) for PII/secrets/sensitive data
    // — the tool-call path never sees this, so e.g. a phone number the agent writes
    // into its reply would otherwise go unflagged. Bubbles up to the turn via hits.
    if (this.detect) {
      const hit = detectInText(`${input.reasoning ?? ''}\n${input.text ?? ''}`);
      if (hit) { applySensitive(span, hit); this.hits.push(hit); }
      // The model's visible answer text is a flow SINK (data heading to Slack).
      setFps(span, computeFps(input.text, 'text', 'sink'));
    }
    span.end(now);
    this.lastBoundaryMs = now;
  }

  /** Tool execution started (a `tool_use` block was seen). */
  beginTool(toolUseId: string, name: string, input: unknown): void {
    const attrs: Attributes = {
      ...this.base,
      [ATTR.OPERATION]: 'execute_tool',
      [ATTR.KIND]: 'tool',
      [ATTR.TOOL_NAME]: name,
    };
    const args = safeJson(input);
    if (body(args)) attrs[ATTR.INPUT] = body(args)!;
    const span = getTracer().startSpan(`execute_tool ${name}`, { attributes: attrs }, this.ctx);
    this.tools.set(toolUseId, { span, name, args });
  }

  /** Tool execution finished (matching `tool_result` arrived). Runs sensitivity
   * detection on the tool name + full args/result (regardless of the content
   * flag — detection sees the real values, only privacy-safe tags are stored). */
  endTool(toolUseId: string, output: string | null, isError: boolean): void {
    const entry = this.tools.get(toolUseId);
    if (!entry) return;
    const { span, name, args } = entry;
    const out = body(output);
    if (out) span.setAttribute(ATTR.OUTPUT, out);
    if (isError) span.setStatus({ code: SpanStatusCode.ERROR });

    if (this.detect) {
      const hit = detectSensitive(name, args, output ?? undefined);
      if (hit) applySensitive(span, hit);
      this.hits.push(hit);

      // Flow roles: the tool's RESULT is a source (data the agent now holds); if the
      // tool is an outbound sink, sensitive values in its ARGS are data leaving.
      const fps: FpEntry[] = computeFps(output, 'all', 'source');
      if (egressKind(name, args)) fps.push(...computeFps(args, 'all', 'sink'));
      setFps(span, fps);
    }

    span.end();
    this.tools.delete(toolUseId);
    this.lastBoundaryMs = Date.now();
  }

  /** A system marker (e.g. context_reset) as a zero-duration `event` span. */
  recordEvent(name: string): void {
    const now = Date.now();
    const span = getTracer().startSpan(name, {
      startTime: now,
      attributes: { ...this.base, [ATTR.KIND]: 'event' },
    }, this.ctx);
    span.end(now);
  }

  /** Close the turn span with totals + final answer. Closes any dangling tool
   * spans first (e.g. on error/abort). Idempotent. */
  end(input: TurnEndInput): void {
    if (this.ended) return;
    this.ended = true;
    for (const [, { span }] of this.tools) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'interrupted' });
      span.end();
    }
    this.tools.clear();

    // Bubble sensitivity up to the turn span so the session/turn is flagged.
    const merged = mergeHits(this.hits);
    if (merged) applySensitive(this.turn, merged);

    const a: Attributes = {};
    if (body(input.finalAnswer)) a[ATTR.OUTPUT] = body(input.finalAnswer)!;
    if (input.inputTokens != null) a[ATTR.INPUT_TOKENS] = input.inputTokens;
    if (input.outputTokens != null) a[ATTR.OUTPUT_TOKENS] = input.outputTokens;
    if (input.reasoningTokens != null) a[ATTR.REASONING_TOKENS] = input.reasoningTokens;
    if (input.cacheReadTokens != null) a[ATTR.CACHE_READ_TOKENS] = input.cacheReadTokens;
    if (input.cacheCreationTokens != null) a[ATTR.CACHE_CREATION_TOKENS] = input.cacheCreationTokens;
    if (input.costUsd != null) a[ATTR.COST_USD] = input.costUsd;
    if (input.finishReason) a[ATTR.FINISH_REASON] = input.finishReason;
    this.turn.setAttributes(a);
    if (input.status === 'error') {
      this.turn.setStatus({ code: SpanStatusCode.ERROR, message: input.errorMessage });
    }
    this.turn.end();
  }
}

function safeJson(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/** Tag a span as sensitive (privacy-safe: categories + reason tags, no values). */
function applySensitive(span: Span, hit: SensitiveHit): void {
  span.setAttribute(ATTR.SENSITIVE, true);
  span.setAttribute(ATTR.SENSITIVE_CATEGORIES, hit.categories.join(','));
  span.setAttribute(ATTR.SENSITIVE_REASON, hit.reason);
  span.setAttribute(ATTR.SENSITIVE_SEVERITY, hit.severity);
}

/** Stash privacy-safe per-match fingerprints (source/sink roles) for flow lineage. */
function setFps(span: Span, fps: FpEntry[]): void {
  if (fps.length) span.setAttribute(ATTR.SENSITIVE_FPS, JSON.stringify(fps));
}
