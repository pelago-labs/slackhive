'use client';

/**
 * @fileoverview LLMOps insights — one scope-aware page consolidating Overview,
 * Tokens/Cost, Sensitive, Tools, Feedback, and Sessions. Driven by URL params
 * (scope/agent/session/tab/window/from/to) so views are shareable; reads the
 * composed /api/activity/insights endpoint. Token/cost/power-users are
 * superadmin-only (the server strips them; the client also hides the tab).
 *
 * @module web/app/observability
 */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Activity as ActivityIcon, Coins, ShieldAlert, Wrench, ThumbsUp, ThumbsDown, Layers, Lock, ArrowRight, ExternalLink, ChevronRight, ChevronDown, Brain, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { FilterRow, parseWindowKey, timeParams, type WindowKey } from '../activity/_components/FilterRow';
import { formatTokens } from '../activity/_components/formatTokens';
import { SevBadge } from '../activity/_components/SevBadge';
import { RevealCtx, NodeDetailProvider, buildNodes, NodeRow, SensitiveBadge, type NodeData } from '../activity/_components/trace-nodes';
import { relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { PageShell } from '@/components/patterns';
import type { TraceTurn } from '@slackhive/shared';

interface AgentLite { id: string; slug: string; name: string }
type Severity = 'critical' | 'high' | 'medium' | 'low';

// Superset of the all-agents InsightsRollup AND the single-session SessionRollup.
// Session scope omits sessions/errorTurns/feedback/sensitiveEvents/tokensByDay/topTools
// and instead carries errorCount — hence the optional fields.
interface Rollup {
  turns: number; toolCalls: number; generations: number;
  inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number;
  p50DurationMs: number; p95DurationMs: number;
  models: { model: string; turns: number; tokens: number }[];
  // all-agents (InsightsRollup) only:
  sessions?: number; errorTurns?: number; feedbackUp?: number; feedbackDown?: number; sensitiveEvents?: number;
  tokensByDay?: { date: string; input: number; output: number }[];
  topTools?: { name: string; count: number; errors: number }[];
  // single-session (SessionRollup) only:
  errorCount?: number;
}
interface AgentTokens { agentId: string; inputTokens: number; outputTokens: number; turnCount: number }
interface PowerUser { userId: string; handle: string | null; taskCount: number; turnCount: number; totalTokens: number }
interface SensEvent { spanId: string; sessionId: string; agentName: string | null; toolName: string | null; reason: string | null; severity: Severity | null; caughtByLlm?: boolean; startMs: number; sessionSummary: string | null }
interface SensFlow { id: string; label: string; severity: Severity; sourceLabel: string; sinkLabel: string; sinkSpanId: string; sessionId: string | null; startMs: number }
interface ToolErrorGroup { message: string; count: number; sessions: number; sampleSessionId: string | null }
interface ToolStat { name: string; calls: number; errors: number; errorGroups?: ToolErrorGroup[] }
interface SessionRow {
  sessionId: string; summary: string | null; initiatorHandle: string | null; agentIds: string[];
  turns: number; inputTokens: number; outputTokens: number;
  status: 'active' | 'done' | 'error'; sensitive: boolean;
  feedbackUp: number; feedbackDown: number; startedAt: string; lastActivityAt: string;
}

interface InsightsResponse {
  scope: 'all' | 'agent' | 'session';
  agent?: string | null; session?: string;
  rollup: Rollup | null;
  byAgent?: AgentTokens[]; powerUsers?: PowerUser[] | null;
  events?: SensEvent[]; flows?: SensFlow[]; tools?: ToolStat[]; sessions?: SessionRow[];
  sessionsCursor?: string | null;
  models?: { model: string; turns: number; tokens: number }[]; agentIds?: string[];
}

interface SessionsPage { sessions: SessionRow[]; nextCursor: string | null }

type TabKey = 'overview' | 'tokens' | 'sensitive' | 'tools' | 'feedback' | 'sessions';

const cardCls = 'rounded-lg border border-border bg-card px-4 py-3.5 shadow-card';

/** Agent column cell: the (comma-joined) agent names. */
function AgentCell({ names }: { names: string[] }): React.JSX.Element {
  if (!names.length) return <Subtle>—</Subtle>;
  return <Subtle>{truncate(names.join(', '), 24)}</Subtle>;
}

export default function InsightsPage(): React.JSX.Element {
  return <Suspense fallback={null}><Body /></Suspense>;
}

function Body(): React.JSX.Element {
  const sp = useSearchParams();
  const router = useRouter();
  const { role } = useAuth();
  const isSuper = role === 'superadmin';
  // Tokens/cost: visible to editor+ (their own agents). Power-users: superadmin only.
  const canTokens = role === 'editor' || role === 'admin' || role === 'superadmin';

  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [agentFilter, setAgentFilter] = useState(sp?.get('agent') ?? '');
  const [from, setFrom] = useState(sp?.get('from') ?? '');
  const [to, setTo] = useState(sp?.get('to') ?? '');
  const [windowKey, setWindowKey] = useState<WindowKey>(parseWindowKey(sp?.get('window') ?? (sp?.get('from') && sp?.get('to') ? 'custom' : '30d')));
  const [tab, setTab] = useState<TabKey>((sp?.get('tab') as TabKey) || 'overview');
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Raw sensitive values are admin-only; everyone else already got redacted content.
  const canReveal = role === 'admin' || role === 'superadmin';

  useEffect(() => { fetch('/api/agents').then(r => r.json()).then(setAgents).catch(() => {}); }, []);
  const agentName = useMemo(() => new Map(agents.map(a => [a.id, a.name])), [agents]);

  const scope: 'all' | 'agent' = agentFilter ? 'agent' : 'all';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ scope, ...timeParams(windowKey, from, to) });
      if (agentFilter) qs.set('agent', agentFilter);
      const r = await fetch(`/api/activity/insights?${qs}`);
      if (r.status === 403) { setError('You do not have access to this view.'); setData(null); return; }
      if (!r.ok) { setError('Failed to load insights.'); setData(null); return; }
      setData(await r.json()); setError(null);
    } catch { setError('Failed to load insights.'); } finally { setLoading(false); }
  }, [scope, agentFilter, windowKey, from, to]);

  // Fetch the next page of sessions (keyset cursor) for the Sessions tab's "Load more".
  const loadMoreSessions = useCallback(async (cursor: string): Promise<SessionsPage> => {
    const qs = new URLSearchParams({ ...timeParams(windowKey, from, to), cursor });
    if (agentFilter) qs.set('agent', agentFilter);
    const r = await fetch(`/api/activity/sessions?${qs}`);
    if (!r.ok) throw new Error('Failed to load more sessions');
    return await r.json() as SessionsPage;
  }, [agentFilter, windowKey, from, to]);

  useEffect(() => { load(); }, [load]);

  // Reflect filters in the URL (shareable / bookmarkable). Only replace when the
  // query actually changed — and target THIS route (/observability); replacing to
  // /activity/insights would hit its redirect stub and loop forever.
  useEffect(() => {
    const qs = new URLSearchParams();
    if (agentFilter) qs.set('agent', agentFilter);
    qs.set('tab', tab);
    if (windowKey !== 'custom') qs.set('window', windowKey); else { if (from) qs.set('from', from); if (to) qs.set('to', to); }
    const next = qs.toString();
    const current = sp?.toString() ?? '';
    // Compare as sorted sets so param order alone never triggers a navigation.
    const norm = (s: string) => s.split('&').sort().join('&');
    if (norm(next) !== norm(current)) router.replace(`/observability?${next}`, { scroll: false });
  }, [agentFilter, tab, windowKey, from, to, router, sp]);

  // All tabs are visible to anyone who can reach this page (editor+); token data is
  // gated inside the Tokens tab via canTokens, and power-users via isSuper.
  const tabs: { key: TabKey; label: string; Icon: typeof ActivityIcon }[] = [
    { key: 'overview', label: 'Overview', Icon: ActivityIcon },
    { key: 'tokens', label: 'Tokens & Cost', Icon: Coins },
    { key: 'sensitive', label: 'Sensitive', Icon: ShieldAlert },
    { key: 'tools', label: 'Tools', Icon: Wrench },
    { key: 'sessions', label: 'Sessions', Icon: Layers },
  ];
  const activeTab = tabs.some(t => t.key === tab) ? tab : 'overview';

  return (
    <PageShell>
      {(
        <>
          {/* Header: title/subtitle left, filters right — fills the otherwise-empty right side. */}
          <div className="mb-5 flex flex-wrap items-start justify-between gap-6 border-b border-border pb-5">
            <div className="min-w-0">
              <h1 className="m-0 text-2xl font-bold tracking-normal text-foreground">
                {scope === 'agent' ? `Observability · ${agentName.get(agentFilter) ?? 'Agent'}` : 'Observability'}
              </h1>
              <div className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Operational health, model usage, sensitive access, tool reliability and session traces.
              </div>
            </div>
            <div className="[&>div]:mb-0">
              <FilterRow
                agents={agents} agentFilter={agentFilter} windowKey={windowKey}
                onAgentChange={setAgentFilter} onWindowChange={setWindowKey}
                from={from} to={to} onRangeChange={(f, t) => { setFrom(f); setTo(t); }}
              />
            </div>
          </div>
          {/* Tabs */}
          <div className="mb-5 inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-border bg-muted p-1 shadow-sm">
            {tabs.map(t => {
              const on = t.key === activeTab;
              return (
                <button key={t.key} onClick={() => setTab(t.key)} className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-md border border-transparent px-3 text-xs transition-colors',
                  on ? 'bg-card font-semibold text-foreground shadow-sm' : 'font-medium text-muted-foreground hover:bg-card/60 hover:text-foreground',
                )}><t.Icon size={13} /> {t.label}</button>
              );
            })}
          </div>

          {loading && !data ? <Muted>Loading…</Muted>
            : error ? <Muted>{error}</Muted>
            : !data ? <Muted>No data.</Muted>
            : activeTab === 'overview' ? <Overview data={data} agentName={agentName} canTokens={canTokens} onTab={setTab} />
            : activeTab === 'tokens' ? <Tokens data={data} agentName={agentName} canTokens={canTokens} isSuper={isSuper} />
            : activeTab === 'sensitive' ? <Sensitive events={data.events ?? []} flows={data.flows ?? []} />
            : activeTab === 'tools' ? <Tools tools={data.tools ?? []} />
            : <Sessions sessions={data.sessions ?? []} cursor={data.sessionsCursor ?? null} fetchMore={loadMoreSessions} agentName={agentName} canTokens={canTokens} canReveal={canReveal} />}
        </>
      )}
    </PageShell>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div className={cn(cardCls, 'text-sm text-muted-foreground')}>{children}</div>;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-[120px] flex-[1_1_120px] rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
      <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-xl font-bold tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function MiniMetric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-3 shadow-sm">
      <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold tabular-nums text-foreground" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-2xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function fmtMs(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`; }

