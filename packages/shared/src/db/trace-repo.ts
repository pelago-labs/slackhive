/**
 * @fileoverview Read side for the LLM trace view — assembles a Slack thread
 * (session) into turns, each with its OpenTelemetry span tree (reasoning,
 * generations, tool executions, final answer), plus session-level rollup
 * analytics (tokens, cost, latency percentiles, tool/model breakdown).
 *
 * Sessions = `tasks`, turns = `activities` (read live so in-flight turns show
 * immediately), and the per-turn detail comes from the `spans` table written by
 * the runner's OTel exporter. For agent-to-agent ("whose idea") turns, the
 * delegating agent is resolved by joining `initiator_user_id` →
 * `platform_integrations.bot_user_id` → `agents`.
 *
 * @module @slackhive/shared/db/trace-repo
 */

import { getDb } from './adapter';
import { humanizeTag, type Severity } from '../sensitivity';

export type SpanKind = 'agent' | 'generation' | 'tool' | 'event';

export interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  name: string;
  model: string | null;
  provider: string | null;
  startMs: number;
  endMs: number | null;
  durationMs: number | null;
  status: 'ok' | 'error';
  statusMessage: string | null;
  toolName: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  finishReason: string | null;
  input: string | null;
  output: string | null;
  reasoning: string | null;
  sensitive: boolean;
  sensitiveCategories: string[];
  sensitiveReason: string | null;
  sensitiveSeverity: Severity | null;
  /** True when the Smart (LLM) detector flagged this span (regex may have missed it). */
  sensitiveLlm: boolean;
  /** Excerpts the Smart detector flagged, so the trace can highlight which part + type. */
  sensitiveLlmHits: { text: string; category: string; label: string; severity: string }[];
}

export interface TraceTurn {
  activityId: string;
  agentId: string;
  agentName: string | null;
  agentSlug: string | null;
  status: 'in_progress' | 'done' | 'error';
  startedAt: string;
  finishedAt: string | null;
  messagePreview: string | null;
  error: string | null;
  /** Authorship — who triggered this turn. */
  initiatorKind: 'user' | 'agent';
  initiatorHandle: string | null;
  /** When agent-initiated, the delegating agent's name/slug (resolved). */
  delegatedByAgentName: string | null;
  delegatedByAgentSlug: string | null;
  /** Turn-level metrics (from the `agent` span; falls back to activity row). */
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  finalAnswer: string | null;
  /** True if this turn touched anything sensitive (see categories). */
  sensitive: boolean;
  sensitiveCategories: string[];
  /** 👍/👎 ratings tied to this turn (if any). */
  feedback: TurnFeedback[];
  /** The ordered observation tree under this turn (generation/tool/event). */
  spans: TraceSpan[];
}

export interface TurnFeedback {
  sentiment: 'up' | 'down';
  note: string | null;
  raterHandle: string | null;
}

export interface ModelUsage {
  model: string;
  turns: number;
  tokens: number;
}

export interface SessionRollup {
  turns: number;
  toolCalls: number;
  generations: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  errorCount: number;
  /** Per-turn latency, milliseconds. */
  totalDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  models: ModelUsage[];
}

export interface SessionTrace {
  turns: TraceTurn[];
  rollup: SessionRollup;
  /** Sensitive-data flows (source→sink lineage) across this session. */
  flows: SensitiveFlow[];
}

function n(v: unknown): number { return v == null ? 0 : Number(v); }
function nn(v: unknown): number | null { return v == null ? null : Number(v); }
function s(v: unknown): string | null { return v == null ? null : String(v); }

/** Convert a `YYYY-MM-DD HH:MM:SS` UTC window floor to epoch ms (for the
 * span table's integer timestamps). NaN when absent/unparseable. */
function sinceToMs(since?: string): number {
  return since ? Date.parse(since.replace(' ', 'T') + 'Z') : NaN;
}

/** Tiny TTL memo so the dashboard's 4s polls (and multiple viewers) don't
 * re-run the same aggregate scans every cycle. Keyed by the call args. */
const _cache = new Map<string, { exp: number; val: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val as T;
  const val = await fn();
  if (_cache.size > 200) { for (const [k, v] of _cache) if (v.exp <= Date.now()) _cache.delete(k); }
  _cache.set(key, { exp: Date.now() + ttlMs, val });
  return val;
}

function rowToSpan(r: Record<string, unknown>): TraceSpan {
  const startMs = n(r.start_ms);
  const endMs = nn(r.end_ms);
  return {
    spanId: r.span_id as string,
    parentSpanId: s(r.parent_span_id),
    kind: r.kind as SpanKind,
    name: r.name as string,
    model: s(r.model),
    provider: s(r.provider),
    startMs,
    endMs,
    durationMs: endMs == null ? null : Math.max(0, endMs - startMs),
    status: (r.status as 'ok' | 'error') ?? 'ok',
    statusMessage: s(r.status_message),
    toolName: s(r.tool_name),
    inputTokens: nn(r.input_tokens),
    outputTokens: nn(r.output_tokens),
    reasoningTokens: nn(r.reasoning_tokens),
    cacheReadTokens: nn(r.cache_read_tokens),
    cacheCreationTokens: nn(r.cache_creation_tokens),
    costUsd: nn(r.cost_usd),
    finishReason: s(r.finish_reason),
    input: s(r.input),
    output: s(r.output),
    reasoning: s(r.reasoning),
    sensitive: !!Number(r.sensitive ?? 0),
    sensitiveCategories: s(r.sensitive_categories)?.split(',').filter(Boolean) ?? [],
    sensitiveReason: s(r.sensitive_reason),
    sensitiveSeverity: s(r.sensitive_severity) as Severity | null,
    sensitiveLlm: !!Number(r.sensitive_llm ?? 0),
    sensitiveLlmHits: parseLlmHits(r.sensitive_llm_hits),
  };
}

/** Parse the JSON array stored in spans.sensitive_llm_hits (best-effort). Drops any
 *  element missing a required string field so malformed JSON can't surface as
 *  `undefined` in the UI (which expects all four fields). */
