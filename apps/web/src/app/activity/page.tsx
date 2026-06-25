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
import { TabSwitcher } from './_components/TabSwitcher';
import { FilterRow, parseWindowKey, timeParams, type WindowKey } from './_components/FilterRow';
import { ReplayButton } from './_components/ReplayButton';
import { relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { PageShell, PageHeader, EmptyState, AvatarStack } from '@/components/patterns';

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
    <PageShell>
      <PageHeader
        title={<span className="flex items-center gap-2.5"><ActivityIcon size={20} /> Activity</span>}
        subtitle="Every task your agents worked on, live."
        action={
          <div className={cn(
            'inline-flex items-center gap-1.5 text-xs font-medium',
            activeCount > 0 ? 'text-blue' : 'text-muted-foreground',
          )}>
            <span className={cn(
              'h-[7px] w-[7px] rounded-full',
              activeCount > 0 ? 'bg-blue shadow-[0_0_0_3px_rgba(37,99,235,0.15)]' : 'bg-border',
            )} />
            {activeCount > 0 ? `${activeCount} active` : 'Idle'}
          </div>
        }
      />

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

      <div className="grid grid-cols-3 gap-3.5">
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
    </PageShell>
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
    <div
      className="flex flex-col overflow-hidden rounded-xl border border-border"
      style={{ background: `color-mix(in srgb, ${column.accent} 4%, var(--surface))` }}
    >
      <div className="flex items-center gap-2 px-3.5 py-3">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: column.accent }} />
        <span className="text-xs font-semibold text-foreground">{column.label}</span>
        <span className="rounded-full bg-secondary px-2 py-px text-xs font-semibold text-muted-foreground">{tasks.length}{hasMore ? '+' : ''}</span>
      </div>
      <div className="flex min-h-[120px] flex-col gap-2 px-2.5 pb-2.5 pt-1">
        {!loaded && <div className="p-5 text-center text-xs text-muted-foreground">Loading…</div>}
        {loaded && tasks.length === 0 && (
          <EmptyState title="No tasks" className="px-6 py-6" />
        )}
        {tasks.map(t => (
          <TaskCard
            key={t.id}
            task={t}
            agentById={agentById}
            agentIds={t.agentIds ?? (t.initialAgentId ? [t.initialAgentId] : [])}
            isErrored={column.key === 'errored'}
          />
        ))}
        {hasMore && (
          <button
            onClick={onLoadMore}
            className="mt-1 cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-2 text-xs font-medium text-muted-foreground hover:bg-secondary"
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
  isErrored?: boolean;
}): React.JSX.Element {
  const { task, agentById, agentIds, isErrored } = props;
  // Card opens the full turn-by-turn trace for this thread.
  const primaryAgent = agentIds[0] ?? task.initialAgentId;
  const primaryAgentName = primaryAgent ? agentById.get(primaryAgent)?.name : undefined;
  const href = `/activity/${encodeURIComponent(task.id)}`;

  return (
    <Link
      href={href}
      className="block rounded-[10px] border border-border bg-card px-3 py-3 text-inherit no-underline shadow-sm transition-[box-shadow,border-color] duration-100 hover:border-input hover:shadow-lg"
    >
      {/* Top row: ref code + sensitive flag + time */}
      <div className="mb-[7px] flex items-center gap-1.5">
        <span className="text-xs font-medium tracking-[0.01em] text-muted-foreground/80">{shortRef(task.id)}</span>
        {task.sensitive && (
          <ShieldAlert size={12} className="shrink-0 text-amber" aria-label="Contains sensitive data"><title>Contains sensitive data</title></ShieldAlert>
        )}
        <span className="ml-auto shrink-0 text-2xs text-muted-foreground/80">{relativeTime(task.lastActivityAt)}</span>
      </div>

      {/* Title — up to two lines, like a Linear issue */}
      <div
        className="overflow-hidden text-sm font-semibold leading-snug text-foreground"
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
      >
        {task.summary || '(empty message)'}
      </div>

      {/* Footer: avatars (assignee) + meta chips */}
      <div className="mt-3 flex items-center gap-2">
        {agentIds.length > 0 && (
          <AvatarStack
            items={agentIds.map(id => ({ id, name: agentById.get(id)?.name ?? id.slice(0, 6) }))}
            size={20}
            max={3}
          />
        )}
        {primaryAgentName && (
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">{primaryAgentName}</span>
        )}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
          {!!task.feedbackUp && <Chip color="#16a34a"><ThumbsUp size={10} />{task.feedbackUp}</Chip>}
          {!!task.feedbackDown && <Chip color="#dc2626"><ThumbsDown size={10} />{task.feedbackDown}</Chip>}
          <Chip>{task.activityCount} turn{task.activityCount === 1 ? '' : 's'}</Chip>
          {isErrored && <ReplayButton taskId={task.id} variant="icon" />}
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
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border px-[7px] py-px text-2xs font-medium',
        !color && 'border-border bg-secondary text-muted-foreground',
      )}
      style={color ? { color, background: `${color}14`, borderColor: `${color}33` } : undefined}
    >{children}</span>
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
    <div className="mb-3.5 grid grid-cols-4 gap-2.5">
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
    <div className="rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {pulse && <span className="status-running h-1.5 w-1.5 rounded-full" style={{ background: color ?? '#2563eb' }} />}
        {label}
      </div>
      <div
        className={cn('mt-1 text-2xl font-bold leading-none tabular-nums tracking-tight', !color && 'text-foreground')}
        style={color ? { color } : undefined}
      >{value}</div>
      {sub && <div className="mt-1 text-2xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

