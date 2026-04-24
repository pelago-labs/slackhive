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
import { Activity as ActivityIcon, Users, AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react';
import { TabSwitcher } from './_components/TabSwitcher';
import { FilterRow, type WindowKey } from './_components/FilterRow';

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
  const [windowKey, setWindowKey] = useState<WindowKey>(
    ((): WindowKey => {
      const w = searchParams?.get('window');
      return w === '1h' || w === '5h' || w === '24h' || w === '7d' || w === '30d' ? w : '24h';
    })(),
  );
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
    const params = new URLSearchParams({ column: col, window: windowKey });
    if (agentFilter) params.set('agent', agentFilter);
    const r = await fetch(`/api/activity?${params.toString()}`);
    if (!r.ok) return { tasks: [], nextCursor: null };
    return r.json();
  }, [agentFilter, windowKey]);

  const fetchStats = useCallback(async (): Promise<StatsResponse | null> => {
    const params = new URLSearchParams({ window: windowKey });
    if (agentFilter) params.set('agent', agentFilter);
    const r = await fetch(`/api/activity/stats?${params.toString()}`);
    if (!r.ok) return null;
    return r.json();
  }, [agentFilter, windowKey]);

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
        const ids = Array.from(new Set((body.activities ?? []).map((a: { agentId: string }) => a.agentId))) as string[];
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
    const params = new URLSearchParams({ column: col, window: windowKey, cursor });
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
      />

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
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
      gap: 10,
      marginBottom: 14,
    }}>
      <StatCard label="Active"     value={active}  color="#2563eb" pulse={active > 0}
                sub={agentCount > 0 ? `${agentCount} agent${agentCount === 1 ? '' : 's'} working` : 'No agents in-flight'} />
      <StatCard label="Completed"  value={recent}  color="#059669"
                sub="Finished in window" />
      <StatCard label="Errors"     value={errored} color={errored > 0 ? '#dc2626' : 'var(--muted)'}
                sub={errored > 0 ? 'Needs attention' : 'No errors'} />
      <StatCard label="Total"      value={total}
                sub="In selected window" />
    </div>
  );
}

function StatCard(props: {
  label: string; value: number; color?: string; sub?: string; pulse?: boolean;
}): React.JSX.Element {
  const { label, value, color, sub, pulse } = props;
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 14px',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
        color: 'var(--subtle)', textTransform: 'uppercase',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {pulse && (
          <span className="status-running" style={{
            width: 6, height: 6, borderRadius: '50%', background: color ?? '#2563eb',
          }} />
        )}
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em',
        color: color ?? 'var(--text)', marginTop: 4, lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 5 }}>{sub}</div>
      )}
    </div>
  );
}