function parseLlmHits(raw: unknown): TraceSpan['sensitiveLlmHits'] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter(h => h && typeof h.text === 'string' && typeof h.category === 'string'
          && typeof h.label === 'string' && typeof h.severity === 'string')
      : [];
  } catch { return []; }
}

// ── Sensitive-data flow lineage (taint) ──────────────────────────────────────

export interface SensitiveFlow {
  /** Stable id (fingerprint + endpoint spans). */
  id: string;
  tag: string;
  label: string;
  category: string;
  severity: Severity;
  sourceSpanId: string;
  sinkSpanId: string;
  sourceLabel: string;
  sinkLabel: string;
  /** Sink timestamp (when the value left). */
  startMs: number;
  // Filled by the feed (getSensitiveFlows); null in the single-session view.
  sessionId: string | null;
  agentId: string | null;
  agentName: string | null;
  sessionSummary: string | null;
}

interface FpRec { fp: string; tag: string; role: 'source' | 'sink' }
interface FlowRow { spanId: string; kind: string; toolName: string | null; startMs: number; fps: FpRec[] }

function parseFps(v: unknown): FpRec[] {
  if (v == null) return [];
  try {
    const a = JSON.parse(String(v));
    return Array.isArray(a)
      ? a.filter(e => e && typeof e.fp === 'string' && typeof e.tag === 'string'
          && (e.role === 'source' || e.role === 'sink'))
      : [];
  } catch { return []; }
}

function spanLabel(kind: string, toolName: string | null, role: 'source' | 'sink'): string {
  if (kind === 'tool') return toolName || 'tool';
  if (kind === 'generation') return 'Agent reply';
  if (kind === 'agent') return role === 'source' ? 'User message' : 'Final answer';
  return kind;
}

/** Exfiltration severity: source→sink of a secret is critical (TT3), PII/cred high, data medium. */
function flowSeverity(tag: string): Severity {
  const cat = tag.split(':')[0];
  return cat === 'secret' ? 'critical' : cat === 'pii' || cat === 'tool' ? 'high' : 'medium';
}

/** Correlate per-span fingerprints within one session into source→sink flows:
 *  the same value seen as a source (earlier) and a sink (later, different span). */
