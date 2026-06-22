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
import { Activity as ActivityIcon, AlertTriangle, CheckCircle2, CircleDashed, ThumbsUp, ThumbsDown, ShieldAlert } from 'lucide-react';
import type { AgentRollup } from '@slackhive/shared';
import { TabSwitcher } from './_components/TabSwitcher';
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
  sensitive?: boolean;
  agentIds?: string[];
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
  // Agent participation per task now comes straight from the list response
  // (Task.agentIds) — no per-card trace fetch needed.
  // Mirror how many rows each column currently shows, so the 4s poll can re-fetch
  // the SAME expanded count (one page) instead of clobbering "Load more" back to
  // the first page. Ref (not dep) so it doesn't rebuild `load`/restart the poll.
  const shownCountRef = useRef<Record<Column, number>>({ active: 0, recent: 0, errored: 0 });
  useEffect(() => {
    shownCountRef.current = {
      active: lists.active.tasks.length,
      recent: lists.recent.tasks.length,
      errored: lists.errored.tasks.length,
    };
  }, [lists]);
  // Changing filter/window collapses back to the first page.
  useEffect(() => { shownCountRef.current = { active: 0, recent: 0, errored: 0 }; }, [agentFilter, windowKey, from, to]);
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
    // Keep a "Load more"-expanded column expanded across polls: ask for as many
    // rows as are shown now (capped at the route's 100), as a single page.
    const shown = shownCountRef.current[col] ?? 0;
    if (shown > 20) params.set('limit', String(Math.min(100, shown)));
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

      {/* Per-agent analytics (KPIs / tokens / tools / models) moved to the
          Observability page — Activity stays the task kanban. */}

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
  onLoadMore: () => void;
}): React.JSX.Element {
  const { column, tasks, hasMore, loaded, agentById, onLoadMore } = props;

  return (
    <div style={{
      background: `color-mix(in srgb, ${column.accent} 4%, var(--surface))`,
      border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: column.accent, flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{column.label}</span>
        <span style={{
          fontSize: 11.5, fontWeight: 600, color: 'var(--muted)',
          background: 'var(--surface-2)', borderRadius: 99, padding: '1px 8px',
        }}>{tasks.length}{hasMore ? '+' : ''}</span>
      </div>
      <div style={{ padding: '4px 10px 10px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120 }}>
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
            agentIds={t.agentIds ?? (t.initialAgentId ? [t.initialAgentId] : [])}
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
  // Card opens the full turn-by-turn trace for this thread.
  const primaryAgent = agentIds[0] ?? task.initialAgentId;
  const primaryAgentName = primaryAgent ? agentById.get(primaryAgent)?.name : undefined;
  const href = `/activity/${encodeURIComponent(task.id)}`;

  return (
    <Link
      href={href}
      style={{
        textDecoration: 'none', color: 'inherit',
        display: 'block', padding: '11px 13px',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, boxShadow: 'var(--shadow-sm)',
        transition: 'box-shadow 0.12s, border-color 0.12s',
      }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.boxShadow = 'var(--shadow-hover)'; el.style.borderColor = 'var(--border-2)'; }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.boxShadow = 'var(--shadow-sm)'; el.style.borderColor = 'var(--border)'; }}
    >
      {/* Top row: ref code + sensitive flag + time */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
        <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--subtle)', letterSpacing: '0.01em' }}>{shortRef(task.id)}</span>
        {task.sensitive && (
          <ShieldAlert size={12} style={{ color: '#b45309', flexShrink: 0 }} aria-label="Contains sensitive data"><title>Contains sensitive data</title></ShieldAlert>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--subtle)', flexShrink: 0 }}>{relativeTime(task.lastActivityAt)}</span>
      </div>

      {/* Title — up to two lines, like a Linear issue */}
      <div style={{
        fontSize: 13.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4, letterSpacing: '-0.005em',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {task.summary || '(empty message)'}
      </div>

      {/* Footer: avatars (assignee) + meta chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11 }}>
        {agentIds.length > 0 && <AvatarStack agentIds={agentIds} agentById={agentById} />}
        {primaryAgentName && (
          <span style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{primaryAgentName}</span>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {!!task.feedbackUp && <Chip color="#16a34a"><ThumbsUp size={10} />{task.feedbackUp}</Chip>}
          {!!task.feedbackDown && <Chip color="#dc2626"><ThumbsDown size={10} />{task.feedbackDown}</Chip>}
          <Chip>{task.activityCount} turn{task.activityCount === 1 ? '' : 's'}</Chip>
        </span>
      </div>
    </Link>
  );
}

/** Linear-style short, stable, human-readable ref from the (ugly) task id. Cosmetic. */
function shortRef(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return 'T-' + h.toString(36).toUpperCase().padStart(4, '0').slice(0, 4);
}

/** Small rounded meta chip (Linear-style badge). */
function Chip({ children, color }: { children: React.ReactNode; color?: string }): React.JSX.Element {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 500,
      color: color ?? 'var(--muted)', background: color ? `${color}14` : 'var(--surface-2)',
      border: `1px solid ${color ? `${color}33` : 'var(--border)'}`, borderRadius: 6, padding: '1px 7px',
    }}>{children}</span>
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

