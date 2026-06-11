/**
 * @fileoverview OpenTelemetry bootstrap for the runner's LLM tracing.
 *
 * We instrument the agent loop with the real OTel API (GenAI semantic
 * conventions) and persist finished spans to our own SQLite via
 * {@link DbSpanExporter} — the "internal Langfuse". A `SimpleSpanProcessor`
 * exports each span the moment it ends, so the trace fills in near-live as a
 * turn progresses. Optionally, when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the
 * same spans can ALSO be shipped to an external OTLP backend (Langfuse/Phoenix)
 * — wired in Phase 4; the in-app view is the primary surface.
 *
 * Parent/child nesting is done by passing an explicit parent context to
 * `startSpan` (see turn-tracer.ts) rather than a global context manager, so we
 * don't need async-hooks plumbing across the streaming iterator.
 *
 * @module runner/tracing/otel
 */

import { trace, type Tracer } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { DbSpanExporter } from './db-span-exporter';

/** Attribute keys we set on spans — GenAI semconv plus a few `slackhive.*`
 * extensions. The exporter reads these to promote columns. Keep in sync with
 * {@link DbSpanExporter}. */
export const ATTR = {
  OPERATION: 'gen_ai.operation.name',
  KIND: 'slackhive.kind',
  CONVERSATION_ID: 'gen_ai.conversation.id',
  ACTIVITY_ID: 'slackhive.activity.id',
  AGENT_ID: 'gen_ai.agent.id',
  AGENT_NAME: 'gen_ai.agent.name',
  PROVIDER: 'gen_ai.provider.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  REASONING_TOKENS: 'slackhive.usage.reasoning_tokens',
  CACHE_READ_TOKENS: 'slackhive.usage.cache_read_tokens',
  CACHE_CREATION_TOKENS: 'slackhive.usage.cache_creation_tokens',
  COST_USD: 'slackhive.cost_usd',
  FINISH_REASON: 'gen_ai.response.finish_reasons',
  TOOL_NAME: 'gen_ai.tool.name',
  INPUT: 'gen_ai.input',
  OUTPUT: 'gen_ai.output',
  REASONING: 'slackhive.reasoning',
  SENSITIVE: 'slackhive.sensitive',
  SENSITIVE_CATEGORIES: 'slackhive.sensitive.categories',
  SENSITIVE_REASON: 'slackhive.sensitive.reason',
} as const;

let _provider: BasicTracerProvider | null = null;
let _tracer: Tracer | null = null;

/** Lazily build the tracer + provider on first use. The DB exporter resolves
 * `getDb()` at export time, by which point the runner has called `initDb()`. */
export function getTracer(): Tracer {
  if (!_tracer) {
    _provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'slackhive-runner' }),
      spanProcessors: [new SimpleSpanProcessor(new DbSpanExporter())],
    });
    _tracer = _provider.getTracer('slackhive-agent');
  }
  return _tracer;
}

/** Flush + shut down the provider (called on runner shutdown). Best-effort. */
export async function shutdownTracing(): Promise<void> {
  try { await _provider?.forceFlush(); } catch { /* best-effort */ }
  try { await _provider?.shutdown(); } catch { /* best-effort */ }
}
