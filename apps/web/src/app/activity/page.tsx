'use client';

/**
 * @fileoverview Activity Dashboard — live task-centric view across all agents.
 *
 * Three-column kanban: Active / Recent / Errored. Each card is one task
 * (Slack thread). Polls `/api/activity` every 4s for near-live updates;
 * SSE can come later as an optimization.
 *
 * @module web/app/activity
 */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Activity as ActivityIcon, Users, AlertTriangle, CheckCircle2, CircleDashed, Layers, Wrench, Coins, Clock, ThumbsUp, ThumbsDown, ShieldAlert, ArrowRight } from 'lucide-react';
import type { AgentRollup } from '@slackhive/shared';
import { TabSwitcher } from './_components/TabSwitcher';
import { formatTokens } from './_components/formatTokens';
import { FilterRow, parseWindowKey, timeParams, type WindowKey } from './_components/FilterRow';

interface Task {
  id: string;
  platform: string;
  channelId: string;
  threadTs: string;
  initiatorUserId?: string;
  initiatorHandle?: string;
  initialAgentId?: string;
  summary?: string;
  startedAt: string;
  lastActivityAt: string;
  activityCount: number;
  feedbackUp?: number;
  feedbackDown?: number;
}

interface TaskListResult {
  tasks: Task[];
  nextCursor: string | null;
}

interface AgentLite {
  id: string;
  slug: string;
  name: string;
}

type Column = 'active' | 'recent' | 'errored';

const COLUMNS: { key: Column; label: string; icon: React.ReactNode; accent: string }[] = [
  { key: 'active',  label: 'Active',  icon: <CircleDashed size={13} />,   accent: '#2563eb' },
  { key: 'recent',  label: 'Recent',  icon: <CheckCircle2 size={13} />,   accent: '#059669' },
  { key: 'errored', label: 'Errors',  icon: <AlertTriangle size={13} />,  accent: '#dc2626' },
];