function deriveFlows(rows: FlowRow[]): Omit<SensitiveFlow, 'sessionId' | 'agentId' | 'agentName' | 'sessionSummary'>[] {
  const sources = new Map<string, FlowRow & { tag: string }>();
  const sinks: (FlowRow & { tag: string; fp: string })[] = [];
  for (const row of rows) {
    for (const e of row.fps) {
      if (e.role === 'source') {
        const cur = sources.get(e.fp);
        if (!cur || row.startMs < cur.startMs) sources.set(e.fp, { ...row, tag: e.tag });
      } else {
        sinks.push({ ...row, tag: e.tag, fp: e.fp });
      }
    }
  }
  const out: Omit<SensitiveFlow, 'sessionId' | 'agentId' | 'agentName' | 'sessionSummary'>[] = [];
  const seen = new Set<string>();
  for (const sink of sinks) {
    const src = sources.get(sink.fp);
    if (!src || src.spanId === sink.spanId || src.startMs > sink.startMs) continue;
    const id = `${sink.fp}:${src.spanId}:${sink.spanId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, tag: sink.tag, label: humanizeTag(sink.tag).label, category: sink.tag.split(':')[0],
      severity: flowSeverity(sink.tag),
      sourceSpanId: src.spanId, sinkSpanId: sink.spanId,
      sourceLabel: spanLabel(src.kind, src.toolName, 'source'),
      sinkLabel: spanLabel(sink.kind, sink.toolName, 'sink'),
      startMs: sink.startMs,
    });
  }
  return out;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

/**
 * Full trace for one session (Slack thread): every turn with its span tree and
 * authorship, plus aggregate analytics. Returns null if the task is unknown.
 */
export async function getSessionTrace(taskId: string, accessibleAgentIds?: string[] | null): Promise<SessionTrace | null> {
  const db = getDb();

  const taskRes = await db.query(`SELECT id FROM tasks WHERE id = $1`, [taskId]);
  if (taskRes.rows.length === 0) return null;

  // Restrict to agents the caller may access (a delegated session can span agents
  // the user can't see). undefined/null = no restriction (admin); [] = no access.
  const restrict = Array.isArray(accessibleAgentIds);
  if (restrict && accessibleAgentIds!.length === 0) return { turns: [], rollup: emptyRollup(), flows: [] };
  const actFilter = restrict ? ` AND a.agent_id IN (${accessibleAgentIds!.map((_, i) => `$${i + 2}`).join(', ')})` : '';
  const spanFilter = restrict ? ` AND agent_id IN (${accessibleAgentIds!.map((_, i) => `$${i + 2}`).join(', ')})` : '';
  const agentParams = restrict ? accessibleAgentIds! : [];

  // Turns (live, from activities) + agent name/slug + delegating-agent resolution.
  // Tiebreak on rowid (monotonic insert order) — started_at is 1-second resolution
  // and the id is a random UUID, so same-second turns would otherwise sort randomly.
  const actRes = await db.query(
    `SELECT a.*,
            ag.name  AS agent_name,
            ag.slug  AS agent_slug,
            dag.name AS deleg_name,
            dag.slug AS deleg_slug
       FROM activities a
       LEFT JOIN agents ag ON ag.id = a.agent_id
       LEFT JOIN platform_integrations pi
              ON pi.bot_user_id = a.initiator_user_id
             AND pi.platform = a.platform
             AND a.initiator_kind = 'agent'
       LEFT JOIN agents dag ON dag.id = pi.agent_id
      WHERE a.task_id = $1${actFilter}
      ORDER BY a.started_at ASC, a.rowid ASC`,
    [taskId, ...agentParams],
  );
  if (actRes.rows.length === 0) {
    return { turns: [], rollup: emptyRollup(), flows: [] };
  }

  // All spans for the session, grouped by activity.
  const spanRes = await db.query(
    `SELECT * FROM spans WHERE session_id = $1${spanFilter} ORDER BY start_ms ASC, rowid ASC`,
    [taskId, ...agentParams],
  );
  const spansByActivity = new Map<string, TraceSpan[]>();
  const flowRows: FlowRow[] = [];
  for (const row of spanRes.rows) {
    const aid = (row.activity_id as string | null) ?? '';
    const bucket = spansByActivity.get(aid) ?? [];
    bucket.push(rowToSpan(row));
    spansByActivity.set(aid, bucket);
    const fps = parseFps(row.sensitive_fps);
    if (fps.length) flowRows.push({ spanId: row.span_id as string, kind: String(row.kind), toolName: s(row.tool_name), startMs: n(row.start_ms), fps });
  }
  const flows: SensitiveFlow[] = deriveFlows(flowRows)
    .map(f => ({ ...f, sessionId: taskId, agentId: null, agentName: null, sessionSummary: null }));

  // Per-turn feedback (👍/👎), keyed by activity.
  const fbRes = await db.query(
    `SELECT f.activity_id, f.sentiment, f.note, f.rater_handle
       FROM message_feedback f
       JOIN activities a ON a.id = f.activity_id
      WHERE a.task_id = $1
      ORDER BY f.created_at ASC`,
    [taskId],
  );
  const feedbackByActivity = new Map<string, TurnFeedback[]>();
  for (const row of fbRes.rows) {
    const aid = row.activity_id as string;
    const bucket = feedbackByActivity.get(aid) ?? [];
    bucket.push({
      sentiment: row.sentiment as 'up' | 'down',
      note: s(row.note),
      raterHandle: s(row.rater_handle),
    });
    feedbackByActivity.set(aid, bucket);
  }

  const turns: TraceTurn[] = actRes.rows.map(a => {
    const all = spansByActivity.get(a.id as string) ?? [];
    const agentSpan = all.find(sp => sp.kind === 'agent') ?? null;
    const steps = all.filter(sp => sp.kind !== 'agent');

    // Turn metrics: prefer the agent span (exact), fall back to the activity row.
    const inputTokens = agentSpan?.inputTokens ?? n(a.input_tokens);
    const outputTokens = agentSpan?.outputTokens ?? n(a.output_tokens);
    const sensitiveCats = new Set<string>();
    for (const sp of all) if (sp.sensitive) sp.sensitiveCategories.forEach(c => sensitiveCats.add(c));
    return {
      activityId: a.id as string,
      agentId: a.agent_id as string,
      agentName: s(a.agent_name),
      agentSlug: s(a.agent_slug),
      status: a.status as 'in_progress' | 'done' | 'error',
      startedAt: a.started_at as string,
      finishedAt: s(a.finished_at),
      messagePreview: s(a.message_preview),
      error: s(a.error),
      initiatorKind: (a.initiator_kind as 'user' | 'agent') ?? 'user',
      initiatorHandle: s(a.initiator_handle ?? null),
      delegatedByAgentName: s(a.deleg_name),
      delegatedByAgentSlug: s(a.deleg_slug),
      durationMs: agentSpan?.durationMs ?? null,
      inputTokens,
      outputTokens,
      reasoningTokens: agentSpan?.reasoningTokens ?? 0,
      cacheReadTokens: agentSpan?.cacheReadTokens ?? n(a.cache_read_tokens),
      cacheCreationTokens: agentSpan?.cacheCreationTokens ?? n(a.cache_creation_tokens),
      costUsd: agentSpan?.costUsd ?? 0,
      finalAnswer: agentSpan?.output ?? null,
      sensitive: sensitiveCats.size > 0,
      sensitiveCategories: [...sensitiveCats],
      feedback: feedbackByActivity.get(a.id as string) ?? [],
      spans: steps,
    };
  });

  return { turns, rollup: rollupFromTurns(turns), flows };
}

// ── Per-agent aggregate (all sessions of one agent) ──────────────────────────

export interface AgentRollup {
  sessions: number;
  turns: number;
  toolCalls: number;
  generations: number;
  errorTurns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  p50DurationMs: number;
  p95DurationMs: number;
  feedbackUp: number;
  feedbackDown: number;
  sensitiveEvents: number;
  tokensByDay: { date: string; input: number; output: number }[];
  topTools: { name: string; count: number; errors: number }[];
  models: ModelUsage[];
}

/**
 * Aggregate analytics across ALL sessions of one agent, within an optional time
 * window. Tokens/sessions/turns come from `activities` (full history); cost,
 * tool/model breakdown and ms-accurate latency come from `spans` (turns traced
 * since the feature shipped); feedback from `message_feedback`.
 */
export async function getAgentRollup(opts: { agentId: string; since?: string; until?: string }): Promise<AgentRollup> {
  return cached(`agentRollup:${opts.agentId}:${opts.since ?? ''}:${opts.until ?? ''}`, 2500, () => computeAgentRollup(opts));
}

async function computeAgentRollup(opts: { agentId: string; since?: string; until?: string }): Promise<AgentRollup> {
  const db = getDb();
  const { agentId, since, until } = opts;
  const sinceMs = sinceToMs(since);
  const untilMs = sinceToMs(until);

  const actW: string[] = ['agent_id = $1'];
  const actParams: unknown[] = [agentId];
  if (since) { actW.push(`started_at >= $${actParams.length + 1}`); actParams.push(since); }
  if (until) { actW.push(`started_at <= $${actParams.length + 1}`); actParams.push(until); }
  const actWhere = actW.join(' AND ');

  const spanW: string[] = ['agent_id = $1'];
  const spanParams: unknown[] = [agentId];
  if (Number.isFinite(sinceMs)) { spanW.push(`start_ms >= $${spanParams.length + 1}`); spanParams.push(sinceMs); }
  if (Number.isFinite(untilMs)) { spanW.push(`start_ms <= $${spanParams.length + 1}`); spanParams.push(untilMs); }
  const spanWhere = spanW.join(' AND ');
  // Feedback is a sparse, lifetime signal — NOT window-scoped, so satisfaction
  // always reflects the agent's standing rather than vanishing on a short window.
  const fbWhere = `agent_id = $1`;
  const fbParams: unknown[] = [agentId];

  const [act, byDay, span, lat, tools, models, fb, sens] = await Promise.all([
    db.query(`SELECT COUNT(DISTINCT task_id) sessions, COUNT(*) turns,
                     SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) error_turns,
                     COALESCE(SUM(input_tokens),0) input_tokens,
                     COALESCE(SUM(output_tokens),0) output_tokens
                FROM activities WHERE ${actWhere}`, actParams),
    db.query(`SELECT date(started_at) d,
                     COALESCE(SUM(input_tokens),0) input,
                     COALESCE(SUM(output_tokens),0) output
                FROM activities WHERE ${actWhere} GROUP BY d ORDER BY d`, actParams),
    db.query(`SELECT COALESCE(SUM(cost_usd),0) cost,
                     SUM(CASE WHEN kind='tool' THEN 1 ELSE 0 END) tool_calls,
                     SUM(CASE WHEN kind='generation' THEN 1 ELSE 0 END) generations
                FROM spans WHERE ${spanWhere}`, spanParams),
    db.query(`SELECT (end_ms - start_ms) ms FROM spans
               WHERE ${spanWhere} AND kind='agent' AND end_ms IS NOT NULL`, spanParams),
    db.query(`SELECT tool_name name, COUNT(*) c,
                     SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) e
                FROM spans
               WHERE ${spanWhere} AND kind='tool' AND tool_name IS NOT NULL
               GROUP BY tool_name ORDER BY c DESC LIMIT 8`, spanParams),
    db.query(`SELECT model, COUNT(DISTINCT activity_id) turns,
                     COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) tokens
                FROM spans WHERE ${spanWhere} AND model IS NOT NULL
               GROUP BY model ORDER BY tokens DESC LIMIT 6`, spanParams),
    db.query(`SELECT SUM(CASE WHEN sentiment='up' THEN 1 ELSE 0 END) up,
                     SUM(CASE WHEN sentiment='down' THEN 1 ELSE 0 END) down
                FROM message_feedback WHERE ${fbWhere}`, fbParams),
    db.query(`SELECT COUNT(*) c FROM spans WHERE ${spanWhere} AND sensitive = 1 AND kind IN ('tool', 'generation')`, spanParams),
  ]);

  const a0 = act.rows[0] ?? {};
  const s0 = span.rows[0] ?? {};
  const f0 = fb.rows[0] ?? {};
  const durations = lat.rows.map(r => Number(r.ms)).filter(m => Number.isFinite(m) && m >= 0).sort((x, y) => x - y);
  const inputTokens = n(a0.input_tokens);
  const outputTokens = n(a0.output_tokens);

  return {
    sessions: n(a0.sessions),
    turns: n(a0.turns),
    toolCalls: n(s0.tool_calls),
    generations: n(s0.generations),
    errorTurns: n(a0.error_turns),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: n(s0.cost),
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    feedbackUp: n(f0.up),
    feedbackDown: n(f0.down),
    sensitiveEvents: n((sens.rows[0] ?? {}).c),
    tokensByDay: byDay.rows.map(r => ({ date: String(r.d), input: n(r.input), output: n(r.output) })),
    topTools: tools.rows.map(r => ({ name: String(r.name), count: n(r.c), errors: n(r.e) })),
    models: models.rows.map(r => ({ model: String(r.model), turns: n(r.turns), tokens: n(r.tokens) })),
  };
}

// ── Insights rollup (LLMOps page) — scope = one agent | all | accessible set ──

/** Same shape as a per-agent rollup, but aggregated over a SCOPE (one agent, all
 *  agents, or a caller's accessible-agent set) for the consolidated LLMOps page. */
export type InsightsRollup = AgentRollup;

export interface InsightsFilter {
  /** One-agent scope. Omit for all-agents (within `accessibleAgentIds`). */
  agentId?: string;
  since?: string;
  until?: string;
  /** RBAC: undefined = no restriction (admin); [] = no access (empty result);
   *  non-empty = restrict to this set. */
  accessibleAgentIds?: string[];
}

/** Build the `agent_id` scope predicate + its params. Returns null when the caller
 *  has access to NO agents (so the query must yield an empty rollup, never all). */
function insightsScope(filter: InsightsFilter, startIdx: number): { clause: string; params: unknown[] } | null {
  if (filter.agentId) {
    // Defense in depth: a restricted caller asking for an agent they can't see → empty.
    if (filter.accessibleAgentIds && !filter.accessibleAgentIds.includes(filter.agentId)) return null;
    return { clause: `agent_id = $${startIdx}`, params: [filter.agentId] };
  }
  if (filter.accessibleAgentIds === undefined) return { clause: '1=1', params: [] };
  if (filter.accessibleAgentIds.length === 0) return null;
  const ph = filter.accessibleAgentIds.map((_, i) => `$${startIdx + i}`).join(', ');
  return { clause: `agent_id IN (${ph})`, params: [...filter.accessibleAgentIds] };
}

function emptyInsightsRollup(): InsightsRollup {
  return {
    sessions: 0, turns: 0, toolCalls: 0, generations: 0, errorTurns: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0,
    p50DurationMs: 0, p95DurationMs: 0, feedbackUp: 0, feedbackDown: 0, sensitiveEvents: 0,
    tokensByDay: [], topTools: [], models: [],
  };
}

/**
 * Aggregate analytics across a SCOPE — one agent, all agents, or a caller's
 * accessible-agent set — for the LLMOps insights page. Mirrors {@link getAgentRollup}
 * but generalizes the agent-scope predicate. p50/p95 are POOLED across the agent set
 * (the real cross-agent latency distribution), never an average of per-agent values.
 */
export async function getInsightsRollup(filter: InsightsFilter = {}): Promise<InsightsRollup> {
  // Cache key MUST encode the full (sorted) RBAC scope, or a restricted caller could
  // read a broader caller's cached aggregate.
  const acc = filter.accessibleAgentIds === undefined ? '*' : [...filter.accessibleAgentIds].sort().join(',');
  const key = `insights:${filter.agentId ?? ''}:${filter.since ?? ''}:${filter.until ?? ''}:${acc}`;
  return cached(key, 2500, () => computeInsightsRollup(filter));
}

async function computeInsightsRollup(filter: InsightsFilter): Promise<InsightsRollup> {
  const db = getDb();
  const sinceMs = sinceToMs(filter.since);
  const untilMs = sinceToMs(filter.until);

  // activities scope (started_at window) — its own param list.
  const actScope = insightsScope(filter, 1);
  if (!actScope) return emptyInsightsRollup();
  const actParams: unknown[] = [...actScope.params];
  const actW = [actScope.clause];
  if (filter.since) { actW.push(`started_at >= $${actParams.length + 1}`); actParams.push(filter.since); }
  if (filter.until) { actW.push(`started_at <= $${actParams.length + 1}`); actParams.push(filter.until); }
  const actWhere = actW.join(' AND ');

  // spans scope (start_ms window) — its own param list.
  const spanScope = insightsScope(filter, 1);
  const spanParams: unknown[] = [...spanScope!.params];
  const spanW = [spanScope!.clause];
  if (Number.isFinite(sinceMs)) { spanW.push(`start_ms >= $${spanParams.length + 1}`); spanParams.push(sinceMs); }
  if (Number.isFinite(untilMs)) { spanW.push(`start_ms <= $${spanParams.length + 1}`); spanParams.push(untilMs); }
  const spanWhere = spanW.join(' AND ');

  // feedback: lifetime (not window-scoped), matching getAgentRollup.
  const fbScope = insightsScope(filter, 1);
  const fbWhere = fbScope!.clause;
  const fbParams: unknown[] = [...fbScope!.params];

  const [act, byDay, span, lat, tools, models, fb, sens] = await Promise.all([
    db.query(`SELECT COUNT(DISTINCT task_id) sessions, COUNT(*) turns,
                     SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) error_turns,
                     COALESCE(SUM(input_tokens),0) input_tokens,
                     COALESCE(SUM(output_tokens),0) output_tokens
                FROM activities WHERE ${actWhere}`, actParams),
    db.query(`SELECT date(started_at) d,
                     COALESCE(SUM(input_tokens),0) input,
                     COALESCE(SUM(output_tokens),0) output
                FROM activities WHERE ${actWhere} GROUP BY d ORDER BY d`, actParams),
    db.query(`SELECT COALESCE(SUM(cost_usd),0) cost,
                     SUM(CASE WHEN kind='tool' THEN 1 ELSE 0 END) tool_calls,
                     SUM(CASE WHEN kind='generation' THEN 1 ELSE 0 END) generations
                FROM spans WHERE ${spanWhere}`, spanParams),
    db.query(`SELECT (end_ms - start_ms) ms FROM spans
               WHERE ${spanWhere} AND kind='agent' AND end_ms IS NOT NULL`, spanParams),
    db.query(`SELECT tool_name name, COUNT(*) c,
                     SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) e
                FROM spans
               WHERE ${spanWhere} AND kind='tool' AND tool_name IS NOT NULL
               GROUP BY tool_name ORDER BY c DESC LIMIT 8`, spanParams),
    db.query(`SELECT model, COUNT(DISTINCT activity_id) turns,
                     COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) tokens
                FROM spans WHERE ${spanWhere} AND model IS NOT NULL
               GROUP BY model ORDER BY tokens DESC LIMIT 6`, spanParams),
    db.query(`SELECT SUM(CASE WHEN sentiment='up' THEN 1 ELSE 0 END) up,
                     SUM(CASE WHEN sentiment='down' THEN 1 ELSE 0 END) down
                FROM message_feedback WHERE ${fbWhere}`, fbParams),
    db.query(`SELECT COUNT(*) c FROM spans WHERE ${spanWhere} AND sensitive = 1 AND kind IN ('tool', 'generation')`, spanParams),
  ]);

  const a0 = act.rows[0] ?? {};
  const s0 = span.rows[0] ?? {};
  const f0 = fb.rows[0] ?? {};
  const durations = lat.rows.map(r => Number(r.ms)).filter(m => Number.isFinite(m) && m >= 0).sort((x, y) => x - y);
  const inputTokens = n(a0.input_tokens);
  const outputTokens = n(a0.output_tokens);

  return {
    sessions: n(a0.sessions),
    turns: n(a0.turns),
    toolCalls: n(s0.tool_calls),
    generations: n(s0.generations),
    errorTurns: n(a0.error_turns),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: n(s0.cost),
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    feedbackUp: n(f0.up),
    feedbackDown: n(f0.down),
    sensitiveEvents: n((sens.rows[0] ?? {}).c),
    tokensByDay: byDay.rows.map(r => ({ date: String(r.d), input: n(r.input), output: n(r.output) })),
    topTools: tools.rows.map(r => ({ name: String(r.name), count: n(r.c), errors: n(r.e) })),
    models: models.rows.map(r => ({ model: String(r.model), turns: n(r.turns), tokens: n(r.tokens) })),
  };
}

// ── Per-session summaries (LLMOps "Sessions" table) ──────────────────────────

/** One row in the sessions table — a thread with its rolled-up metrics. */
export interface SessionSummary {
  sessionId: string;
  summary: string | null;
  initiatorHandle: string | null;
  agentIds: string[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  status: 'active' | 'done' | 'error';
  sensitive: boolean;
  feedbackUp: number;
  feedbackDown: number;
  startedAt: string;
  lastActivityAt: string;
}

/**
 * Per-session rollup rows for the LLMOps Sessions table: turns, tokens, state,
 * feedback and sensitivity for each thread in scope+window, newest first. One
 * grouped pass over activities + cheap joins (no per-session trace fetch).
 */
export async function getSessionSummaries(filter: InsightsFilter = {}, limit = 100): Promise<SessionSummary[]> {
  const db = getDb();
  const scope = insightsScope(filter, 1);
  if (!scope) return [];
  const params: unknown[] = [...scope.params];
  const w = [scope.clause];
  if (filter.since) { w.push(`started_at >= $${params.length + 1}`); params.push(filter.since); }
  if (filter.until) { w.push(`started_at <= $${params.length + 1}`); params.push(filter.until); }
  const lim = Math.min(500, Math.max(1, limit));
  params.push(lim);

  const { rows } = await db.query(
    `WITH scoped AS (
       SELECT * FROM activities a WHERE ${w.join(' AND ')}
     ),
     agg AS (
       SELECT task_id,
              COUNT(*) turns,
              COALESCE(SUM(input_tokens),0) in_tok,
              COALESCE(SUM(output_tokens),0) out_tok,
              MAX(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) has_active,
              MAX(CASE WHEN status='error' THEN 1 ELSE 0 END) has_error,
              GROUP_CONCAT(DISTINCT agent_id) agent_ids
       FROM scoped GROUP BY task_id
     ),
     fb AS (
       SELECT a.task_id,
              SUM(CASE WHEN mf.sentiment='up' THEN 1 ELSE 0 END) up,
              SUM(CASE WHEN mf.sentiment='down' THEN 1 ELSE 0 END) down
       FROM message_feedback mf JOIN activities a ON a.id = mf.activity_id
       GROUP BY a.task_id
     ),
     sens AS ( SELECT DISTINCT session_id FROM spans WHERE sensitive = 1 )
     SELECT t.id, t.summary, t.initiator_handle, t.started_at, t.last_activity_at,
            agg.turns, agg.in_tok, agg.out_tok, agg.has_active, agg.has_error, agg.agent_ids,
            (sx.session_id IS NOT NULL) sensitive,
            COALESCE(fb.up,0) fb_up, COALESCE(fb.down,0) fb_down
       FROM agg
       JOIN tasks t ON t.id = agg.task_id
       LEFT JOIN fb   ON fb.task_id = t.id
       LEFT JOIN sens sx ON sx.session_id = t.id
      ORDER BY t.last_activity_at DESC, t.id DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map(r => ({
    sessionId: r.id as string,
    summary: s(r.summary),
    initiatorHandle: s(r.initiator_handle),
    agentIds: typeof r.agent_ids === 'string' && r.agent_ids ? (r.agent_ids as string).split(',').filter(Boolean) : [],
    turns: n(r.turns),
    inputTokens: n(r.in_tok),
    outputTokens: n(r.out_tok),
    status: Number(r.has_active) ? 'active' : Number(r.has_error) ? 'error' : 'done',
    sensitive: !!Number(r.sensitive),
    feedbackUp: n(r.fb_up),
    feedbackDown: n(r.fb_down),
    startedAt: String(r.started_at),
    lastActivityAt: String(r.last_activity_at),
  }));
}

