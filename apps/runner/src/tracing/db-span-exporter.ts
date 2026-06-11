/**
 * @fileoverview A custom OpenTelemetry SpanExporter that persists finished
 * spans to our SQLite `spans` table. This is the storage half of the in-app
 * "internal Langfuse" — instrumentation emits standard GenAI spans, this turns
 * them into queryable rows for the session/trace UI.
 *
 * It reads the `gen_ai.*` / `slackhive.*` attributes set by turn-tracer.ts and
 * promotes the hot ones to columns, stashing the full attribute bag as JSON.
 *
 * @module runner/tracing/db-span-exporter
 */

import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type { HrTime } from '@opentelemetry/api';
import { getDb } from '@slackhive/shared';
import { ATTR } from './otel';

/** HrTime ([seconds, nanos]) → integer epoch milliseconds. */
function hrToMs(t: HrTime): number {
  return Math.round(t[0] * 1000 + t[1] / 1e6);
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

export class DbSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      const db = getDb();
      const writes: Promise<unknown>[] = [];
      for (const span of spans) {
        const a = span.attributes;
        const ctx = span.spanContext();
        // OTel 2.x exposes the parent as `parentSpanContext`; older as `parentSpanId`.
        const parentId =
          (span as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
          (span as { parentSpanId?: string }).parentSpanId ??
          null;

        const kind = str(a[ATTR.KIND]) ?? 'event';
        const model = str(a[ATTR.RESPONSE_MODEL]) ?? str(a[ATTR.REQUEST_MODEL]);
        const status = span.status.code === 2 ? 'error' : 'ok';

        // The hot content (input/output/reasoning) is already promoted to its
        // own columns; keep only the non-content attributes in the JSON blob so
        // we don't store the full bodies twice (≈2x spans-table size).
        const meta: Record<string, unknown> = {};
        for (const k of Object.keys(a)) {
          if (k === ATTR.INPUT || k === ATTR.OUTPUT || k === ATTR.REASONING) continue;
          meta[k] = a[k];
        }

        // The adapter runs better-sqlite3 synchronously under the promise, so
        // the row is persisted by the time query() returns. Collect the
        // promises so we report a real result (and surface failures) instead of
        // a premature SUCCESS.
        writes.push(db.query(
          `INSERT INTO spans (
             span_id, trace_id, parent_span_id, session_id, activity_id,
             kind, name, agent_id, provider, model,
             start_ms, end_ms, status, status_message,
             input_tokens, output_tokens, reasoning_tokens,
             cache_read_tokens, cache_creation_tokens, cost_usd,
             finish_reason, tool_name, input, output, reasoning,
             sensitive, sensitive_categories, sensitive_reason, attributes
           ) VALUES (
             $1,$2,$3,$4,$5, $6,$7,$8,$9,$10,
             $11,$12,$13,$14, $15,$16,$17, $18,$19,$20,
             $21,$22,$23,$24,$25, $26,$27,$28,$29
           )
           ON CONFLICT (span_id) DO NOTHING`,
          [
            ctx.spanId,
            ctx.traceId,
            parentId,
            str(a[ATTR.CONVERSATION_ID]) ?? '',
            str(a[ATTR.ACTIVITY_ID]),
            kind,
            span.name,
            str(a[ATTR.AGENT_ID]),
            str(a[ATTR.PROVIDER]),
            model,
            hrToMs(span.startTime),
            hrToMs(span.endTime),
            status,
            span.status.message ?? null,
            num(a[ATTR.INPUT_TOKENS]),
            num(a[ATTR.OUTPUT_TOKENS]),
            num(a[ATTR.REASONING_TOKENS]),
            num(a[ATTR.CACHE_READ_TOKENS]),
            num(a[ATTR.CACHE_CREATION_TOKENS]),
            num(a[ATTR.COST_USD]),
            str(a[ATTR.FINISH_REASON]),
            str(a[ATTR.TOOL_NAME]),
            str(a[ATTR.INPUT]),
            str(a[ATTR.OUTPUT]),
            str(a[ATTR.REASONING]),
            a[ATTR.SENSITIVE] ? 1 : 0,
            str(a[ATTR.SENSITIVE_CATEGORIES]),
            str(a[ATTR.SENSITIVE_REASON]),
            JSON.stringify(meta),
          ],
        ).catch((err: unknown) => {
          // Surface (don't silently swallow) but never throw on the hot path.
          console.warn('[otel] span export failed:', (err as Error)?.message ?? err);
          throw err;
        }));
      }
      Promise.all(writes)
        .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
        .catch(() => resultCallback({ code: ExportResultCode.FAILED }));
    } catch {
      resultCallback({ code: ExportResultCode.FAILED });
    }
  }

  async shutdown(): Promise<void> { /* DB lifecycle is owned elsewhere */ }
  async forceFlush(): Promise<void> { /* writes are synchronous-enough */ }
}
