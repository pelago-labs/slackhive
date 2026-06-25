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
import { deepLinkLabelForPlatform } from '@slackhive/shared/deep-link';
import {
  ArrowLeft, ExternalLink, ChevronRight, ChevronDown,
  Wrench, CheckCircle2, AlertTriangle, Loader2,
  ThumbsUp, ThumbsDown, Coins, GitBranch, Layers, Clock, ArrowRight,
} from 'lucide-react';
import { formatTokens } from '../_components/formatTokens';
import { type TraceTurn } from '@slackhive/shared';
import { relativeTime } from '@/lib/time';
import { SEV_COLOR } from '../_components/SevBadge';
import { RevealCtx, NodeDetailProvider, SensitiveBadge, buildNodes, NodeRow, formatMs } from '../_components/trace-nodes';
import { ReplayButton } from '../_components/ReplayButton';
import { cn } from '@/lib/utils';
import { PageShell, SectionLabel, Avatar, EmptyState } from '@/components/patterns';

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
  if (!detail) return <Shell><div className="mt-5 p-6 text-sm text-muted-foreground">Loading…</div></Shell>;

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
    <NodeDetailProvider>
    <Shell>
      {/* Title + description (the Back button above handles navigation) */}
      <div className="mt-4">
        <h1 className="m-0 text-xl font-semibold leading-tight tracking-normal text-foreground">
          {task.summary || '(empty opening message)'}
        </h1>
        <div className="mt-2 text-sm text-muted-foreground">
          Started by <strong className="font-medium text-foreground">@{initiator}</strong> · {relativeTime(task.startedAt)}
        </div>
      </div>

      <div className="mt-[18px] flex flex-wrap items-start gap-6">
        {/* ── Main column: analytics + flows + activity timeline ── */}
        <div className="min-w-0 flex-[1_1_600px]">
          {rollup && <Analytics rollup={rollup} turns={turns} />}

          {flows.length > 0 && (
            <div className="mt-[18px]">
              <SectionLabel>Sensitive data flows</SectionLabel>
              <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
                {flows.map((f, i) => (
                  <a key={f.id} href={`#span-${f.sinkSpanId}`}
                    className={cn('flex items-center gap-2.5 px-3.5 py-2.5 text-inherit no-underline transition-colors hover:bg-secondary', i !== 0 && 'border-t border-border')}>
                    <span className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-bold uppercase tracking-[0.04em]" style={{ background: `${SEV_COLOR[f.severity]}1a`, color: SEV_COLOR[f.severity] }}>{f.severity}</span>
                    <span className="shrink-0 text-xs font-semibold text-foreground">{f.label}</span>
                    <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{f.sourceLabel}</span>
                      <ArrowRight size={12} className="shrink-0 text-red" />
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{f.sinkLabel}</span>
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="mt-[18px]">
            <div className="flex items-center justify-between px-1 pb-2">
              <SectionLabel>Trace</SectionLabel>
              {(upTurns > 0 || downTurns > 0) && (
                <div className="inline-flex gap-1">
                  <FbChip label="All" active={fbFilter === 'all'} onClick={() => setFbFilter('all')} />
                  <FbChip icon={<ThumbsUp size={11} />} label={String(upTurns)} active={fbFilter === 'up'} color="text-green" onClick={() => setFbFilter(fbFilter === 'up' ? 'all' : 'up')} />
                  <FbChip icon={<ThumbsDown size={11} />} label={String(downTurns)} active={fbFilter === 'down'} color="text-red" onClick={() => setFbFilter(fbFilter === 'down' ? 'all' : 'down')} />
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2.5">
              {turns.length === 0 && <Empty>No activity recorded yet.</Empty>}
              {turns.length > 0 && visibleTurns.length === 0 && <Empty>No turns match this filter.</Empty>}
              {visibleTurns.map(({ t, i }, vi) => <TurnCard key={t.activityId} turn={t} index={i} isLast={vi === visibleTurns.length - 1} isLastTurn={i === turns.length - 1} taskId={task.id} highlightSpanId={highlightSpanId} />)}
            </div>
          </div>
        </div>

        {/* ── Properties rail ── */}
        <aside className="sticky top-6 max-w-full flex-[0_0_240px]">
          <div className="mb-3 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Properties</div>
          <PropRow label="Status"><StatusPill status={sessionStatus} /></PropRow>
          <PropRow label="Assignee">
            <span className="text-xs text-foreground">{agents.length ? agents.map(a => a.name).join(', ') : '—'}</span>
          </PropRow>
          <PropRow label="Initiator"><span className="text-xs text-foreground">@{initiator}</span></PropRow>
          <PropRow label="Started"><span className="text-xs text-muted-foreground">{relativeTime(task.startedAt)}</span></PropRow>
          {turns.some(t => t.sensitive) && (
            <PropRow label="Sensitive"><SensitiveBadge categories={[...new Set(turns.flatMap(t => t.sensitiveCategories))]} /></PropRow>
          )}
          {deepLink && (
            <a href={deepLink} target="_blank" rel="noopener noreferrer"
              className="mt-3.5 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground no-underline">
              {deepLinkLabelForPlatform(task.platform as 'slack' | 'discord' | 'telegram' | 'whatsapp' | 'teams')} <ExternalLink size={12} />
            </a>
          )}
        </aside>
      </div>
    </Shell>
    </NodeDetailProvider>
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
    <PageShell>
      <button onClick={back} className="inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 font-sans text-xs text-muted-foreground">
        <ArrowLeft size={13} /> Back
      </button>
      {children}
    </PageShell>
  );
}
function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mt-5"><EmptyState title={children} /></div>;
}
/** A label/value row in the session Properties rail. */
function PropRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-[30px] items-center gap-2.5">
      <span className="w-[72px] shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 overflow-hidden text-ellipsis">{children}</span>
    </div>
  );
}

// ── Analytics card (boxed KPIs + charts) ─────────────────────────────────────
function Analytics({ rollup, turns }: { rollup: SessionRollup; turns: TraceTurn[] }): React.JSX.Element {
  const tokenData = turns.map((t, i) => ({ label: `#${i + 1}`, input: t.inputTokens, output: t.outputTokens }));
  const latencySeries = turns.map(t => t.durationMs ?? 0);
  return (
    <div className="mt-4 flex flex-col gap-3.5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
        <Kpi icon={<Layers size={13} />} label="Turns" value={String(rollup.turns)} />
        <Kpi icon={<Wrench size={13} />} label="Tool calls" value={String(rollup.toolCalls)} />
        <Kpi icon={<Coins size={13} />} label="Tokens" value={rollup.totalTokens > 0 ? formatTokens(rollup.totalTokens) : '—'} sub={rollup.totalTokens > 0 ? `${formatTokens(rollup.inputTokens)} in · ${formatTokens(rollup.outputTokens)} out` : undefined} />
        <Kpi icon={<Clock size={13} />} label="Latency" value={formatMs(rollup.p50DurationMs)} sub={`p95 ${formatMs(rollup.p95DurationMs)}`} />
      </div>
      {(rollup.inputTokens > 0 || rollup.outputTokens > 0 || rollup.reasoningTokens > 0) && (
        <div className="flex flex-wrap gap-1.5">
          <TokenChip label="in" value={rollup.inputTokens} />
          <TokenChip label="out" value={rollup.outputTokens} />
          {rollup.reasoningTokens > 0 && <TokenChip label="reasoning" value={rollup.reasoningTokens} />}
          {rollup.cacheReadTokens > 0 && <TokenChip label="cache read" value={rollup.cacheReadTokens} />}
          {rollup.cacheCreationTokens > 0 && <TokenChip label="cache write" value={rollup.cacheCreationTokens} />}
        </div>
      )}
      {turns.length > 1 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          <StackBars title="Tokens per turn" data={tokenData} onBarClick={scrollToTurn} />
          <Bars title="Latency per turn" series={latencySeries} format={formatMs} color="var(--muted)" onBarClick={scrollToTurn} />
        </div>
      )}
      {rollup.models.length > 0 && (
        <div>
          <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Models</div>
          <div className="flex flex-col gap-1.5">
            {rollup.models.map(m => {
              const max = rollup.models[0].tokens || 1;
              return (
                <div key={m.model} className="flex items-center gap-2 text-xs">
                  <code className="w-40 shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-2xs text-foreground">{m.model}</code>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-secondary">
                    <div className="h-full rounded bg-blue" style={{ width: `${Math.max(3, (m.tokens / max) * 100)}%` }} />
                  </div>
                  <span className="min-w-[48px] shrink-0 text-right font-mono text-2xs text-muted-foreground">{formatTokens(m.tokens)}</span>
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
    <div className="rounded-lg border border-border bg-secondary px-3 py-2.5">
      <div className="inline-flex items-center gap-1.5 whitespace-nowrap text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">{props.icon}{props.label}</div>
      <div className="mt-1 whitespace-nowrap text-lg font-semibold tabular-nums tracking-tight text-foreground">{props.value}</div>
      {props.sub && <div className="mt-0.5 whitespace-nowrap text-2xs tabular-nums text-muted-foreground">{props.sub}</div>}
    </div>
  );
}
function TokenChip(props: { label: string; value: number }): React.JSX.Element {
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-md border border-border bg-secondary px-2 py-0.5 text-2xs text-muted-foreground">
      <span className="text-2xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">{props.label}</span>
      <span className="font-mono font-semibold text-foreground">{formatTokens(props.value)}</span>
    </span>
  );
}
function Bars(props: { title: string; series: number[]; format: (n: number) => string; color: string; onBarClick?: (i: number) => void }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...props.series);
  return (
    <div className="rounded-lg border border-border bg-secondary px-3.5 py-3">
      <div className="mb-2 flex min-h-[14px] items-baseline justify-between">
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{props.title}</span>
        {hover != null && (
          <span className="font-mono text-2xs text-foreground">
            <span className="text-muted-foreground">#{hover + 1}</span> {props.format(props.series[hover])}
          </span>
        )}
      </div>
      <div className="flex h-14 items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
        {props.series.map((v, i) => (
          <div
            key={i}
            onMouseEnter={() => setHover(i)}
            onClick={() => props.onBarClick?.(i)}
            className={cn('flex h-full min-w-[2px] flex-1 items-end', props.onBarClick ? 'cursor-pointer' : 'cursor-default')}
          >
            <div className="w-full rounded-[2px] transition-opacity duration-100" style={{ height: `${Math.max(2, (v / max) * 100)}%`, background: props.color, opacity: hover === i ? 1 : 0.5 }} />
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
    <div className="rounded-lg border border-border bg-secondary px-3.5 py-3">
      <div className="mb-2 flex min-h-[14px] items-baseline justify-between">
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{props.title}</span>
        {h && <span className="font-mono text-2xs text-foreground"><span className="text-muted-foreground">{h.label}</span> {formatTokens(h.input)} in · {formatTokens(h.output)} out</span>}
      </div>
      <div className="flex h-14 items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
        {props.data.map((d, i) => {
          const total = d.input + d.output;
          return (
            <div key={i} onMouseEnter={() => setHover(i)} onClick={() => props.onBarClick?.(i)} className={cn('flex h-full min-w-[2px] flex-1 items-end', props.onBarClick ? 'cursor-pointer' : 'cursor-default')}>
              <div className="flex w-full flex-col overflow-hidden rounded-[2px] transition-opacity duration-100" style={{ height: `${Math.max(2, (total / max) * 100)}%`, opacity: hover === i ? 1 : 0.7 }}>
                <div className="bg-foreground" style={{ height: `${total ? (d.output / total) * 100 : 0}%` }} />
                <div className="bg-muted-foreground" style={{ height: `${total ? (d.input / total) * 100 : 0}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-3 text-2xs text-muted-foreground">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-[2px] bg-muted-foreground" />in</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-[2px] bg-foreground" />out</span>
      </div>
    </div>
  );
}

// ── Turn ────────────────────────────────────────────────────────────────────
function TurnCard({ turn, index, isLast, isLastTurn, taskId, highlightSpanId }: { turn: TraceTurn; index: number; isLast?: boolean; isLastTurn?: boolean; taskId: string; highlightSpanId?: string | null }): React.JSX.Element {
  const nodes = buildNodes(turn);
  const containsHighlight = !!highlightSpanId && nodes.some(n => n.key === highlightSpanId);
  // Expand the most recent (last visible) turn by default; also a deep-linked turn,
  // and any still-running or errored turn so failures aren't hidden behind a card.
  const [open, setOpen] = useState(!!isLast || containsHighlight || turn.status === 'in_progress' || turn.status === 'error');
  const label = turn.agentName ?? turn.agentId.slice(0, 8);
  const avatarStatus = turn.status === 'in_progress' ? 'in_progress' : turn.status === 'error' ? 'error' : 'done';
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
    <div id={`turn-${index}`}
      className="scroll-mt-4 overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      style={running ? { background: 'color-mix(in srgb, var(--blue) 4%, var(--surface))', borderColor: 'color-mix(in srgb, var(--blue) 35%, transparent)' } : undefined}>
      <div onClick={() => setOpen(o => !o)} className="flex cursor-pointer items-center gap-3 px-4 py-3">
        <Avatar id={turn.agentId} name={label} size={30} status={avatarStatus} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs font-semibold text-muted-foreground">#{index + 1}</span>
            {turn.agentSlug
              ? <Link href={`/agents/${turn.agentSlug}`} onClick={e => e.stopPropagation()} className="text-sm font-semibold text-foreground no-underline">{label}</Link>
              : <span className="text-sm font-semibold text-foreground">{label}</span>}
            <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
              {turn.initiatorKind === 'agent' && <GitBranch size={11} />}{author}
            </span>
            {running && <span className="inline-flex items-center gap-1 text-2xs font-semibold text-blue"><Loader2 size={11} className="animate-spin" /> Working</span>}
            {sentiment && (sentiment === 'up' ? <ThumbsUp size={13} className="text-green" /> : <ThumbsDown size={13} className="text-red" />)}
            {turn.sensitive && <SensitiveBadge categories={turn.sensitiveCategories} />}
            <span className="ml-auto inline-flex items-center gap-2.5 text-2xs text-muted-foreground">
              {toolCount > 0 && <span className="inline-flex items-center gap-1"><Wrench size={11} />{toolCount}{toolErrors > 0 && <span className="font-semibold text-red"> {toolErrors}✕</span>}</span>}
              {tokens > 0 && <span title={`${formatTokens(turn.inputTokens)} in · ${formatTokens(turn.outputTokens)} out`} className="inline-flex items-center gap-1"><Coins size={11} />{formatTokens(turn.inputTokens)} in · {formatTokens(turn.outputTokens)} out</span>}
              {turn.costUsd > 0 && <span className="font-mono">{formatCost(turn.costUsd)}</span>}
              <span className="font-mono">{formatMs(turn.durationMs)}</span>
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </div>
          {turn.messagePreview && <div className="mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-sm leading-relaxed text-muted-foreground">{turn.messagePreview}</div>}
          {isLastTurn && turn.status === 'error' && (
            <div className="mt-2" onClick={e => e.stopPropagation()}>
              <ReplayButton taskId={taskId} activityId={turn.activityId} variant="labeled" />
            </div>
          )}
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-2 px-3.5 pb-3.5 pt-1">
          {turn.spans.length === 0 && turn.status === 'in_progress' && (
            <div className="inline-flex items-center gap-1.5 pl-1 text-xs text-muted-foreground"><Loader2 size={12} className="animate-spin" /> running…</div>
          )}
          {/* Observation list: type tag · name · proportional duration bar · duration. */}
          <div className="flex flex-col gap-px">
            {nodes.map((node, ni) => <NodeRow key={node.key} node={node} maxMs={maxStepMs} isLast={ni === nodes.length - 1} highlight={!!highlightSpanId && node.key === highlightSpanId} />)}
          </div>

          {turn.feedback.map((f, i) => (
            <div key={i} className="flex items-start gap-2 rounded-md border px-2.5 py-2" style={{
              background: `color-mix(in srgb, var(--${f.sentiment === 'up' ? 'green' : 'red'}) 6%, transparent)`,
              borderColor: `color-mix(in srgb, var(--${f.sentiment === 'up' ? 'green' : 'red'}) 20%, transparent)`,
            }}>
              {f.sentiment === 'up' ? <ThumbsUp size={13} className="mt-px shrink-0 text-green" /> : <ThumbsDown size={13} className="mt-px shrink-0 text-red" />}
              <div className="min-w-0 flex-1 text-xs text-foreground">
                {f.raterHandle && <span className="font-medium">@{f.raterHandle}</span>}
                {f.note && <span className="text-muted-foreground">{f.raterHandle ? ' — ' : ''}{f.note}</span>}
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
    <button onClick={onClick} className={cn(
      'inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-2xs font-semibold',
      active ? 'border-border bg-secondary' : 'border-border bg-transparent text-muted-foreground',
      active && color ? color : active ? 'text-foreground' : '',
    )}>
      {icon}{label}
    </button>
  );
}


function StatusPill({ status }: { status: 'in_progress' | 'done' | 'error' }): React.JSX.Element {
  const map = {
    in_progress: { label: 'Running', color: 'blue', text: 'text-blue', icon: <Loader2 size={10} className="animate-spin" /> },
    done: { label: 'Done', color: 'green', text: 'text-green', icon: <CheckCircle2 size={10} /> },
    error: { label: 'Error', color: 'red', text: 'text-red', icon: <AlertTriangle size={10} /> },
  }[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-semibold tracking-[0.02em]', map.text)}
      style={{ background: `color-mix(in srgb, var(--${map.color}) 10%, transparent)` }}>
      {map.icon}{map.label}
    </span>
  );
}