// ── Sensitive-access audit feed ──────────────────────────────────────────────

export interface SensitiveEvent {
  spanId: string;
  sessionId: string;
  activityId: string | null;
  agentId: string | null;
  agentName: string | null;
  toolName: string | null;
  categories: string[];
  reason: string | null;
  severity: Severity | null;
  /** True when the Smart (LLM) detector flagged this (vs. deterministic regex). */
  caughtByLlm: boolean;
  startMs: number;
  sessionSummary: string | null;
}

export interface SensitiveFeedFilter {
  since?: string;
  until?: string;
  agentId?: string;
  accessibleAgentIds?: string[];
  limit?: number;
}

/**
 * Recent sensitive tool accesses across all agents (the audit feed). Scoped by
 * window / agent / accessible-agent allowlist. Returns privacy-safe rows — the
 * `reason` is category tags only, never the matched value.
 */
export async function getSensitiveEvents(filter: SensitiveFeedFilter = {}): Promise<SensitiveEvent[]> {
  const db = getDb();
  // Tool calls AND the model's own output (a generation span can be flagged when
  // the agent writes PII/secrets into its reply).
  const wheres: string[] = [`s.sensitive = 1`, `s.kind IN ('tool', 'generation')`];
  const params: unknown[] = [];

  if (filter.since) {
    const sinceMs = sinceToMs(filter.since);
    if (Number.isFinite(sinceMs)) { wheres.push(`s.start_ms >= $${params.length + 1}`); params.push(sinceMs); }
  }
  if (filter.until) {
    const untilMs = sinceToMs(filter.until);
    if (Number.isFinite(untilMs)) { wheres.push(`s.start_ms <= $${params.length + 1}`); params.push(untilMs); }
  }
  if (filter.agentId) { wheres.push(`s.agent_id = $${params.length + 1}`); params.push(filter.agentId); }
  if (filter.accessibleAgentIds !== undefined) {
    if (filter.accessibleAgentIds.length === 0) return [];
    const ph = filter.accessibleAgentIds.map((_, i) => `$${params.length + 1 + i}`).join(', ');
    wheres.push(`s.agent_id IN (${ph})`);
    params.push(...filter.accessibleAgentIds);
  }
  const limit = Math.min(500, Math.max(1, filter.limit ?? 100));

  const { rows } = await db.query(
    `SELECT s.span_id, s.session_id, s.activity_id, s.agent_id, s.tool_name,
            s.sensitive_categories, s.sensitive_reason, s.sensitive_severity, s.sensitive_llm, s.start_ms,
            ag.name AS agent_name, t.summary AS session_summary
       FROM spans s
       LEFT JOIN agents ag ON ag.id = s.agent_id
       LEFT JOIN tasks  t  ON t.id = s.session_id
      WHERE ${wheres.join(' AND ')}
      ORDER BY s.start_ms DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(r => ({
    spanId: r.span_id as string,
    sessionId: r.session_id as string,
    activityId: s(r.activity_id),
    agentId: s(r.agent_id),
    agentName: s(r.agent_name),
    toolName: s(r.tool_name),
    categories: s(r.sensitive_categories)?.split(',').filter(Boolean) ?? [],
    reason: s(r.sensitive_reason),
    severity: s(r.sensitive_severity) as Severity | null,
    caughtByLlm: !!Number(r.sensitive_llm ?? 0),
    startMs: n(r.start_ms),
    sessionSummary: s(r.session_summary),
  }));
}

/**
 * Sensitive-data FLOWS (source→sink lineage) across the window — the exfiltration
 * feed. Pulls spans carrying flow fingerprints, groups by session, and correlates
 * a value seen as a source then a sink. Privacy-safe: fingerprints + kind tags only.
 */
export async function getSensitiveFlows(filter: SensitiveFeedFilter = {}): Promise<SensitiveFlow[]> {
  const db = getDb();
  const wheres: string[] = [`s.sensitive_fps IS NOT NULL`];
  const params: unknown[] = [];
  if (filter.since) { const m = sinceToMs(filter.since); if (Number.isFinite(m)) { wheres.push(`s.start_ms >= $${params.length + 1}`); params.push(m); } }
  if (filter.until) { const m = sinceToMs(filter.until); if (Number.isFinite(m)) { wheres.push(`s.start_ms <= $${params.length + 1}`); params.push(m); } }
  if (filter.agentId) { wheres.push(`s.agent_id = $${params.length + 1}`); params.push(filter.agentId); }
  if (filter.accessibleAgentIds !== undefined) {
    if (filter.accessibleAgentIds.length === 0) return [];
    const ph = filter.accessibleAgentIds.map((_, i) => `$${params.length + 1 + i}`).join(', ');
    wheres.push(`s.agent_id IN (${ph})`);
    params.push(...filter.accessibleAgentIds);
  }
  const limit = Math.min(500, Math.max(1, filter.limit ?? 100));

  const { rows } = await db.query(
    `SELECT s.span_id, s.session_id, s.agent_id, s.kind, s.tool_name, s.start_ms, s.sensitive_fps,
            ag.name AS agent_name, t.summary AS session_summary
       FROM spans s
       LEFT JOIN agents ag ON ag.id = s.agent_id
       LEFT JOIN tasks  t  ON t.id = s.session_id
      WHERE ${wheres.join(' AND ')}
      ORDER BY s.start_ms ASC`,
    params,
  );

  // Group by session, then correlate source→sink within each.
  const bySession = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const sid = r.session_id as string;
    (bySession.get(sid) ?? bySession.set(sid, []).get(sid)!).push(r);
  }
  const flows: SensitiveFlow[] = [];
  for (const [sid, sessionRows] of bySession) {
    const meta = sessionRows[0];
    const flowRows: FlowRow[] = sessionRows.map(r => ({
      spanId: r.span_id as string, kind: String(r.kind), toolName: s(r.tool_name), startMs: n(r.start_ms), fps: parseFps(r.sensitive_fps),
    }));
    for (const f of deriveFlows(flowRows)) {
      flows.push({ ...f, sessionId: sid, agentId: s(meta.agent_id), agentName: s(meta.agent_name), sessionSummary: s(meta.session_summary) });
    }
  }
  // Most severe first, then most recent.
  const rank: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };
  flows.sort((a, b) => rank[b.severity] - rank[a.severity] || b.startMs - a.startMs);
  return flows.slice(0, limit);
}

/**
 * Aggregate 👍/👎 counts per task (across all its turns), for the dashboard
 * kanban cards. Batched by task id so the list endpoint does one query.
 */
export async function getFeedbackCountsForTasks(taskIds: string[]): Promise<Record<string, { up: number; down: number }>> {
  if (!taskIds.length) return {};
  return cached(`fbCounts:${[...taskIds].sort().join(',')}`, 2500, () => computeFeedbackCountsForTasks(taskIds));
}

async function computeFeedbackCountsForTasks(taskIds: string[]): Promise<Record<string, { up: number; down: number }>> {
  const db = getDb();
  const ph = taskIds.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(
    `SELECT a.task_id,
            SUM(CASE WHEN f.sentiment = 'up'   THEN 1 ELSE 0 END) AS up,
            SUM(CASE WHEN f.sentiment = 'down' THEN 1 ELSE 0 END) AS down
       FROM message_feedback f
       JOIN activities a ON a.id = f.activity_id
      WHERE a.task_id IN (${ph})
      GROUP BY a.task_id`,
    taskIds,
  );
  const out: Record<string, { up: number; down: number }> = {};
  for (const r of rows) out[r.task_id as string] = { up: n(r.up), down: n(r.down) };
  return out;
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * Delete activity/trace data older than `retentionDays` (default 180 ≈ 6 months;
 * override via TRACE_RETENTION_DAYS). Prunes spans (by epoch-ms), message
 * feedback (by created_at), and whole tasks past their last activity — task
 * deletion cascades to activities → tool_calls. Best-effort; returns row counts.
 */
export async function pruneTraceData(retentionDays?: number): Promise<{ spans: number; feedback: number; tasks: number }> {
  // Resolve the retention window. Use Number.isFinite (not `|| 180`) so an explicit
  // `TRACE_RETENTION_DAYS=0` is honored as "prune everything" rather than silently
  // coalescing the falsy zero back to the default.
  const envDays = Number(process.env.TRACE_RETENTION_DAYS);
  const days = retentionDays ?? (Number.isFinite(envDays) && envDays >= 0 ? envDays : 180);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString().replace('T', ' ').slice(0, 19);
  // Prune by SESSION (whole thread), atomically, so retained sessions stay WHOLE:
  //   1. feedback for the soon-to-be-pruned sessions — removed up front (before the
  //      task cascade SET-NULLs activity_id and we can no longer tell which session
  //      it belonged to), so a session's feedback dies with it regardless of its age.
  //   2. tasks past the cutoff — cascades to activities → tool_calls.
  //   3. spans of any removed session — orphan-join keeps whole-session semantics
  //      (early spans of a *retained* long thread survive). Orphans of a just-pruned
  //      task are removed regardless of age (else a task's RECENT spans outlive it and
  //      leak past retention); only the exporter's empty-session_id fallback spans stay
  //      age-bounded so a fresh one written mid-flush isn't reaped.
  //   4. remaining standalone feedback past its own age.
  return getDb().transaction(async (tx) => {
    await tx.query(
      `DELETE FROM message_feedback WHERE activity_id IN (
         SELECT a.id FROM activities a JOIN tasks t ON a.task_id = t.id
         WHERE t.last_activity_at < $1)`,
      [cutoffIso],
    );
    const tasks = await tx.query(`DELETE FROM tasks WHERE last_activity_at < $1`, [cutoffIso]);
    const spans = await tx.query(
      `DELETE FROM spans
        WHERE session_id NOT IN (SELECT id FROM tasks)
          AND (session_id <> '' OR start_ms < $1)`,
      [cutoffMs],
    );
    const feedback = await tx.query(`DELETE FROM message_feedback WHERE created_at < $1`, [cutoffIso]);
    return { spans: spans.rowCount, feedback: feedback.rowCount, tasks: tasks.rowCount };
  });
}

// ── Per-tool stats + error-message aggregation ───────────────────────────────

export interface ToolErrorGroup {
  message: string;
  count: number;
  sampleSessionId: string | null;
}
export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  errorGroups: ToolErrorGroup[];
}

/**
 * Per-tool call + error stats for an agent (or all accessible agents), with the
 * error messages aggregated by identical text → count. Powers the tool
 * drill-down opened from the dashboard's "Top tools".
 */
export async function getToolStats(filter: { agentId?: string; since?: string; until?: string; accessibleAgentIds?: string[] } = {}): Promise<ToolStat[]> {
  const db = getDb();
  const sinceMs = sinceToMs(filter.since);
  const untilMs = sinceToMs(filter.until);
  const wheres = [`kind = 'tool'`, `tool_name IS NOT NULL`];
  const params: unknown[] = [];
  if (filter.agentId) { wheres.push(`agent_id = $${params.length + 1}`); params.push(filter.agentId); }
  if (Number.isFinite(sinceMs)) { wheres.push(`start_ms >= $${params.length + 1}`); params.push(sinceMs); }
  if (Number.isFinite(untilMs)) { wheres.push(`start_ms <= $${params.length + 1}`); params.push(untilMs); }
  if (filter.accessibleAgentIds !== undefined) {
    if (filter.accessibleAgentIds.length === 0) return [];
    const ph = filter.accessibleAgentIds.map((_, i) => `$${params.length + 1 + i}`).join(', ');
    wheres.push(`agent_id IN (${ph})`);
    params.push(...filter.accessibleAgentIds);
  }
  const where = wheres.join(' AND ');

  const [totals, groups] = await Promise.all([
    db.query(`SELECT tool_name, COUNT(*) calls, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors
                FROM spans WHERE ${where} GROUP BY tool_name ORDER BY calls DESC`, params),
    // Aggregate by a TRUNCATED error key (first 160 chars) so near-identical
    // failures collapse into one group instead of each full (and potentially
    // large/sensitive) result body becoming its own group of 1.
    db.query(`SELECT tool_name,
                     substr(COALESCE(NULLIF(status_message, ''), NULLIF(output, ''), '(no message)'), 1, 160) msg,
                     COUNT(*) c, MAX(session_id) sid
                FROM spans WHERE ${where} AND status='error'
               GROUP BY tool_name, msg ORDER BY c DESC`, params),
  ]);

  const byTool = new Map<string, ToolStat>();
  for (const r of totals.rows) {
    byTool.set(r.tool_name as string, { name: r.tool_name as string, calls: n(r.calls), errors: n(r.errors), errorGroups: [] });
  }
  for (const r of groups.rows) {
    const t = byTool.get(r.tool_name as string);
    if (t) t.errorGroups.push({ message: String(r.msg), count: n(r.c), sampleSessionId: s(r.sid) });
  }
  return [...byTool.values()];
}

function emptyRollup(): SessionRollup {
  return {
    turns: 0, toolCalls: 0, generations: 0,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0,
    costUsd: 0, errorCount: 0,
    totalDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0, models: [],
  };
}

function rollupFromTurns(turns: TraceTurn[]): SessionRollup {
  const r = emptyRollup();
  const durations: number[] = [];
  const modelMap = new Map<string, ModelUsage>();
  for (const t of turns) {
    r.turns += 1;
    r.inputTokens += t.inputTokens;
    r.outputTokens += t.outputTokens;
    r.reasoningTokens += t.reasoningTokens;
    r.cacheReadTokens += t.cacheReadTokens;
    r.cacheCreationTokens += t.cacheCreationTokens;
    r.costUsd += t.costUsd;
    if (t.status === 'error') r.errorCount += 1;
    if (t.durationMs != null) { durations.push(t.durationMs); r.totalDurationMs += t.durationMs; }
    for (const sp of t.spans) {
      if (sp.kind === 'tool') r.toolCalls += 1;
      if (sp.kind === 'generation') r.generations += 1;
    }
    const model = t.spans.find(sp => sp.model)?.model ?? null;
    if (model) {
      const m = modelMap.get(model) ?? { model, turns: 0, tokens: 0 };
      m.turns += 1;
      m.tokens += t.inputTokens + t.outputTokens;
      modelMap.set(model, m);
    }
  }
  r.totalTokens = r.inputTokens + r.outputTokens;
  durations.sort((a, b) => a - b);
  r.p50DurationMs = percentile(durations, 50);
  r.p95DurationMs = percentile(durations, 95);
  r.models = [...modelMap.values()].sort((a, b) => b.tokens - a.tokens);
  return r;
}
