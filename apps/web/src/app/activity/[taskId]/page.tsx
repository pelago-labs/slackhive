'use client';

/**
 * @fileoverview Session trace view — a Langfuse-style LLM trace for one Slack
 * thread. Header + analytics card (tokens / cost / latency p50-p95 / tool +
 * model breakdown + charts), then a conversation timeline: each turn shows who
 * sent it (user or delegating agent), the message, an expandable observation
 * tree (reasoning → tool calls → final answer) with per-step durations + full
 * content, and the final answer. Data comes from the OpenTelemetry span tree
 * persisted by the runner.
 *
 * @module web/app/activity/[taskId]
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { deepLinkLabelForPlatform } from '@slackhive/shared';
import {
  ArrowLeft, ExternalLink, ChevronRight, ChevronDown,
  Wrench, CheckCircle2, AlertTriangle, Loader2, Brain,
  ThumbsUp, ThumbsDown, Coins, GitBranch, Copy, Check, Layers, Clock, ShieldAlert, ArrowRight, Lock,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatTokens } from '../_components/formatTokens';
import { type TraceTurn, type TraceSpan, type TurnFeedback } from '@slackhive/shared';
import { relativeTime } from '@/lib/time';
import { SEV_COLOR } from '../_components/SevBadge';
import { RevealCtx, SensitiveBadge, buildNodes, NodeRow, formatMs } from '../_components/trace-nodes';

interface Task {
  id: string; platform: string; channelId: string; threadTs: string;
  initiatorUserId?: string; initiatorHandle?: string; initialAgentId?: string;
  summary?: string; startedAt: string; lastActivityAt: string; activityCount: number;
}
interface ModelUsage { model: string; turns: number; tokens: number }
interface SessionRollup {
  turns: number; toolCalls: number; generations: number;
  inputTokens: number; outputTokens: number; reasoningTokens: number;
  cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number;
  costUsd: number; errorCount: number;
  totalDurationMs: number; p50DurationMs: number; p95DurationMs: number; models: ModelUsage[];
}
type Severity = 'critical' | 'high' | 'medium' | 'low';
interface TraceFlow {
  id: string; label: string; category: string; severity: Severity;
  sourceLabel: string; sinkLabel: string; sourceSpanId: string; sinkSpanId: string;
}
interface TraceDetail { task: Task; turns: TraceTurn[]; rollup: SessionRollup | null; deepLink: string | null; flows?: TraceFlow[] }
function formatCost(n: number): string {
  if (!n) return '—';
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p.length === 1 ? p[0].slice(0, 2) : p[0][0] + p[p.length - 1][0]).toUpperCase();
}
function agentColor(id: string): string {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffffff;
  return `hsl(${Math.abs(h) % 360}, 55%, 55%)`;
}
const STATUS_COLOR: Record<string, string> = {
  in_progress: '#2563eb', done: '#059669', ok: '#059669', error: '#dc2626',
};

export default function TaskTracePage(): React.JSX.Element {
  const params = useParams<{ taskId: string }>();
  const taskId = decodeURIComponent(params?.taskId ?? '');
  const { role } = useAuth();
  const canReveal = role === 'admin' || role === 'superadmin';
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fbFilter, setFbFilter] = useState<'all' | 'up' | 'down'>('all');
  // `?span=<id>` deep-link (from the Sensitive feed) — expand + scroll to that node.
  const [highlightSpanId, setHighlightSpanId] = useState<string | null>(null);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search).get('span');
    if (sp) setHighlightSpanId(sp);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/activity/${encodeURIComponent(taskId)}`);
      if (r.status === 404) { setError('Task not found'); return; }
      if (!r.ok) { setError('Failed to load task'); return; }
      setDetail(await r.json()); setError(null);
    } catch { setError('Failed to load task'); }
  }, [taskId]);

  // Initial load (and reload when the task changes).
  useEffect(() => { load(); }, [load]);

  // Poll ONLY while a turn is in progress, and re-evaluate only when that boolean
  // flips — depending on `detail.turns` here re-ran the effect (and refetched) on
  // every response, a tight loop that hammered the API and re-rendered constantly.
  const inflight = detail ? detail.turns.some(t => t.status === 'in_progress') : false;
  useEffect(() => {
    if (!inflight) return;
    const id = window.setInterval(load, 4000);
    return () => clearInterval(id);
  }, [inflight, load]);

  // Distinct (name, slug) agents for the Properties rail — memoized so the polling
  // re-render doesn't redo the dedupe/allocation each cycle (was a JSON round-trip).
  // MUST be computed before the early returns below, or the hook count changes
  // between the loading and loaded renders (rules of hooks → client crash).
  const agentTurns = detail?.turns ?? [];
  const agentsKey = agentTurns.map(t => `${t.agentName}|${t.agentSlug}`).join(';');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- agentsKey is the value-stable proxy for the turns
  const agents = useMemo(() => {
    const m = new Map<string, { name: string; slug: string | null }>();
    for (const t of agentTurns) {
      if (t.agentName) m.set(`${t.agentName}|${t.agentSlug}`, { name: t.agentName, slug: t.agentSlug });
    }
    return [...m.values()];
  }, [agentsKey]);

  if (error) return <Shell><Empty>{error}</Empty></Shell>;
  if (!detail) return <Shell><div style={{ marginTop: 20, padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading…</div></Shell>;

  const { task, turns, rollup, deepLink } = detail;
  const flows = detail.flows ?? [];
  const initiator = task.initiatorHandle || task.initiatorUserId || 'unknown';
  const anyRunning = turns.some(t => t.status === 'in_progress');
  const anyError = turns.some(t => t.status === 'error');
  const sessionStatus = anyRunning ? 'in_progress' : anyError ? 'error' : 'done';

  // Turn-level feedback rollup + filter ("see where the agent went wrong").
  const upTurns = turns.filter(t => t.feedback.some(f => f.sentiment === 'up')).length;
  const downTurns = turns.filter(t => t.feedback.some(f => f.sentiment === 'down')).length;
  const indexedTurns = turns.map((t, i) => ({ t, i }));
  const visibleTurns = fbFilter === 'all'
    ? indexedTurns
    : indexedTurns.filter(({ t }) => t.feedback.some(f => f.sentiment === fbFilter));

  return (
    <RevealCtx.Provider value={canReveal}>
    <Shell>
      {/* Title + description (the Back button above handles navigation) */}
      <div style={{ marginTop: 16 }}>
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', lineHeight: 1.35 }}>
          {task.summary || '(empty opening message)'}
        </h1>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
          Started by <strong style={{ color: 'var(--text)', fontWeight: 500 }}>@{initiator}</strong> · {relativeTime(task.startedAt)}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', marginTop: 18, flexWrap: 'wrap' }}>
        {/* ── Main column: analytics + flows + activity timeline ── */}
        <div style={{ flex: '1 1 600px', minWidth: 0 }}>
          {rollup && <Analytics rollup={rollup} turns={turns} />}

          {flows.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <SectionLabel>Sensitive data flows</SectionLabel>
              <div style={{ marginTop: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                {flows.map((f, i) => (
                  <a key={f.id} href={`#span-${f.sinkSpanId}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', textDecoration: 'none', color: 'inherit', borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                    <span style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 6, background: `${SEV_COLOR[f.severity]}1a`, color: SEV_COLOR[f.severity] }}>{f.severity}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', flexShrink: 0 }}>{f.label}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono, monospace)', minWidth: 0 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.sourceLabel}</span>
                      <ArrowRight size={12} style={{ color: 'var(--red)', flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.sinkLabel}</span>
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 8px' }}>
              <SectionLabel>Activity</SectionLabel>
              {(upTurns > 0 || downTurns > 0) && (
                <div style={{ display: 'inline-flex', gap: 4 }}>
                  <FbChip label="All" active={fbFilter === 'all'} onClick={() => setFbFilter('all')} />
                  <FbChip icon={<ThumbsUp size={11} />} label={String(upTurns)} active={fbFilter === 'up'} color="#16a34a" onClick={() => setFbFilter(fbFilter === 'up' ? 'all' : 'up')} />
                  <FbChip icon={<ThumbsDown size={11} />} label={String(downTurns)} active={fbFilter === 'down'} color="#dc2626" onClick={() => setFbFilter(fbFilter === 'down' ? 'all' : 'down')} />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {turns.length === 0 && <Empty>No activity recorded yet.</Empty>}
              {turns.length > 0 && visibleTurns.length === 0 && <Empty>No turns match this filter.</Empty>}
              {visibleTurns.map(({ t, i }, vi) => <TurnCard key={t.activityId} turn={t} index={i} isLast={vi === visibleTurns.length - 1} highlightSpanId={highlightSpanId} />)}
            </div>
          </div>
        </div>

        {/* ── Properties rail ── */}
        <aside style={{ flex: '0 0 240px', maxWidth: '100%', position: 'sticky', top: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)', marginBottom: 12 }}>Properties</div>
          <PropRow label="Status"><StatusPill status={sessionStatus} /></PropRow>
          <PropRow label="Assignee">
            <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{agents.length ? agents.map(a => a.name).join(', ') : '—'}</span>
          </PropRow>
          <PropRow label="Initiator"><span style={{ fontSize: 12.5, color: 'var(--text)' }}>@{initiator}</span></PropRow>
          <PropRow label="Started"><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{relativeTime(task.startedAt)}</span></PropRow>
          {turns.some(t => t.sensitive) && (
            <PropRow label="Sensitive"><SensitiveBadge categories={[...new Set(turns.flatMap(t => t.sensitiveCategories))]} /></PropRow>
          )}
          {deepLink && (
            <a href={deepLink} target="_blank" rel="noopener noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 14, padding: '8px 14px', fontSize: 12.5, fontWeight: 500,
              background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 8, textDecoration: 'none',
            }}>
              {deepLinkLabelForPlatform(task.platform as 'slack' | 'discord' | 'telegram' | 'whatsapp' | 'teams')} <ExternalLink size={12} />
            </a>
          )}
        </aside>
      </div>
    </Shell>
    </RevealCtx.Provider>
  );
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const router = useRouter();
  // Go to the actual previous page (Activity, Observability, …) rather than a fixed
  // route; fall back to /activity on a direct/deep load with no in-app history.
  const back = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back();
    else router.push('/activity');
  };
  return (
    <div className="fade-up" style={{ padding: '36px 40px', maxWidth: 1600, margin: '0 auto' }}>
      <button onClick={back} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)',
        background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)',
      }}>
        <ArrowLeft size={13} /> Back
      </button>
      {children}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ marginTop: 20, padding: 24, textAlign: 'center', background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 12, color: 'var(--muted)', fontSize: 13 }}>{children}</div>;
}
function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)', padding: '0 4px 8px' }}>{children}</div>;
}
/** A label/value row in the session Properties rail. */
function PropRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 30 }}>
      <span style={{ flexShrink: 0, width: 72, fontSize: 12, color: 'var(--muted)' }}>{label}</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
    </div>
  );
}

// ── Analytics card (boxed KPIs + charts) ─────────────────────────────────────
function Analytics({ rollup, turns }: { rollup: SessionRollup; turns: TraceTurn[] }): React.JSX.Element {
  const tokenData = turns.map((t, i) => ({ label: `#${i + 1}`, input: t.inputTokens, output: t.outputTokens }));
  const latencySeries = turns.map(t => t.durationMs ?? 0);
  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Kpi icon={<Layers size={13} />} label="Turns" value={String(rollup.turns)} />
        <Kpi icon={<Wrench size={13} />} label="Tool calls" value={String(rollup.toolCalls)} />
        <Kpi icon={<Coins size={13} />} label="Tokens" value={rollup.totalTokens > 0 ? formatTokens(rollup.totalTokens) : '—'} sub={rollup.totalTokens > 0 ? `${formatTokens(rollup.inputTokens)} in · ${formatTokens(rollup.outputTokens)} out` : undefined} />
        <Kpi icon={<Clock size={13} />} label="Latency" value={formatMs(rollup.p50DurationMs)} sub={`p95 ${formatMs(rollup.p95DurationMs)}`} />
      </div>
      {(rollup.inputTokens > 0 || rollup.outputTokens > 0 || rollup.reasoningTokens > 0) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <TokenChip label="in" value={rollup.inputTokens} />
          <TokenChip label="out" value={rollup.outputTokens} />
          {rollup.reasoningTokens > 0 && <TokenChip label="reasoning" value={rollup.reasoningTokens} />}
          {rollup.cacheReadTokens > 0 && <TokenChip label="cache read" value={rollup.cacheReadTokens} />}
          {rollup.cacheCreationTokens > 0 && <TokenChip label="cache write" value={rollup.cacheCreationTokens} />}
        </div>
      )}
      {turns.length > 1 && (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <StackBars title="Tokens per turn" data={tokenData} onBarClick={scrollToTurn} />
          <Bars title="Latency per turn" series={latencySeries} format={formatMs} color="var(--muted)" onBarClick={scrollToTurn} />
        </div>
      )}
      {rollup.models.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)', marginBottom: 6 }}>Models</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {rollup.models.map(m => {
              const max = rollup.models[0].tokens || 1;
              return (
                <div key={m.model} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <code style={{ flexShrink: 0, width: 160, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.model}</code>
                  <div style={{ flex: 1, height: 8, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(3, (m.tokens / max) * 100)}%`, height: '100%', background: 'var(--accent-2)', borderRadius: 4 }} />
                  </div>
                  <span style={{ flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, minWidth: 48, textAlign: 'right' }}>{formatTokens(m.tokens)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi(props: { icon: React.ReactNode; label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <div style={{ padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', color: 'var(--subtle)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{props.icon}{props.label}</div>
      <div style={{ marginTop: 4, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{props.value}</div>
      {props.sub && <div style={{ marginTop: 2, fontSize: 11, color: 'var(--subtle)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{props.sub}</div>}
    </div>
  );
}
function TokenChip(props: { label: string; value: number }): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, padding: '3px 8px', borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
      <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 9, fontWeight: 600, color: 'var(--subtle)' }}>{props.label}</span>
      <span style={{ color: 'var(--text)', fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>{formatTokens(props.value)}</span>
    </span>
  );
}
function Bars(props: { title: string; series: number[]; format: (n: number) => string; color: string; onBarClick?: (i: number) => void }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...props.series);
  return (
    <div style={{ padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, minHeight: 14 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)' }}>{props.title}</span>
        {hover != null && (
          <span style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)' }}>
            <span style={{ color: 'var(--subtle)' }}>#{hover + 1}</span> {props.format(props.series[hover])}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 }} onMouseLeave={() => setHover(null)}>
        {props.series.map((v, i) => (
          <div
            key={i}
            onMouseEnter={() => setHover(i)}
            onClick={() => props.onBarClick?.(i)}
            style={{ flex: 1, minWidth: 2, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: props.onBarClick ? 'pointer' : 'default' }}
          >
            <div style={{ width: '100%', height: `${Math.max(2, (v / max) * 100)}%`, background: props.color, borderRadius: 2, opacity: hover === i ? 1 : 0.5, transition: 'opacity 0.1s' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Scroll the timeline to a specific turn (used by chart bar clicks). */
function scrollToTurn(i: number): void {
  document.getElementById(`turn-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Interactive stacked in/out token chart (input lighter, output darker). */
function StackBars(props: { title: string; data: { label: string; input: number; output: number }[]; onBarClick?: (i: number) => void }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...props.data.map(d => d.input + d.output));
  const h = hover != null ? props.data[hover] : null;
  return (
    <div style={{ padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, minHeight: 14 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)' }}>{props.title}</span>
        {h && <span style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)' }}><span style={{ color: 'var(--subtle)' }}>{h.label}</span> {formatTokens(h.input)} in · {formatTokens(h.output)} out</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 }} onMouseLeave={() => setHover(null)}>
        {props.data.map((d, i) => {
          const total = d.input + d.output;
          return (
            <div key={i} onMouseEnter={() => setHover(i)} onClick={() => props.onBarClick?.(i)} style={{ flex: 1, minWidth: 2, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: props.onBarClick ? 'pointer' : 'default' }}>
              <div style={{ width: '100%', height: `${Math.max(2, (total / max) * 100)}%`, display: 'flex', flexDirection: 'column', borderRadius: 2, overflow: 'hidden', opacity: hover === i ? 1 : 0.7, transition: 'opacity 0.1s' }}>
                <div style={{ height: `${total ? (d.output / total) * 100 : 0}%`, background: 'var(--text-2)' }} />
                <div style={{ height: `${total ? (d.input / total) * 100 : 0}%`, background: 'var(--muted)' }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10, color: 'var(--subtle)' }}>
        <span><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--muted)', display: 'inline-block', marginRight: 4 }} />in</span>
        <span><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--text-2)', display: 'inline-block', marginRight: 4 }} />out</span>
      </div>
    </div>
  );
}

// ── Turn ────────────────────────────────────────────────────────────────────
function TurnCard({ turn, index, isLast, highlightSpanId }: { turn: TraceTurn; index: number; isLast?: boolean; highlightSpanId?: string | null }): React.JSX.Element {
  const nodes = buildNodes(turn);
  const containsHighlight = !!highlightSpanId && nodes.some(n => n.key === highlightSpanId);
  // Expand the most recent (last visible) turn by default; also a deep-linked turn,
  // and any still-running or errored turn so failures aren't hidden behind a card.
  const [open, setOpen] = useState(!!isLast || containsHighlight || turn.status === 'in_progress' || turn.status === 'error');
  const label = turn.agentName ?? turn.agentId.slice(0, 8);
  const color = agentColor(turn.agentId);
  const statusColor = STATUS_COLOR[turn.status] ?? 'var(--muted)';
  const tokens = turn.inputTokens + turn.outputTokens;
  const toolCount = turn.spans.filter(s => s.kind === 'tool').length;
  const toolErrors = turn.spans.filter(s => s.kind === 'tool' && s.status === 'error').length;
  const sentiment = turn.feedback.length ? (turn.feedback.some(f => f.sentiment === 'down') ? 'down' : 'up') : null;
  // Longest step drives the comparative duration-bar scale (left-aligned, not
  // absolute-positioned — clearer than a waterfall when tool spans are ~0ms).
  const maxStepMs = Math.max(1, ...nodes.map(n => n.durationMs ?? 0));

  // Author line — who sent / whose idea.
  const author = turn.initiatorKind === 'agent'
    ? (turn.delegatedByAgentName ? `via @${turn.delegatedByAgentName}` : 'from agent')
    : `from @${turn.initiatorHandle || 'user'}`;

  const running = turn.status === 'in_progress';
  return (
    <div id={`turn-${index}`} style={{
      background: running ? 'color-mix(in srgb, #2563eb 4%, var(--surface))' : 'var(--surface)',
      border: `1px solid ${running ? 'rgba(37,99,235,0.35)' : 'var(--border)'}`,
      borderRadius: 12, overflow: 'hidden', scrollMarginTop: 16, boxShadow: 'var(--shadow-sm)',
    }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: '50%', background: color, color: 'white', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{initials(label)}</div>
          <div style={{ position: 'absolute', bottom: -1, right: -1, width: 10, height: 10, borderRadius: '50%', background: statusColor, border: '2px solid var(--surface)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--subtle)', fontWeight: 600 }}>#{index + 1}</span>
            {turn.agentSlug
              ? <Link href={`/agents/${turn.agentSlug}`} onClick={e => e.stopPropagation()} style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', textDecoration: 'none' }}>{label}</Link>
              : <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</span>}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--subtle)' }}>
              {turn.initiatorKind === 'agent' && <GitBranch size={11} />}{author}
            </span>
            {running && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#2563eb' }}><Loader2 size={11} style={{ animation: 'spin 1.2s linear infinite' }} /> Working</span>}
            {sentiment && (sentiment === 'up' ? <ThumbsUp size={13} style={{ color: '#16a34a' }} /> : <ThumbsDown size={13} style={{ color: '#dc2626' }} />)}
            {turn.sensitive && <SensitiveBadge categories={turn.sensitiveCategories} />}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginLeft: 'auto', fontSize: 11, color: 'var(--subtle)' }}>
              {toolCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Wrench size={11} />{toolCount}{toolErrors > 0 && <span style={{ color: 'var(--red)', fontWeight: 600 }}> {toolErrors}✕</span>}</span>}
              {tokens > 0 && <span title={`${formatTokens(turn.inputTokens)} in · ${formatTokens(turn.outputTokens)} out`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Coins size={11} />{formatTokens(turn.inputTokens)} in · {formatTokens(turn.outputTokens)} out</span>}
              {turn.costUsd > 0 && <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{formatCost(turn.costUsd)}</span>}
              <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{formatMs(turn.durationMs)}</span>
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </div>
          {turn.messagePreview && <div style={{ marginTop: 6, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{turn.messagePreview}</div>}
        </div>
      </div>

      {open && (
        <div style={{ padding: '4px 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {turn.spans.length === 0 && turn.status === 'in_progress' && (
            <div style={{ fontSize: 12, color: 'var(--subtle)', display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: 4 }}><Loader2 size={12} style={{ animation: 'spin 1.2s linear infinite' }} /> running…</div>
          )}
          {/* Observation list: type tag · name · proportional duration bar · duration. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {nodes.map(node => <NodeRow key={node.key} node={node} maxMs={maxStepMs} highlight={!!highlightSpanId && node.key === highlightSpanId} />)}
          </div>

          {turn.feedback.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 6, background: f.sentiment === 'up' ? 'rgba(22,163,74,0.06)' : 'rgba(220,38,38,0.06)', border: `1px solid ${f.sentiment === 'up' ? 'rgba(22,163,74,0.2)' : 'rgba(220,38,38,0.2)'}` }}>
              {f.sentiment === 'up' ? <ThumbsUp size={13} style={{ color: '#16a34a', flexShrink: 0, marginTop: 1 }} /> : <ThumbsDown size={13} style={{ color: '#dc2626', flexShrink: 0, marginTop: 1 }} />}
              <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text)' }}>
                {f.raterHandle && <span style={{ fontWeight: 500 }}>@{f.raterHandle}</span>}
                {f.note && <span style={{ color: 'var(--muted)' }}>{f.raterHandle ? ' — ' : ''}{f.note}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


function FbChip({ label, icon, active, color, onClick }: { label: string; icon?: React.ReactNode; active: boolean; color?: string; onClick: () => void }): React.JSX.Element {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 7,
      fontSize: 11, fontWeight: 600, cursor: 'pointer',
      border: `1px solid ${active ? 'var(--border-2)' : 'var(--border)'}`,
      background: active ? 'var(--surface-2)' : 'transparent',
      color: active && color ? color : active ? 'var(--text)' : 'var(--muted)',
    }}>
      {icon}{label}
    </button>
  );
}


function StatusPill({ status }: { status: 'in_progress' | 'done' | 'error' }): React.JSX.Element {
  const map = {
    in_progress: { label: 'Running', bg: 'rgba(37,99,235,0.1)', fg: '#1d4ed8', icon: <Loader2 size={10} style={{ animation: 'spin 1.2s linear infinite' }} /> },
    done: { label: 'Done', bg: 'rgba(5,150,105,0.1)', fg: '#047857', icon: <CheckCircle2 size={10} /> },
    error: { label: 'Error', bg: 'rgba(220,38,38,0.1)', fg: '#b91c1c', icon: <AlertTriangle size={10} /> },
  }[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 10, background: map.bg, color: map.fg, fontSize: 10, fontWeight: 600, letterSpacing: '0.02em' }}>
      {map.icon}{map.label}
    </span>
  );
}