/** Relative time string ("4m", "2h", "3d") for dense card UIs. */
function relativeTime(isoLike: string): string {
  const ts = Date.parse(isoLike.replace(' ', 'T') + 'Z');
  if (Number.isNaN(ts)) return '';
  const delta = Math.max(0, Date.now() - ts);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/** Initials from an agent/user name, max 2 chars. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic pastel color per agent for avatar stacks. */
function agentColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export default function ActivityPage(): React.JSX.Element {
  // useSearchParams forces dynamic rendering — wrap in Suspense so the
  // page's static shell can still be emitted during build.
  return (
    <Suspense fallback={null}>
      <ActivityPageBody />
    </Suspense>
  );
}

interface StatsResponse {
  counts: { active: number; recent: number; errored: number };
  inProgressByAgent: Record<string, number>;
  agentRollup?: AgentRollup | null;
}

function ActivityPageBody(): React.JSX.Element {
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [lists, setLists] = useState<Record<Column, TaskListResult>>({
    active:  { tasks: [], nextCursor: null },
    recent:  { tasks: [], nextCursor: null },
    errored: { tasks: [], nextCursor: null },
  });
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string>(searchParams?.get('agent') ?? '');
  const [from, setFrom] = useState<string>(searchParams?.get('from') ?? '');
  const [to, setTo] = useState<string>(searchParams?.get('to') ?? '');
  const [windowKey, setWindowKey] = useState<WindowKey>(
    parseWindowKey(searchParams?.get('window') ?? (searchParams?.get('from') && searchParams?.get('to') ? 'custom' : null)),
  );
  const timeQs = () => timeParams(windowKey, from, to);
  // Per-activity agent participation map, populated lazily from task detail.
  const [agentsByTask, setAgentsByTask] = useState<Record<string, string[]>>({});
  // Ref mirror of `agentsByTask` so `load` can read the latest value without
  // taking it as a dependency — otherwise every hydrated task rebuilds `load`,
  // re-fires the mount effect, tears down & recreates the 4s polling interval,
  // and kicks off an extra fetch. Keep the state for rendering, the ref for
  // checks inside `load`.
  const agentsByTaskRef = useRef(agentsByTask);
  useEffect(() => { agentsByTaskRef.current = agentsByTask; }, [agentsByTask]);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then((rows: AgentLite[]) => setAgents(rows)).catch(() => {});
  }, []);

  const agentById = useMemo(() => {
    const m = new Map<string, AgentLite>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const fetchColumn = useCallback(async (col: Column): Promise<TaskListResult> => {
    const params = new URLSearchParams({ column: col, ...timeQs() });
    if (agentFilter) params.set('agent', agentFilter);
    const r = await fetch(`/api/activity?${params.toString()}`);
    if (!r.ok) return { tasks: [], nextCursor: null };
    return r.json();
  }, [agentFilter, windowKey, from, to]);

  const fetchStats = useCallback(async (): Promise<StatsResponse | null> => {
    const params = new URLSearchParams({ ...timeQs() });
    if (agentFilter) params.set('agent', agentFilter);
    const r = await fetch(`/api/activity/stats?${params.toString()}`);
    if (!r.ok) return null;
    return r.json();
  }, [agentFilter, windowKey, from, to]);

  const load = useCallback(async () => {
    const [active, recent, errored, s] = await Promise.all([
      fetchColumn('active'),
      fetchColumn('recent'),
      fetchColumn('errored'),
      fetchStats(),
    ]);
    setLists({ active, recent, errored });
    setStats(s);
    setLoaded(true);

    // Hydrate per-task agent lists for avatar stacks — only for visible tasks.
    const visible = [...active.tasks, ...recent.tasks, ...errored.tasks];
    const cache = agentsByTaskRef.current;
    const needDetail = visible.filter(t => !cache[t.id] && t.activityCount > 1).slice(0, 12);
    if (needDetail.length > 0) {
      const detailed = await Promise.all(needDetail.map(async t => {
        const r = await fetch(`/api/activity/${encodeURIComponent(t.id)}`);
        if (!r.ok) return [t.id, [] as string[]] as const;
        const body = await r.json();
        const ids = Array.from(new Set((body.turns ?? []).map((t: { agentId: string }) => t.agentId))) as string[];
        return [t.id, ids] as const;
      }));
      setAgentsByTask(prev => {
        const next = { ...prev };
        for (const [id, ids] of detailed) next[id] = ids;
        return next;
      });
    }
  }, [fetchColumn, fetchStats]);

  useEffect(() => {
    load();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(load, 4000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const loadMore = async (col: Column) => {
    const cursor = lists[col].nextCursor;
    if (!cursor) return;
    const params = new URLSearchParams({ column: col, ...timeQs(), cursor });
    if (agentFilter) params.set('agent', agentFilter);
    const r = await fetch(`/api/activity?${params.toString()}`);
    if (!r.ok) return;
    const more: TaskListResult = await r.json();
    setLists(prev => ({
      ...prev,
      [col]: { tasks: [...prev[col].tasks, ...more.tasks], nextCursor: more.nextCursor },
    }));
  };

  const activeCount = lists.active.tasks.length;

  return (
    <div className="fade-up" style={{ padding: '36px 40px', maxWidth: 1600, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <ActivityIcon size={20} /> Activity
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Every task your agents worked on, live.
          </p>
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 12, fontWeight: 500, color: activeCount > 0 ? '#2563eb' : 'var(--muted)',
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: activeCount > 0 ? '#2563eb' : 'var(--border-2)',
            boxShadow: activeCount > 0 ? '0 0 0 3px rgba(37,99,235,0.15)' : 'none',
          }} />
          {activeCount > 0 ? `${activeCount} active` : 'Idle'}
        </div>
      </div>

      <TabSwitcher />

      <StatsStrip stats={stats} agentCount={agentCountForSubtext(stats, agentFilter)} />

      <FilterRow
        agents={agents}
        agentFilter={agentFilter}
        windowKey={windowKey}
        onAgentChange={setAgentFilter}
        onWindowChange={setWindowKey}
        from={from}
        to={to}
        onRangeChange={(f, t) => { setFrom(f); setTo(t); }}
      />

      {agentFilter && stats?.agentRollup && (
        <AgentPanel
          name={agentById.get(agentFilter)?.name ?? 'Agent'}
          rollup={stats.agentRollup}
          agentId={agentFilter}
          windowKey={windowKey}
        />
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 14,
      }}>
        {COLUMNS.map(col => (
          <ColumnView
            key={col.key}
            column={col}
            tasks={lists[col.key].tasks}
            hasMore={!!lists[col.key].nextCursor}
            loaded={loaded}
            agentById={agentById}
            agentsByTask={agentsByTask}
            onLoadMore={() => loadMore(col.key)}
          />
        ))}
      </div>
    </div>
  );
}

function ColumnView(props: {
  column: { key: Column; label: string; icon: React.ReactNode; accent: string };
  tasks: Task[];
  hasMore: boolean;
  loaded: boolean;
  agentById: Map<string, AgentLite>;
  agentsByTask: Record<string, string[]>;
  onLoadMore: () => void;
}): React.JSX.Element {
  const { column, tasks, hasMore, loaded, agentById, agentsByTask, onLoadMore } = props;

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '12px 14px', borderBottom: '1px solid var(--border)',
        color: column.accent, fontWeight: 600, fontSize: 13,
      }}>
        {column.icon}
        <span style={{ color: 'var(--text)' }}>{column.label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>
          {tasks.length}{hasMore ? '+' : ''}
        </span>
      </div>
      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120 }}>
        {!loaded && <div style={{ padding: 20, color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>Loading…</div>}
        {loaded && tasks.length === 0 && (
          <div style={{
            padding: 24, color: 'var(--subtle)', fontSize: 12, textAlign: 'center',
            border: '1px dashed var(--border)', borderRadius: 8,
          }}>
            No tasks
          </div>
        )}
        {tasks.map(t => (
          <TaskCard
            key={t.id}
            task={t}
            agentById={agentById}
            agentIds={agentsByTask[t.id] ?? (t.initialAgentId ? [t.initialAgentId] : [])}
          />
        ))}
        {hasMore && (
          <button
            onClick={onLoadMore}
            style={{
              marginTop: 4, padding: '8px 10px', fontSize: 12, fontWeight: 500,
              color: 'var(--muted)', background: 'transparent',
              border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

function TaskCard(props: {
  task: Task;
  agentById: Map<string, AgentLite>;
  agentIds: string[];
}): React.JSX.Element {
  const { task, agentById, agentIds } = props;
  const initiatorLabel = task.initiatorHandle || task.initiatorUserId || 'unknown';

  return (
    <Link
      href={`/activity/${encodeURIComponent(task.id)}`}
      style={{
        textDecoration: 'none', color: 'inherit',
        display: 'block', padding: '10px 12px',
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        borderRadius: 8, boxShadow: 'var(--shadow-sm)',
        transition: 'box-shadow 0.12s, transform 0.12s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-hover)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'; }}
    >
      <div style={{
        fontSize: 13, fontWeight: 500, color: 'var(--text)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {task.summary || '(empty message)'}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginTop: 6,
        fontSize: 11, color: 'var(--muted)',
      }}>
        <span style={{ fontWeight: 500 }}>@{initiatorLabel}</span>
        <span>·</span>
        <span>{relativeTime(task.lastActivityAt)}</span>
        <span>·</span>
        <span style={{ color: 'var(--subtle)' }}>{task.activityCount} turn{task.activityCount === 1 ? '' : 's'}</span>
        {!!(task.feedbackUp || task.feedbackDown) && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            {!!task.feedbackUp && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#16a34a' }}><ThumbsUp size={11} />{task.feedbackUp}</span>}
            {!!task.feedbackDown && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#dc2626' }}><ThumbsDown size={11} />{task.feedbackDown}</span>}
          </span>
        )}
      </div>
      {agentIds.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
          <AvatarStack agentIds={agentIds} agentById={agentById} />
          <Users size={11} style={{ color: 'var(--subtle)', marginLeft: 4 }} />
        </div>
      )}
    </Link>
  );
}

function AvatarStack(props: {
  agentIds: string[];
  agentById: Map<string, AgentLite>;
}): React.JSX.Element {
  const { agentIds, agentById } = props;
  const visible = agentIds.slice(0, 3);
  const extra = agentIds.length - visible.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {visible.map((id, i) => {
        const a = agentById.get(id);
        const label = a?.name ?? id.slice(0, 6);
        return (
          <div
            key={id}
            title={label}
            style={{
              width: 20, height: 20, borderRadius: '50%',
              background: agentColor(id), color: 'white',
              fontSize: 9, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginLeft: i === 0 ? 0 : -6,
              border: '2px solid var(--surface-2)',
            }}
          >
            {initials(label)}
          </div>
        );
      })}
      {extra > 0 && (
        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)' }}>+{extra}</span>
      )}
    </div>
  );
}

/** Agents with in-flight work — narrowed to the selected agent when filtered. */
function agentCountForSubtext(stats: StatsResponse | null, agentFilter: string): number {
  const map = stats?.inProgressByAgent ?? {};
  if (agentFilter) return (map[agentFilter] ?? 0) > 0 ? 1 : 0;
  return Object.keys(map).filter(k => (map[k] ?? 0) > 0).length;
}

function StatsStrip(props: { stats: StatsResponse | null; agentCount: number }): React.JSX.Element {
  const { stats, agentCount } = props;
  const active  = stats?.counts.active  ?? 0;
  const recent  = stats?.counts.recent  ?? 0;
  const errored = stats?.counts.errored ?? 0;
  const total   = active + recent + errored;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 14 }}>
      <StatCard label="Active" value={active} color="#2563eb" pulse={active > 0}
                sub={agentCount > 0 ? `${agentCount} agent${agentCount === 1 ? '' : 's'} working` : 'No agents in-flight'} />
      <StatCard label="Completed" value={recent} color="#059669" sub="Finished in window" />
      <StatCard label="Errors" value={errored} color={errored > 0 ? '#dc2626' : 'var(--muted)'}
                sub={errored > 0 ? 'Needs attention' : 'No errors'} />
      <StatCard label="Total" value={total} sub="In selected window" />
    </div>
  );
}

function StatCard(props: { label: string; value: number; color?: string; sub?: string; pulse?: boolean }): React.JSX.Element {
  const { label, value, color, sub, pulse } = props;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--subtle)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
        {pulse && <span className="status-running" style={{ width: 6, height: 6, borderRadius: '50%', background: color ?? '#2563eb' }} />}
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: color ?? 'var(--text)', marginTop: 4, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

// ── Per-agent analytics panel (shown when one agent is selected) ─────────────
function fmtMs(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60); const r = Math.round(s - m * 60);
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}
function fmtCost(n: number): string { return !n ? '—' : n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`; }

function AgentPanel(props: { name: string; rollup: AgentRollup; agentId: string; windowKey: WindowKey }): React.JSX.Element {
  const r = props.rollup;
  const sensitiveHref = `/activity/sensitive?agent=${encodeURIComponent(props.agentId)}&window=${props.windowKey}`;
  const fb = r.feedbackUp + r.feedbackDown;
  const score = fb > 0 ? Math.round((r.feedbackUp / fb) * 100) : null;
  const errRate = r.turns > 0 ? Math.round((r.errorTurns / r.turns) * 100) : 0;
  return (
    <div style={{ marginBottom: 14, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 7 }}>
        <ActivityIcon size={14} /> {props.name} — all sessions
      </div>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <PanelKpi icon={<Layers size={13} />} label="Sessions" value={String(r.sessions)} sub={`${r.turns} turn${r.turns === 1 ? '' : 's'}`} />
        <PanelKpi icon={<Wrench size={13} />} label="Tool calls" value={String(r.toolCalls)} />
        <PanelKpi icon={<Coins size={13} />} label="Tokens" value={r.totalTokens > 0 ? formatTokens(r.totalTokens) : '—'} sub={r.totalTokens > 0 ? `${formatTokens(r.inputTokens)} in · ${formatTokens(r.outputTokens)} out` : undefined} />
        <PanelKpi icon={<Clock size={13} />} label="Latency" value={fmtMs(r.p50DurationMs)} sub={`p95 ${fmtMs(r.p95DurationMs)}`} />
        <PanelKpi icon={<AlertTriangle size={13} />} label="Error rate" value={`${errRate}%`} tone={errRate > 0 ? 'red' : undefined} />
        <PanelKpi icon={<ThumbsUp size={13} />} label="Satisfaction" value={score == null ? '—' : `${score}%`} tone={score == null ? undefined : score < 50 ? 'red' : 'green'} />
        <PanelKpi icon={<ShieldAlert size={13} />} label="Sensitive" value={String(r.sensitiveEvents ?? 0)} tone={(r.sensitiveEvents ?? 0) > 0 ? 'red' : undefined} href={sensitiveHref} />
      </div>
      <div style={{ marginTop: 12, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {r.tokensByDay.length >= 2 && (
          <PanelCard title="Tokens per day">
            <DayBars data={r.tokensByDay} />
          </PanelCard>
        )}
        {r.topTools.length > 0 && (
          <PanelCard title="Top tools" titleHref={`/activity/tools?agent=${encodeURIComponent(props.agentId)}&window=${props.windowKey}`}>
            <BarList items={r.topTools.map(t => ({ label: t.name, value: t.count, errors: t.errors }))} fmt={String} hrefFor={() => `/activity/tools?agent=${encodeURIComponent(props.agentId)}&window=${props.windowKey}`} />
          </PanelCard>
        )}
        {r.models.length > 0 && (
          <PanelCard title="Models">
            <BarList items={r.models.map(m => ({ label: m.model, value: m.tokens }))} fmt={formatTokens} />
          </PanelCard>
        )}
      </div>
    </div>
  );
}

function PanelKpi(props: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: 'green' | 'red'; href?: string }): React.JSX.Element {
  const color = props.tone === 'green' ? '#047857' : props.tone === 'red' ? '#b91c1c' : 'var(--text)';
  const inner = (
    <>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', color: 'var(--subtle)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{props.icon}{props.label}</div>
      <div style={{ marginTop: 4, fontSize: 18, fontWeight: 700, color, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{props.value}</div>
      {props.sub && <div style={{ marginTop: 2, fontSize: 11, color: 'var(--subtle)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{props.sub}</div>}
    </>
  );
  const style: React.CSSProperties = { display: 'block', padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, textDecoration: 'none' };
  return props.href
    ? <Link href={props.href} className="metric-clickable" style={style} title="View sensitive access">{inner}</Link>
    : <div style={style}>{inner}</div>;
}
function PanelCard(props: { title: string; titleHref?: string; children: React.ReactNode }): React.JSX.Element {
  const titleStyle: React.CSSProperties = { fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)', marginBottom: 8, display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' };
  return (
    <div style={{ padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
      {props.titleHref
        ? <Link href={props.titleHref} style={titleStyle}>{props.title} <ArrowRight size={11} /></Link>
        : <div style={titleStyle}>{props.title}</div>}
      {props.children}
    </div>
  );
}
/** Interactive stacked in/out token chart (input = lighter, output = darker). */
function DayBars(props: { data: { date: string; input: number; output: number }[] }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...props.data.map(d => d.input + d.output));
  const h = hover != null ? props.data[hover] : null;
  return (
    <div>
      <div style={{ minHeight: 14, marginBottom: 6, textAlign: 'right', fontSize: 11, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text)' }}>
        {h ? <><span style={{ color: 'var(--subtle)' }}>{h.date}</span> {formatTokens(h.input)} in · {formatTokens(h.output)} out</> : ''}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 48 }} onMouseLeave={() => setHover(null)}>
        {props.data.map((d, i) => {
          const total = d.input + d.output;
          return (
            <div key={d.date} onMouseEnter={() => setHover(i)} style={{ flex: 1, maxWidth: 28, minWidth: 4, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
              <div style={{ width: '100%', height: `${Math.max(3, (total / max) * 100)}%`, display: 'flex', flexDirection: 'column', borderRadius: 2, overflow: 'hidden', opacity: hover === i ? 1 : 0.7, transition: 'opacity 0.1s' }}>
                <div style={{ height: `${total ? (d.output / total) * 100 : 0}%`, background: 'var(--text-2)' }} />
                <div style={{ height: `${total ? (d.input / total) * 100 : 0}%`, background: 'var(--muted)' }} />
              </div>
            </div>
          );
        })}
      </div>
      <TokenLegend />
    </div>
  );
}

/** Two-swatch legend for stacked in/out token charts. */
function TokenLegend(): React.JSX.Element {
  const sw = (c: string) => <span style={{ width: 8, height: 8, borderRadius: 2, background: c, display: 'inline-block', marginRight: 4 }} />;
  return (
    <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10, color: 'var(--subtle)' }}>
      <span>{sw('var(--muted)')}in</span>
      <span>{sw('var(--text-2)')}out</span>
    </div>
  );
}
function BarList(props: { items: { label: string; value: number; errors?: number }[]; fmt: (n: number) => string; hrefFor?: (label: string) => string }): React.JSX.Element {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...props.items.map(i => i.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }} onMouseLeave={() => setHover(null)}>
      {props.items.map(it => {
        const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, textDecoration: 'none', color: 'inherit', cursor: props.hrefFor ? 'pointer' : 'default' };
        const inner = (
          <>
            <code title={it.label} style={{ flexShrink: 0, width: 150, color: hover === it.label ? 'var(--text)' : 'var(--text-2)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</code>
            <div style={{ flex: 1, height: 8, background: 'var(--surface-3, var(--border))', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(3, (it.value / max) * 100)}%`, height: '100%', background: 'var(--accent-2)', borderRadius: 4, opacity: hover === it.label ? 1 : 0.8, transition: 'opacity 0.1s' }} />
            </div>
            <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: 11, minWidth: 52, textAlign: 'right' }}>
              <span style={{ color: 'var(--text-2)' }}>{props.fmt(it.value)}</span>
              {it.errors ? <span title={`${it.errors} failed`} style={{ color: 'var(--red)', marginLeft: 6 }}>{it.errors} err</span> : null}
            </span>
          </>
        );
        return props.hrefFor
          ? <Link key={it.label} href={props.hrefFor(it.label)} onMouseEnter={() => setHover(it.label)} style={rowStyle}>{inner}</Link>
          : <div key={it.label} onMouseEnter={() => setHover(it.label)} style={rowStyle}>{inner}</div>;
      })}
    </div>
  );
}