function Bars({ rows, max }: { rows: { label: string; value: number; sub: string }[]; max: number }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[150px_1fr_auto] items-center gap-2.5">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-foreground">{r.label}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full opacity-80" style={{ width: `${Math.max(3, max ? (r.value / max) * 100 : 0)}%`, background: 'var(--accent-2, #404040)' }} />
          </div>
          <span className="whitespace-nowrap font-mono text-2xs text-muted-foreground">{r.sub}</span>
        </div>
      ))}
    </div>
  );
}

/** Stacked tokens-per-day bar chart (input lighter, output darker) with a hover
 *  tooltip showing the date + in/out counts, and first/last date labels on the axis. */
function TokensChart({ data }: { data: { date: string; input: number; output: number }[] }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const totals = data.map(d => d.input + d.output);
  const totalAll = totals.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...totals);
  const avg = totalAll / Math.max(1, totals.length);
  const peakIndex = totals.findIndex(v => v === max);
  const h = hover != null ? data[hover] : null;
  const fmtDay = (iso: string) => {
    const [, m, day] = iso.split('-');
    return m && day ? `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m)]} ${Number(day)}` : iso;
  };
  const point = (i: number, value: number) => {
    const x = data.length === 1 ? 50 : (i / (data.length - 1)) * 100;
    const y = 44 - (value / max) * 36;
    return { x, y };
  };
  const points = totals.map((value, i) => point(i, value));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L 100 44 L 0 44 Z`;
  const hoverPoint = hover == null ? null : points[hover];
  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <MiniMetric label="Total" value={formatTokens(totalAll)} sub="window usage" />
        <MiniMetric label="Average/day" value={formatTokens(avg)} sub={`${data.length} days`} />
        <MiniMetric label="Peak day" value={formatTokens(max)} sub={peakIndex >= 0 ? fmtDay(data[peakIndex].date) : '—'} />
        <MiniMetric label="Range" value={`${fmtDay(data[0].date)}–${fmtDay(data[data.length - 1].date)}`} sub="selected window" />
      </div>
      <div className="mb-2 flex h-5 items-center gap-2 text-xs">
        {h ? (
          <>
            <span className="font-semibold text-foreground">{fmtDay(h.date)}</span>
            <span className="text-muted-foreground">{formatTokens(h.input + h.output)} total</span>
            <span className="text-muted-foreground">· {formatTokens(h.input)} in · {formatTokens(h.output)} out</span>
          </>
        ) : (
          <span className="text-muted-foreground">Hover the trend for daily token details.</span>
        )}
      </div>
      <div className="relative min-h-[176px]" onMouseLeave={() => setHover(null)}>
        <svg viewBox="0 0 100 48" preserveAspectRatio="none" className="h-40 w-full overflow-visible">
          {[8, 20, 32, 44].map(y => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="var(--border)" strokeWidth="0.35" vectorEffect="non-scaling-stroke" />)}
          <path d={areaPath} fill="var(--accent-2)" opacity="0.08" />
          <path d={linePath} fill="none" stroke="var(--accent-2)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
          {hoverPoint && (
            <>
              <line x1={hoverPoint.x} x2={hoverPoint.x} y1="6" y2="44" stroke="var(--border-2)" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
              <circle cx={hoverPoint.x} cy={hoverPoint.y} r="1.3" fill="var(--surface)" stroke="var(--accent-2)" strokeWidth="0.9" vectorEffect="non-scaling-stroke" />
            </>
          )}
        </svg>
        <div className="absolute inset-0 flex">
          {data.map((d, i) => (
            <button
              key={d.date}
              type="button"
              aria-label={`${fmtDay(d.date)} ${formatTokens(d.input + d.output)} tokens`}
              onMouseEnter={() => setHover(i)}
              className="h-full flex-1 cursor-default border-0 bg-transparent p-0"
            />
          ))}
        </div>
        <div className="mt-1.5 flex items-center text-2xs text-muted-foreground">
          <span>{fmtDay(data[0].date)}</span>
          <span className="mx-auto font-mono">peak {formatTokens(max)}</span>
          <span>{fmtDay(data[data.length - 1].date)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Table primitive + cell helpers ───────────────────────────────────────────

/** Accepts a ms epoch (span timestamps) OR a SQLite 'YYYY-MM-DD HH:MM:SS' string. */
interface Col<T> { label: string; align?: 'left' | 'right' | 'center'; width?: string; render: (row: T) => React.ReactNode }

const thCls = 'whitespace-nowrap border-b border-border bg-muted/45 px-3 py-2 text-2xs font-semibold uppercase tracking-[0.03em] text-muted-foreground';

function Table<T>({ cols, rows, rowHref, empty }: { cols: Col<T>[]; rows: T[]; rowHref?: (r: T) => string | undefined; empty: string }) {
  const router = useRouter();
  if (rows.length === 0) return <div className="px-3 py-4 text-center text-xs text-muted-foreground">{empty}</div>;
  return (
    <div className="-mx-4 -mb-3.5 overflow-x-auto border-t border-border">
      <table className="w-full border-collapse">
        <thead><tr>{cols.map((c, i) => <th key={i} className={cn(thCls, i === 0 ? 'pl-4' : 'pl-3', i === cols.length - 1 ? 'pr-4' : 'pr-3')} style={{ textAlign: c.align ?? 'left', width: c.width }}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, ri) => {
            const href = rowHref?.(row);
            const last = ri === rows.length - 1;
            return (
              <tr key={ri}
                onClick={href ? () => router.push(href) : undefined}
                className={cn('trace-node', href ? 'cursor-pointer' : 'cursor-default')}>
                {cols.map((c, ci) => (
                  <td key={ci} className={cn(
                    'px-3 py-2.5 align-middle text-sm text-foreground transition-colors',
                    ci === 0 ? 'pl-4' : 'pl-3', ci === cols.length - 1 ? 'pr-4' : 'pr-3',
                    last ? 'border-b-0' : 'border-b border-border',
                    c.align === 'right' && 'whitespace-nowrap tabular-nums',
                    c.align !== 'right' && 'whitespace-nowrap',
                  )} style={{ textAlign: c.align ?? 'left' }}>{c.render(row)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatePill({ status }: { status: 'active' | 'done' | 'error' }) {
  const cls = status === 'error' ? 'text-red' : status === 'active' ? 'text-blue' : 'text-green';
  const dot = status === 'error' ? 'bg-red' : status === 'active' ? 'bg-blue' : 'bg-green';
  const label = status === 'active' ? 'Running' : status === 'error' ? 'Error' : 'OK';
  return <span className={cn('inline-flex items-center gap-1.5 text-2xs', cls)}>
    <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />{label}</span>;
}

function FeedbackCell({ up, down }: { up: number; down: number }) {
  if (up + down === 0) return <span className="text-muted-foreground">—</span>;
  return <span className="inline-flex gap-2.5 text-xs">
    {up > 0 && <span className="inline-flex items-center gap-0.5 text-green"><ThumbsUp size={12} />{up}</span>}
    {down > 0 && <span className="inline-flex items-center gap-0.5 text-red"><ThumbsDown size={12} />{down}</span>}
  </span>;
}

function truncate(str: string, n: number): string { return str.length > n ? str.slice(0, n - 1) + '…' : str; }

function Overview({ data, agentName, canTokens, onTab }: { data: InsightsResponse; agentName: Map<string, string>; canTokens: boolean; onTab: (t: TabKey) => void }) {
  const r = data.rollup;
  if (!r) return <Muted>No activity in this window.</Muted>;
  const topTools = r.topTools ?? [];
  const tokDays = r.tokensByDay ?? [];
  const sessions = (data.sessions ?? []).slice(0, 6);
  const events = [...(data.events ?? [])].sort((a, b) => b.startMs - a.startMs).slice(0, 6);
  const sectionTitle = (label: string, t?: TabKey): React.ReactNode => (
    <div className="mb-3 flex items-center border-b border-border pb-2.5">
      <span className="text-sm font-semibold text-foreground">{label}</span>
      {t && <button onClick={() => onTab(t)} className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-1.5 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">View all <ArrowRight size={11} /></button>}
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      {/* KPI strip */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
        <Kpi label="Sessions" value={String(r.sessions ?? 0)} sub={`${r.turns} turns`} />
        <Kpi label="Errors" value={String(r.errorTurns ?? 0)} sub={r.turns ? `${Math.round(((r.errorTurns ?? 0) / r.turns) * 100)}% of turns` : '—'} />
        <Kpi label="Latency p50/p95" value={fmtMs(r.p50DurationMs)} sub={`p95 ${fmtMs(r.p95DurationMs)}`} />
        <Kpi label="Tool calls" value={String(r.toolCalls)} />
        <Kpi label="Sensitive" value={String(r.sensitiveEvents ?? 0)} sub="flagged events" />
        {canTokens && <Kpi label="Tokens" value={formatTokens(r.totalTokens)} sub={`${formatTokens(r.inputTokens)} in · ${formatTokens(r.outputTokens)} out`} />}
      </div>

      {/* Tokens per day (superadmin) */}
      {canTokens && tokDays.length > 1 && (
        <div className={cardCls}>
          {sectionTitle('Tokens per day')}
          <TokensChart data={tokDays} />
        </div>
      )}

      {/* Models + top tools + satisfaction */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
        {r.models.length > 0 && (
          <div className={cardCls}>
            {sectionTitle('By model')}
            <Bars max={Math.max(1, ...r.models.map(m => canTokens ? m.tokens : m.turns))}
              rows={r.models.map(m => ({ label: m.model, value: canTokens ? m.tokens : m.turns, sub: canTokens ? `${formatTokens(m.tokens)} tok` : `${m.turns} turns` }))} />
          </div>
        )}
        {topTools.length > 0 && (
          <div className={cardCls}>
            {sectionTitle('Top tools', 'tools')}
            <Bars max={Math.max(1, ...topTools.map(t => t.count))}
              rows={topTools.slice(0, 6).map(t => ({ label: t.name, value: t.count, sub: `${t.count}${t.errors ? ` · ${t.errors} err` : ''}` }))} />
          </div>
        )}
        <FeedbackCard r={r} scope={data.scope} />
      </div>

      {/* Recent sessions */}
      {sessions.length > 0 && (
        <div className={cardCls}>
          {sectionTitle('Recent sessions', 'sessions')}
          <Table<SessionRow> rows={sessions} empty="" rowHref={s => `/activity/${encodeURIComponent(s.sessionId)}`}
            cols={[
              { label: 'Request', render: s => <span title={s.summary ?? ''}>{truncate(s.summary || '(no summary)', 64)}</span> },
              { label: 'Agent', render: s => <Subtle>{truncate(s.agentIds.map(id => agentName.get(id) ?? id).join(', ') || '—', 24)}</Subtle> },
              { label: 'Turns', align: 'right', render: s => <Mono>{s.turns}</Mono> },
              { label: 'State', render: s => <StatePill status={s.status} /> },
              { label: 'Updated', align: 'right', render: s => <Subtle>{relativeTime(s.lastActivityAt)}</Subtle> },
            ]} />
        </div>
      )}

      {/* Recent sensitive activity */}
      {events.length > 0 && (
        <div className={cardCls}>
          {sectionTitle('Recent sensitive activity', 'sensitive')}
          <Table<SensEvent> rows={events} empty="" rowHref={e => `/activity/${encodeURIComponent(e.sessionId)}?span=${encodeURIComponent(e.spanId)}`}
            cols={[
              { label: 'Severity', render: e => e.severity ? <SevBadge s={e.severity} /> : <Subtle>—</Subtle> },
              { label: 'Type', render: e => <Mono>{e.reason ?? ''}</Mono> },
              { label: 'Where', render: e => <code className="text-xs font-semibold">{e.toolName ?? 'response'}</code> },
              { label: 'When', align: 'right', render: e => <Subtle>{relativeTime(e.startMs)}</Subtle> },
            ]} />
        </div>
      )}
    </div>
  );
}

function Tokens({ data, agentName, canTokens, isSuper }: { data: InsightsResponse; agentName: Map<string, string>; canTokens: boolean; isSuper: boolean }) {
  if (!canTokens) return <DeniedCard />;
  const byAgent = (data.byAgent ?? []).slice().sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
  const power = data.powerUsers ?? [];
  const r = data.rollup;
  return (
    <div className="flex flex-col gap-4">
      {r && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
          <MiniMetric label="Total tokens" value={formatTokens(r.totalTokens)} sub={`${formatTokens(r.inputTokens)} in · ${formatTokens(r.outputTokens)} out`} />
          <MiniMetric label="Cost" value={`$${r.costUsd.toFixed(2)}`} sub="estimated usage" />
          <MiniMetric label="Turns" value={String(r.turns)} sub={`${r.generations} generations`} />
          <MiniMetric label="Avg / turn" value={formatTokens(r.turns ? Math.round(r.totalTokens / r.turns) : 0)} sub="token density" />
        </div>
      )}
      {r?.tokensByDay && r.tokensByDay.length > 1 && (
        <div className={cardCls}>
          <PanelTitle>Daily token trend</PanelTitle>
          <TokensChart data={r.tokensByDay} />
        </div>
      )}
      <div className={cardCls}>
        <PanelTitle>Tokens by agent</PanelTitle>
        <Table<AgentTokens> rows={byAgent} empty="No token usage in this window."
          cols={[
            { label: 'Agent', render: a => <span className="font-medium">{agentName.get(a.agentId) ?? a.agentId}</span> },
            { label: 'Input', align: 'right', render: a => <Mono>{formatTokens(a.inputTokens)}</Mono> },
            { label: 'Output', align: 'right', render: a => <Mono>{formatTokens(a.outputTokens)}</Mono> },
            { label: 'Total', align: 'right', render: a => <Mono>{formatTokens(a.inputTokens + a.outputTokens)}</Mono> },
            { label: 'Turns', align: 'right', render: a => <Mono>{a.turnCount}</Mono> },
          ]} />
      </div>
      {/* Org-wide power-users leaderboard is superadmin-only (the route returns null otherwise). */}
      {isSuper && (
        <div className={cardCls}>
          <PanelTitle>Power users</PanelTitle>
          <Table<PowerUser> rows={power} empty="No users in this window."
            cols={[
              { label: '#', width: '32px', render: (_u: PowerUser) => <span /> },
              { label: 'User', render: u => <span>@{u.handle ?? 'unknown'}</span> },
              { label: 'Tasks', align: 'right', render: u => <Mono>{u.taskCount}</Mono> },
              { label: 'Turns', align: 'right', render: u => <Mono>{u.turnCount}</Mono> },
              { label: 'Tokens', align: 'right', render: u => <Mono>{formatTokens(u.totalTokens)}</Mono> },
            ]} />
        </div>
      )}
    </div>
  );
}

function Sensitive({ events, flows }: { events: SensEvent[]; flows: SensFlow[] }) {
  const severityCounts = events.reduce<Record<Severity, number>>((acc, e) => {
    if (e.severity) acc[e.severity] += 1;
    return acc;
  }, { critical: 0, high: 0, medium: 0, low: 0 });
  const aiCaught = events.filter(e => e.caughtByLlm).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
        <MiniMetric label="Flagged" value={String(events.length)} sub={`${flows.length} flow${flows.length === 1 ? '' : 's'}`} tone={events.length ? 'var(--amber)' : undefined} />
        <MiniMetric label="Critical/high" value={String(severityCounts.critical + severityCounts.high)} sub={`${severityCounts.critical} critical · ${severityCounts.high} high`} tone={severityCounts.critical + severityCounts.high ? 'var(--red)' : undefined} />
        <MiniMetric label="Medium/low" value={String(severityCounts.medium + severityCounts.low)} sub={`${severityCounts.medium} medium · ${severityCounts.low} low`} />
        <MiniMetric label="Smart detector" value={String(aiCaught)} sub="caught by AI" />
      </div>
      {flows.length > 0 && (
        <div className={cardCls}>
          <PanelTitle>Exfiltration flows</PanelTitle>
          <Table<SensFlow> rows={flows} empty="" rowHref={f => f.sessionId ? `/activity/${encodeURIComponent(f.sessionId)}?span=${encodeURIComponent(f.sinkSpanId)}` : undefined}
            cols={[
              { label: 'Severity', render: f => <SevBadge s={f.severity} /> },
              { label: 'Kind', render: f => <span className="font-medium">{f.label}</span> },
              { label: 'Source → Sink', render: f => <Mono>{f.sourceLabel} → {f.sinkLabel}</Mono> },
              { label: 'When', align: 'right', render: f => <Subtle>{relativeTime(f.startMs)}</Subtle> },
            ]} />
        </div>
      )}
      <div className={cardCls}>
        <PanelTitle>Sensitive access</PanelTitle>
        <Table<SensEvent> rows={[...events].sort((a, b) => b.startMs - a.startMs)} empty="Nothing flagged in this window."
          rowHref={e => `/activity/${encodeURIComponent(e.sessionId)}?span=${encodeURIComponent(e.spanId)}`}
          cols={[
            { label: 'Severity', render: e => e.severity ? <SevBadge s={e.severity} /> : <Subtle>—</Subtle> },
            { label: 'Type', render: e => <Mono>{e.reason ?? ''}</Mono> },
            { label: 'Where', render: e => <code className="text-xs font-semibold">{e.toolName ?? 'response'}</code> },
            { label: 'Source', render: e => e.caughtByLlm
              ? <span title="Caught by the Smart (LLM) detector" className="text-2xs font-semibold text-amber">AI</span>
              : <Subtle>regex</Subtle> },
            { label: 'Agent', render: e => <Subtle>{e.agentName ?? ''}</Subtle> },
            { label: 'When', align: 'right', render: e => <Subtle>{relativeTime(e.startMs)}</Subtle> },
          ]} />
      </div>
    </div>
  );
}

function Tools({ tools }: { tools: ToolStat[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const sorted = [...tools].sort((a, b) => b.calls - a.calls);
  const calls = tools.reduce((sum, t) => sum + t.calls, 0);
  const errors = tools.reduce((sum, t) => sum + t.errors, 0);
  const erroringTools = tools.filter(t => t.errors > 0).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
        <MiniMetric label="Tool calls" value={String(calls)} sub={`${tools.length} tools`} />
        <MiniMetric label="Errors" value={String(errors)} sub={`${erroringTools} tools affected`} tone={errors ? 'var(--red)' : undefined} />
        <MiniMetric label="Error rate" value={`${calls ? Math.round((errors / calls) * 100) : 0}%`} sub="of calls" tone={errors ? 'var(--red)' : undefined} />
        <MiniMetric label="Top tool" value={sorted[0]?.name ? truncate(sorted[0].name, 18) : '—'} sub={sorted[0] ? `${sorted[0].calls} calls` : 'No calls'} />
      </div>
      <div className={cardCls}>
        <PanelTitle>Tools</PanelTitle>
        {sorted.length === 0 ? <div className="px-3 py-4 text-center text-xs text-muted-foreground">No tool calls in this window.</div> : (
          <div className="-mx-4 -mb-3.5 border-t border-border">
            {sorted.map((t, i) => {
            const hasErr = t.errors > 0 && (t.errorGroups?.length ?? 0) > 0;
            const expanded = open === t.name;
            const last = i === sorted.length - 1;
            return (
              <div key={t.name} className={cn(last && !expanded ? 'border-b-0' : 'border-b border-border')}>
                <div
                  onClick={hasErr ? () => setOpen(expanded ? null : t.name) : undefined}
                  className={cn('flex items-center gap-2.5 px-4 py-2.5', hasErr ? 'cursor-pointer' : 'cursor-default')}>
                  {hasErr
                    ? (expanded ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />)
                    : <span className="w-[13px] shrink-0" />}
                  <code className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold">{t.name}</code>
                  <span className="w-[70px] text-right font-mono text-xs tabular-nums text-muted-foreground">{t.calls} calls</span>
                  <span className={cn('w-[90px] text-right font-mono text-xs tabular-nums', t.errors ? 'text-red' : 'text-muted-foreground')}>
                    {t.errors ? `${t.errors} err · ${Math.round((t.errors / t.calls) * 100)}%` : 'no errors'}
                  </span>
                </div>
                {expanded && (
                  <div className="flex flex-col gap-2 pb-3 pl-[39px] pr-4 pt-0.5">
                    {(t.errorGroups ?? []).map((g, gi) => (
                      <div key={gi} className="flex items-start gap-2.5">
                        <span title={`${g.count} occurrences`} className="shrink-0 rounded-md bg-destructive/10 px-1.5 py-0.5 text-2xs font-bold tabular-nums text-red">{g.count}×</span>
                        <span className="flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">{g.message}</span>
                        <span className="inline-flex shrink-0 items-center gap-2">
                          {g.sessions > 1 && <span className="whitespace-nowrap text-2xs text-muted-foreground">{g.sessions} sessions</span>}
                          {g.sampleSessionId && (
                            <Link href={`/activity/${encodeURIComponent(g.sampleSessionId)}`} onClick={e => e.stopPropagation()}
                              className="inline-flex items-center gap-1 whitespace-nowrap text-2xs text-primary no-underline">
                              {g.sessions > 1 ? 'Latest' : 'View session'} <ArrowRight size={11} />
                            </Link>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, color, children }: { active: boolean; onClick: () => void; color?: string; children: React.ReactNode }): React.JSX.Element {
  // When a `color` is supplied (the sensitive chip), the active border/text/bg are
  // tinted with that color — kept inline since it's a dynamic per-chip value.
  if (color) {
    return (
      <button onClick={onClick} className="rounded-md border px-2.5 py-1 text-2xs font-medium" style={{
        borderColor: active ? color : 'var(--border)',
        background: active ? `${color}14` : 'var(--surface)',
        color: active ? color : 'var(--muted)',
      }}>{children}</button>
    );
  }
  return (
    <button onClick={onClick} className={cn(
      'rounded-md border px-2.5 py-1 text-2xs font-medium transition-colors',
      active ? 'border-primary bg-card text-foreground shadow-sm' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
    )}>{children}</button>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-3 flex items-center border-b border-border pb-2.5">
      <div className="text-sm font-semibold text-foreground">{children}</div>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) { return <span className="font-mono text-muted-foreground">{children}</span>; }
function Subtle({ children }: { children: React.ReactNode }) { return <span className="text-muted-foreground">{children}</span>; }

/** Satisfaction card (rendered on the Overview): big %, a green/red split bar,
 *  up/down counts, and a contextual note. Returns null when there are no ratings. */
function FeedbackCard({ r, scope }: { r: Rollup | null; scope: string }): React.JSX.Element | null {
  const up = r?.feedbackUp ?? 0, down = r?.feedbackDown ?? 0;
  const total = up + down;
  if (total === 0) return null;
  const pct = Math.round((up / total) * 100);
  const toneCls = pct >= 80 ? 'text-green' : pct >= 50 ? 'text-amber' : 'text-red';
  const label = pct >= 80 ? 'Great' : pct >= 50 ? 'Mixed' : 'Poor';
  return (
    <div className={cardCls}>
      <div className="mb-2.5 flex items-center">
        <span className="text-sm font-semibold">Satisfaction</span>
        <span className="ml-auto text-2xs text-muted-foreground">{total} rating{total === 1 ? '' : 's'}</span>
      </div>
      <div className="flex items-baseline gap-2.5">
        <span className={cn('text-3xl font-bold leading-none tracking-[-0.02em]', toneCls)}>{pct}%</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      {/* green / red split bar */}
      <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="bg-green" style={{ width: `${pct}%` }} />
        <div className="bg-red opacity-55" style={{ width: `${100 - pct}%` }} />
      </div>
      <div className="mt-2.5 flex items-center gap-3.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1"><ThumbsUp size={13} className="text-green" /> {up}</span>
        <span className="inline-flex items-center gap-1"><ThumbsDown size={13} className="text-red" /> {down}</span>
        {scope === 'all' && <span className="ml-auto text-2xs text-muted-foreground">Pick an agent for individual ratings</span>}
      </div>
    </div>
  );
}

function whoLabel(t: TraceTurn): string {
  if (t.initiatorKind === 'agent' && t.delegatedByAgentName) return `via @${t.delegatedByAgentName}`;
  return t.initiatorHandle ? `@${t.initiatorHandle}` : '—';
}

/** Compact icon chips summarizing the turn's reasoning→tools→answer step sequence.
 *  Takes pre-built nodes (TurnRows already computes them) to avoid re-running buildNodes. */
function StepChips({ nodes }: { nodes: NodeData[] }): React.JSX.Element {
  const shown = nodes.slice(0, 6);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((n, i) => {
        const Icon = n.kind === 'error' ? AlertTriangle : n.kind === 'final' ? CheckCircle2 : n.kind === 'tool' ? Wrench : Brain;
        const colorCls = n.kind === 'error' ? 'text-red' : n.kind === 'final' ? 'text-green' : 'text-muted-foreground';
        return (
          <span key={i} title={n.title} className={cn('inline-flex items-center gap-0.5 whitespace-nowrap rounded-md bg-muted px-1.5 py-px text-2xs', colorCls)}>
            <Icon size={11} />{n.kind === 'tool' ? truncate(n.title, 14) : null}
          </span>
        );
      })}
      {nodes.length > 6 && <span className="text-2xs text-muted-foreground">+{nodes.length - 6}</span>}
      {nodes.length === 0 && <Subtle>—</Subtle>}
    </span>
  );
}

function TurnStatus({ status }: { status: 'in_progress' | 'done' | 'error' }): React.JSX.Element {
  const map = {
    in_progress: { label: 'Running', cls: 'bg-blue/10 text-blue', icon: <Loader2 size={10} className="animate-spin" /> },
    done: { label: 'Done', cls: 'bg-green/10 text-green', icon: <CheckCircle2 size={10} /> },
    error: { label: 'Error', cls: 'bg-destructive/10 text-red', icon: <AlertTriangle size={10} /> },
  }[status];
  return <span className={cn('inline-flex items-center gap-1 rounded-[10px] px-1.5 py-0.5 text-2xs font-semibold', map.cls)}>{map.icon}{map.label}</span>;
}

/** One turn rendered to mirror the Session table's columns (Request · Initiated by ·
 * Agent · Steps · [Tokens] · State · Feedback · Updated), plus an inline-expanded
 * detail row with the full reasoning→tools→answer chain (admin-revealable). Used both
 * in the flat Turn view and nested under a session in the Session view. */
function TurnRows({ turn, request, sessionId, cols, expanded, onToggle, canTokens, indent }: {
  turn: TraceTurn; request: string; sessionId: string; cols: number;
  expanded: boolean; onToggle: () => void; canTokens: boolean; indent?: boolean;
}): React.JSX.Element {
  const nodes = useMemo(() => buildNodes(turn), [turn]);
  const maxMs = Math.max(1, ...nodes.map(n => n.durationMs ?? 0));
  const tdCls = 'whitespace-nowrap border-b border-border px-3 py-2.5 align-middle text-sm text-foreground';
  const firstSpan = nodes[0]?.key && !nodes[0].key.startsWith('__') ? nodes[0].key : '';
  const up = turn.feedback.filter(f => f.sentiment === 'up').length;
  const down = turn.feedback.filter(f => f.sentiment === 'down').length;
  return (
    <>
      <tr onClick={onToggle} className={cn('trace-node cursor-pointer', indent && 'bg-muted')}>
        <td className={cn(tdCls, 'w-[22px]', indent ? 'pl-10' : 'pl-4')} style={indent ? { boxShadow: 'inset 4px 0 0 var(--border-2)' } : undefined}>{expanded ? <ChevronDown size={13} className="text-muted-foreground" /> : <ChevronRight size={13} className="text-muted-foreground" />}</td>
        <td className={cn(tdCls, 'whitespace-normal')}>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            {turn.sensitive && <ShieldAlert size={12} className="shrink-0 text-amber" />}
            <span title={request}>{truncate(request, 56)}</span>
          </span>
        </td>
        <td className={tdCls}><Subtle>{whoLabel(turn)}</Subtle></td>
        <td className={tdCls}><AgentCell names={turn.agentName ? [turn.agentName] : []} /></td>
        <td className={tdCls}><StepChips nodes={nodes} /></td>
        {canTokens && <td className={cn(tdCls, 'text-right')}><Mono>{formatTokens(turn.inputTokens + turn.outputTokens)}</Mono></td>}
        <td className={tdCls}><TurnStatus status={turn.status} /></td>
        <td className={tdCls}><FeedbackCell up={up} down={down} /></td>
        <td className={cn(tdCls, 'pr-4 text-right')} title={turn.startedAt}><Subtle>{relativeTime(turn.startedAt)}</Subtle></td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={cols} className="border-b border-border bg-muted p-0" style={indent ? { boxShadow: 'inset 4px 0 0 var(--border-2)' } : undefined}>
            <div className="flex flex-col gap-1.5 pb-3 pl-14 pr-4 pt-1.5">
              {/* RevealCtx is provided by the enclosing view (admin → revealable). */}
              {nodes.map((n, ni) => <NodeRow key={n.key} node={n} maxMs={maxMs} isLast={ni === nodes.length - 1} />)}
              <a href={`/activity/${encodeURIComponent(sessionId)}${firstSpan ? `?span=${encodeURIComponent(firstSpan)}` : ''}`}
                className="inline-flex items-center gap-1 self-start text-xs text-primary no-underline">
                Open full session <ArrowRight size={12} />
              </a>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Sessions({ sessions, cursor, fetchMore, agentName, canTokens, canReveal }: { sessions: SessionRow[]; cursor: string | null; fetchMore: (cursor: string) => Promise<SessionsPage>; agentName: Map<string, string>; canTokens: boolean; canReveal: boolean }) {
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | 'done' | 'error' | 'active'>('all');
  const [sensOnly, setSensOnly] = useState(false);
  const [initiator, setInitiator] = useState('');
  // Accumulated rows + the cursor for the next page. Reset whenever the first page
  // changes (a filter/window re-fetch hands down a fresh `sessions` array).
  const [rows, setRows] = useState<SessionRow[]>(sessions);
  const [nextCursor, setNextCursor] = useState<string | null>(cursor);
  const [loadingMore, setLoadingMore] = useState(false);
  // Expansion state: which sessions are open, their fetched turns, and which turns
  // are open to their reasoning chain.
  const [openSessions, setOpenSessions] = useState<Set<string>>(new Set());
  const [openTurns, setOpenTurns] = useState<Set<string>>(new Set());
  const [turnsBySession, setTurnsBySession] = useState<Record<string, TraceTurn[]>>({});
  const [loadingSession, setLoadingSession] = useState<Set<string>>(new Set());
  const [errorSession, setErrorSession] = useState<Set<string>>(new Set());
  // Synchronous in-flight guard (state updates are async) so a fast double-click
  // can't fire two fetches for the same session.
  const inFlight = useRef<Set<string>>(new Set());
  // Bumped whenever the underlying page resets (filter/window change); an in-flight
  // session-turn fetch from a prior page checks this and drops its result so it can't
  // write stale turns into the new page.
  const loadGen = useRef(0);
  useEffect(() => {
    setRows(sessions); setNextCursor(cursor);
    setOpenSessions(new Set()); setOpenTurns(new Set()); setTurnsBySession({});
    setErrorSession(new Set()); setLoadingSession(new Set());
    inFlight.current = new Set();
    loadGen.current++;
  }, [sessions, cursor]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchMore(nextCursor);
      setRows(prev => {
        const seen = new Set(prev.map(s => s.sessionId));
        return [...prev, ...page.sessions.filter(s => !seen.has(s.sessionId))];
      });
      setNextCursor(page.nextCursor);
    } catch { /* leave the cursor so the user can retry */ } finally { setLoadingMore(false); }
  }, [nextCursor, loadingMore, fetchMore]);

  // Lazily fetch a session's turns (the trace endpoint redacts sensitive values
  // server-side for non-admins, same as the trace page). On failure we record an
  // error (NOT an empty list) so the row can offer a retry instead of looking empty.
  const loadSessionTurns = useCallback(async (id: string) => {
    if (turnsBySession[id] !== undefined || inFlight.current.has(id)) return;
    const myGen = loadGen.current;
    inFlight.current.add(id);
    setLoadingSession(s => new Set(s).add(id));
    setErrorSession(s => { const n = new Set(s); n.delete(id); return n; });
    try {
      const r = await fetch(`/api/activity/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (loadGen.current !== myGen) return; // page reset mid-fetch → drop stale result
      setTurnsBySession(prev => ({ ...prev, [id]: (j.turns ?? []) as TraceTurn[] }));
    } catch {
      if (loadGen.current === myGen) setErrorSession(s => new Set(s).add(id)); // retryable
    } finally {
      inFlight.current.delete(id);
      if (loadGen.current === myGen) setLoadingSession(s => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [turnsBySession]);

  const toggleSession = useCallback((id: string) => {
    const isOpen = openSessions.has(id);
    setOpenSessions(s => { const n = new Set(s); if (isOpen) n.delete(id); else n.add(id); return n; });
    if (!isOpen) loadSessionTurns(id);
  }, [openSessions, loadSessionTurns]);
  const toggleTurn = (aid: string) => setOpenTurns(s => { const n = new Set(s); if (n.has(aid)) n.delete(aid); else n.add(aid); return n; });

  const initiators = useMemo(() =>
    [...new Set(rows.map(s => s.initiatorHandle).filter((h): h is string => !!h))].sort((a, b) => a.localeCompare(b)),
    [rows]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(s => {
      if (stateFilter !== 'all' && s.status !== stateFilter) return false;
      if (sensOnly && !s.sensitive) return false;
      if (initiator && s.initiatorHandle !== initiator) return false;
      if (needle && !(
        (s.summary ?? '').toLowerCase().includes(needle) ||
        (s.initiatorHandle ?? '').toLowerCase().includes(needle) ||
        s.agentIds.some(id => (agentName.get(id) ?? '').toLowerCase().includes(needle)))) return false;
      return true;
    });
  }, [rows, q, stateFilter, sensOnly, initiator, agentName]);
  const errCount = rows.filter(s => s.status === 'error').length;
  const sensCount = rows.filter(s => s.sensitive).length;
  const activeCount = rows.filter(s => s.status === 'active').length;
  const doneCount = rows.filter(s => s.status === 'done').length;
  const turnCount = rows.reduce((sum, s) => sum + s.turns, 0);
  const cols = canTokens ? 9 : 8;
  const tdCls = 'whitespace-nowrap border-b border-border px-3 py-2.5 align-middle text-sm text-foreground';

  return (
    <RevealCtx.Provider value={canReveal}>
     <NodeDetailProvider>
      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
        <MiniMetric label="Sessions" value={String(rows.length)} sub={`${turnCount} turns`} />
        <MiniMetric label="Done" value={String(doneCount)} sub="completed sessions" tone="var(--green)" />
        <MiniMetric label="Running" value={String(activeCount)} sub="currently active" tone={activeCount ? 'var(--blue)' : undefined} />
        <MiniMetric label="Needs review" value={String(errCount + sensCount)} sub={`${errCount} errors · ${sensCount} sensitive`} tone={errCount + sensCount ? 'var(--red)' : undefined} />
      </div>
      <div className={cardCls}>
        <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <div className="mr-1 text-sm font-semibold text-foreground">Sessions</div>
          <div className="inline-flex flex-wrap gap-1">
            {([['all', 'All'], ['done', 'OK'], ['error', `Errors${errCount ? ` ${errCount}` : ''}`], ['active', 'Running']] as const).map(([key, label]) => (
              <FilterChip key={key} active={stateFilter === key} onClick={() => setStateFilter(key)}>{label}</FilterChip>
            ))}
            {sensCount > 0 && <FilterChip active={sensOnly} onClick={() => setSensOnly(v => !v)} color="#b45309">Sensitive {sensCount}</FilterChip>}
          </div>
          {initiators.length > 0 && (
            <select value={initiator} onChange={e => setInitiator(e.target.value)} title="Filter by who initiated"
              className="h-8 cursor-pointer rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground shadow-sm">
              <option value="">All initiators</option>
              {initiators.map(h => <option key={h} value={h}>@{h}</option>)}
            </select>
          )}
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search sessions…"
            className="ml-auto h-8 w-[220px] rounded-md border border-border bg-card px-2.5 text-xs text-foreground shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/80 focus:border-ring focus:ring-2 focus:ring-ring/20" />
          <span className="rounded-md border border-border bg-muted px-2 py-1 text-2xs font-medium text-muted-foreground">{filtered.length}</span>
        </div>
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">No sessions in this window.</div>
        ) : (
          <div className="-mx-4 -mb-3.5 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr>
                <th className={cn(thCls, 'w-[22px] pl-4')} />
                <th className={thCls}>Request</th><th className={thCls}>Initiated by</th><th className={thCls}>Agent</th>
                <th className={thCls}>Steps</th>
                {canTokens && <th className={cn(thCls, 'text-right')}>Tokens</th>}
                <th className={thCls}>State</th><th className={thCls}>Feedback</th>
                <th className={cn(thCls, 'pr-4 text-right')}>When</th>
              </tr></thead>
              <tbody>
                {filtered.map(s => {
                  const open = openSessions.has(s.sessionId);
                  const turns = turnsBySession[s.sessionId];
                  // When open, the session reads as a dropdown header: tinted, bolder,
                  // and border-less at the bottom so it visually connects to its turns.
                  const rowTdCls = cn(tdCls, open && 'border-b-0 bg-muted/70');
                  const nestNoteCls = 'border-b border-border bg-muted/70 py-2 pl-[46px] pr-4 text-xs text-muted-foreground';
                  return (
                    <React.Fragment key={s.sessionId}>
                      <tr onClick={() => toggleSession(s.sessionId)} className="trace-node cursor-pointer">
                        <td className={cn(rowTdCls, 'w-[22px] pl-4')}>{open ? <ChevronDown size={13} className="text-primary" /> : <ChevronRight size={13} className="text-muted-foreground" />}</td>
                        <td className={cn(rowTdCls, 'whitespace-normal')}>
                          <span className={cn('inline-flex items-center gap-1.5', open ? 'font-semibold' : 'font-medium')}>
                            {s.sensitive && <ShieldAlert size={12} className="shrink-0 text-amber" />}
                            <span title={s.summary ?? ''}>{truncate(s.summary || '(no summary)', 56)}</span>
                            <a href={`/activity/${encodeURIComponent(s.sessionId)}`} onClick={e => e.stopPropagation()} title="Open full session"
                              className="inline-flex shrink-0 text-muted-foreground"><ExternalLink size={12} /></a>
                          </span>
                        </td>
                        <td className={rowTdCls}><Subtle>{s.initiatorHandle ? `@${s.initiatorHandle}` : '—'}</Subtle></td>
                        <td className={rowTdCls}><AgentCell names={s.agentIds.map(id => agentName.get(id) ?? id)} /></td>
                        <td className={rowTdCls}><Subtle>{s.turns} turn{s.turns === 1 ? '' : 's'}</Subtle></td>
                        {canTokens && <td className={cn(rowTdCls, 'text-right')}><Mono>{formatTokens(s.inputTokens + s.outputTokens)}</Mono></td>}
                        <td className={rowTdCls}><StatePill status={s.status} /></td>
                        <td className={rowTdCls}><FeedbackCell up={s.feedbackUp} down={s.feedbackDown} /></td>
                        <td className={cn(rowTdCls, 'pr-4 text-right')} title={s.startedAt}><Subtle>{relativeTime(s.startedAt)}</Subtle></td>
                      </tr>
                      {open && (errorSession.has(s.sessionId) ? (
                        <tr><td colSpan={cols} className={nestNoteCls} style={{ boxShadow: 'inset 4px 0 0 var(--border-2)' }}>
                          Couldn’t load turns.{' '}
                          <button onClick={() => loadSessionTurns(s.sessionId)} className="cursor-pointer border-none bg-transparent p-0 font-[inherit] text-primary">Retry</button>
                          {' · '}
                          <a href={`/activity/${encodeURIComponent(s.sessionId)}`} className="text-primary">Open full session</a>
                        </td></tr>
                      ) : loadingSession.has(s.sessionId) || turns === undefined ? (
                        <tr><td colSpan={cols} className={nestNoteCls} style={{ boxShadow: 'inset 4px 0 0 var(--border-2)' }}>Loading turns…</td></tr>
                      ) : turns.length === 0 ? (
                        <tr><td colSpan={cols} className={nestNoteCls} style={{ boxShadow: 'inset 4px 0 0 var(--border-2)' }}>
                          No turns.{' '}
                          <a href={`/activity/${encodeURIComponent(s.sessionId)}`} className="text-primary">Open full session</a>
                        </td></tr>
                      ) : turns.map(t => (
                        <TurnRows key={t.activityId} turn={t} request={t.messagePreview || '(turn)'} sessionId={s.sessionId}
                          cols={cols} canTokens={canTokens} indent expanded={openTurns.has(t.activityId)} onToggle={() => toggleTurn(t.activityId)} />
                      )))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor && (
          <div className="flex justify-center pt-3">
            <button onClick={loadMore} disabled={loadingMore} className={cn(
              'rounded-md border border-border bg-card px-4 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted',
              loadingMore ? 'cursor-default opacity-60' : 'cursor-pointer',
            )}>{loadingMore ? 'Loading…' : 'Load more'}</button>
          </div>
        )}
      </div>
     </NodeDetailProvider>
    </RevealCtx.Provider>
  );
}

function DeniedCard(): React.JSX.Element {
  return (
    <div className={cn(cardCls, 'flex items-center gap-3')}>
      <Lock size={18} className="text-muted-foreground" />
      <div>
        <div className="text-sm font-semibold text-foreground">Tokens & cost are superadmin-only</div>
        <div className="text-xs text-muted-foreground">Billing-adjacent data. Ask a superadmin if you need access.</div>
      </div>
    </div>
  );
}
