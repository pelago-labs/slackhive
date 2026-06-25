'use client';

/**
 * @fileoverview Dashboard — agent fleet overview.
 * Shows agent hierarchy by default (boss → reports) with grid toggle.
 *
 * @module web/app/page
 */

import { createContext, useContext, useEffect, useState } from 'react';
import type { Agent } from '@slackhive/shared';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { Bot, LayoutGrid, GitBranch, Search, ArrowUpDown, Plus } from 'lucide-react';
import { PageShell } from '@/components/patterns';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/time';

type SortKey = 'boss-first' | 'name' | 'recent' | 'status';
const SORT_LABELS: Record<SortKey, string> = {
  'boss-first': 'Boss first',
  'name': 'A → Z',
  'recent': 'Recently active',
  'status': 'Status',
};
const STATUS_RANK: Record<string, number> = { running: 0, error: 1, stopped: 2, stale: 3 };

// Minimalist deterministic avatar palette — soft pastel background + darker
// foreground letter, à la Linear / Notion. Low saturation so cards feel calm
// in dense grids; the actual Slack profile image is preferred when available.
const AVATAR_PALETTES: { bg: string; fg: string }[] = [
  { bg: '#fef3c7', fg: '#92400e' }, // amber
  { bg: '#fce7f3', fg: '#9d174d' }, // pink
  { bg: '#ede9fe', fg: '#5b21b6' }, // violet
  { bg: '#dbeafe', fg: '#1e40af' }, // blue
  { bg: '#cffafe', fg: '#155e75' }, // cyan
  { bg: '#dcfce7', fg: '#166534' }, // green
  { bg: '#ecfccb', fg: '#3f6212' }, // lime
  { bg: '#fee2e2', fg: '#991b1b' }, // red
  { bg: '#ffedd5', fg: '#9a3412' }, // orange
  { bg: '#f3f4f6', fg: '#1f2937' }, // gray
];
function avatarPalette(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTES[Math.abs(h) % AVATAR_PALETTES.length];
}

const InProgressContext = createContext<Record<string, number>>({});

const STATUS_COLOR: Record<string, string> = {
  running: '#059669',
  stopped: '#a3a3a3',
  error:   '#dc2626',
  stale:   '#f59e0b',
};

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  error:   'Error',
  stale:   'Stale',
};

interface BackendStatus {
  backend?: string;
  label?: string;
  status: 'connected' | 'disconnected' | 'expired';
  source?: string;
  expiresIn?: string;
  hint?: string;
}

export default function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('Welcome to SlackHive');
  const [view, setView] = useState<'hierarchy' | 'grid'>('hierarchy');
  const [claudeStatus, setClaudeStatus] = useState<BackendStatus | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [inProgressByAgent, setInProgressByAgent] = useState<Record<string, number>>({});
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('boss-first');
  const [sortOpen, setSortOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { canEdit } = useAuth();

  // Track scroll for sticky-bar shadow
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Persist sort choice
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('slackhive-dashboard-sort') : null;
    if (saved && saved in SORT_LABELS) setSort(saved as SortKey);
  }, []);
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('slackhive-dashboard-sort', sort);
  }, [sort]);

  const loadStatus = () => {
    fetch('/api/system/backend-status').then(r => r.json()).then(setClaudeStatus).catch(() => {});
  };

  const loadActivityStats = () => {
    fetch('/api/activity/stats')
      .then(r => r.json())
      .then((s: { inProgressByAgent?: Record<string, number> }) => {
        setInProgressByAgent(s.inProgressByAgent ?? {});
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then((list: Agent[]) => {
        setAgents(list);
        // Lazy-backfill Slack avatar URL for any agent missing one.
        // Fire-and-forget; refresh agent state with new URL on success.
        list
          .filter(a => a.slackBotUserId && !a.slackBotImageUrl)
          .forEach(a => {
            fetch(`/api/agents/${a.id}/refresh-slack-profile`, { method: 'POST' })
              .then(r => r.ok ? r.json() : null)
              .then(d => {
                if (d?.ok && d.slackBotImageUrl) {
                  setAgents(prev => prev.map(x => x.id === a.id
                    ? { ...x, slackBotImageUrl: d.slackBotImageUrl, slackBotHandle: d.slackBotHandle ?? x.slackBotHandle }
                    : x
                  ));
                }
              })
              .catch(() => {});
          });
      })
      .finally(() => setLoading(false));
    fetch('/api/settings')
      .then(r => r.json())
      .then((s: Record<string, string>) => { if (s.dashboardTitle) setTitle(s.dashboardTitle); })
      .catch(() => {});
    loadStatus();
    loadActivityStats();
    const interval = setInterval(loadStatus, 30000);
    const activityInterval = setInterval(loadActivityStats, 4000);
    return () => { clearInterval(interval); clearInterval(activityInterval); };
  }, []);

  const allTags = [...new Set(agents.flatMap(a => a.tags ?? []))].sort();
  const q = search.trim().toLowerCase();
  const filteredAgents = agents
    .filter(a => !selectedTag || (a.tags ?? []).includes(selectedTag))
    .filter(a => !q || (
      a.name.toLowerCase().includes(q) ||
      a.slug.toLowerCase().includes(q) ||
      (a.persona ?? '').toLowerCase().includes(q) ||
      (a.description ?? '').toLowerCase().includes(q) ||
      (a.tags ?? []).some(t => t.toLowerCase().includes(q))
    ))
    .sort((a, b) => {
      switch (sort) {
        case 'name': return a.name.localeCompare(b.name);
        case 'recent': {
          const ta = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
          const tb = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
          return tb - ta;
        }
        case 'status': {
          const sa = STATUS_RANK[(a.liveStatus ?? a.status) as string] ?? 99;
          const sb = STATUS_RANK[(b.liveStatus ?? b.status) as string] ?? 99;
          return sa - sb || a.name.localeCompare(b.name);
        }
        case 'boss-first':
        default:
          if (a.isBoss !== b.isBoss) return a.isBoss ? -1 : 1;
          return a.name.localeCompare(b.name);
      }
    });

  const running = agents.filter(a => a.status === 'running').length;
  const stopped = agents.filter(a => a.status === 'stopped').length;
  const total   = agents.length;
  const bossCount = agents.filter(a => a.isBoss).length;

  const hasHierarchy = filteredAgents.some(a => a.isBoss) || filteredAgents.some(a => a.reportsTo?.length > 0);

  return (
    <InProgressContext.Provider value={inProgressByAgent}>
    <PageShell maxWidth={1440}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="mb-7 flex items-center justify-between">
        <div>
          <h1 className="m-0 text-2xl font-bold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="mt-1.5 text-base text-muted-foreground">
            {loading ? 'Loading agents…' : `${running} of ${total} agent${total !== 1 ? 's' : ''} online`}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {/* Active agent-backend status badge */}
          {claudeStatus && (
            <div className="relative">
              <button
                onClick={() => setStatusOpen(!statusOpen)}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-[7px] text-xs text-foreground"
              >
                <span className={cn(
                  'inline-block h-2 w-2 rounded-full',
                  claudeStatus.status === 'connected' ? 'bg-green'
                    : claudeStatus.status === 'expired' ? 'bg-amber'
                    : 'bg-red',
                )} />
                {claudeStatus.label ?? 'Backend'} {claudeStatus.status === 'connected' ? 'connected' : claudeStatus.status === 'expired' ? 'expired' : 'disconnected'}
              </button>
              {statusOpen && (
                <div className="absolute right-0 top-full z-[100] mt-1.5 min-w-[260px] rounded-md border border-border bg-card p-3 text-xs shadow-md">
                  <div className="mb-2 flex justify-between">
                    <span className="font-semibold text-foreground">{claudeStatus.label ?? 'Backend'} Status</span>
                    <button onClick={() => setStatusOpen(false)} className="cursor-pointer border-none bg-none p-0 text-muted-foreground">×</button>
                  </div>
                  <div className="leading-relaxed text-muted-foreground">
                    <div>Status: <strong className="text-foreground">{claudeStatus.status}</strong></div>
                    {claudeStatus.source && <div>Source: <strong className="text-foreground">{claudeStatus.source}</strong></div>}
                    {claudeStatus.expiresIn && <div>Expires in: <strong className="text-foreground">{claudeStatus.expiresIn}</strong></div>}
                    {claudeStatus.status !== 'connected' && (
                      <div className="mt-2 rounded-md bg-muted px-2.5 py-2 text-2xs leading-relaxed">
                        {claudeStatus.hint ?? 'Configure credentials in Settings → Agent Backend.'}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {/* View toggle */}
          {!loading && total > 0 && (
            <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted p-[3px]">
              <ViewBtn active={view === 'hierarchy'} onClick={() => setView('hierarchy')} title="Hierarchy">
                <GitBranch size={14} />
              </ViewBtn>
              <ViewBtn active={view === 'grid'} onClick={() => setView('grid')} title="Grid">
                <LayoutGrid size={14} />
              </ViewBtn>
            </div>
          )}
          {canEdit && (
            <Button asChild>
              <Link href="/agents/new">
                <Plus size={14} />
                New Agent
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/* ── Inline stats strip ───────────────────────────────────────────── */}
      {!loading && total > 0 && (
        <div className="mb-[18px] flex flex-wrap items-center gap-[18px] text-sm text-muted-foreground">
          <Stat n={total} label={`agent${total !== 1 ? 's' : ''}`} />
          <span className="text-border">·</span>
          <Stat n={running} label="running" colorClass="text-green" />
          <span className="text-border">·</span>
          <Stat n={stopped} label="stopped" colorClass={stopped > 0 ? 'text-muted-foreground' : undefined} />
          {bossCount > 0 && (
            <>
              <span className="text-border">·</span>
              <Stat n={bossCount} label={bossCount === 1 ? 'boss' : 'bosses'} />
            </>
          )}
        </div>
      )}

      {/* ── Sticky search + sort + tag filter bar ────────────────────────── */}
      {!loading && total > 0 && (
        <div className={cn(
          'sticky top-0 z-20 mb-[18px] border-b border-border bg-background pb-3.5 pt-1 transition-shadow duration-200',
          scrolled && 'shadow-[0_4px_12px_-8px_rgba(0,0,0,0.12)]',
        )}>
          <div className={cn('flex items-center gap-3', allTags.length > 0 && 'mb-3')}>
            {/* Search */}
            <div className="relative max-w-[320px] flex-1">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search agents…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-[34px] w-full rounded-md border border-input bg-card pl-[34px] pr-3 text-sm text-foreground outline-none"
              />
            </div>
            {/* Sort */}
            <div className="relative">
              <button
                onClick={() => setSortOpen(!sortOpen)}
                className="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs text-foreground"
              >
                <ArrowUpDown size={13} />
                {SORT_LABELS[sort]}
              </button>
              {sortOpen && (
                <div className="absolute right-0 top-full z-30 mt-1 min-w-[180px] rounded-md border border-border bg-card p-1 shadow-md">
                  {(Object.keys(SORT_LABELS) as SortKey[]).map(k => (
                    <button
                      key={k}
                      onClick={() => { setSort(k); setSortOpen(false); }}
                      className={cn(
                        'block w-full rounded-md px-2.5 py-[7px] text-left text-xs text-foreground',
                        sort === k ? 'bg-muted font-semibold' : 'bg-transparent font-normal',
                      )}
                    >{SORT_LABELS[k]}</button>
                  ))}
                </div>
              )}
            </div>
            {/* Match count */}
            <span className="ml-auto text-xs text-muted-foreground">
              {filteredAgents.length} of {total}
            </span>
          </div>
          {/* Tag chips */}
          {allTags.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5">
              <FilterChip active={selectedTag === null} onClick={() => setSelectedTag(null)}>All</FilterChip>
              {allTags.map(tag => (
                <FilterChip key={tag} active={selectedTag === tag} onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}>
                  {tag}
                </FilterChip>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Content ──────────────────────────────────────────────────────── */}
      {loading ? (
        <SkeletonGrid />
      ) : total === 0 ? (
        <EmptyState />
      ) : view === 'hierarchy' && hasHierarchy ? (
        <HierarchyView agents={filteredAgents} />
      ) : (
        <GridView agents={filteredAgents} />
      )}
    </PageShell>
    </InProgressContext.Provider>
  );
}

// ── View toggle button ─────────────────────────────────────────────────────────

function ViewBtn({ active, onClick, title, children }: {
  active: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border-none transition-all',
        active ? 'bg-card text-foreground shadow' : 'bg-transparent text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}

// ── Hierarchy view ────────────────────────────────────────────────────────────

const CARD_W = 260;
const CARD_GAP = 16;

function HierarchyView({ agents }: { agents: Agent[] }) {
  const bosses = agents.filter(a => a.isBoss);
  const nonBosses = agents.filter(a => !a.isBoss);
  const standalone = nonBosses.filter(a => !a.reportsTo || a.reportsTo.length === 0);
  const reportMap = new Map<string, Agent[]>();
  for (const boss of bosses) {
    reportMap.set(boss.id, nonBosses.filter(a => a.reportsTo?.includes(boss.id)));
  }

  if (bosses.length === 0) return <GridView agents={agents} label="All Agents" />;

  return (
    <div className="flex flex-col gap-14">
      {bosses.map(boss => (
        <OrgTree key={boss.id} boss={boss} reports={reportMap.get(boss.id) ?? []} />
      ))}

      {standalone.length > 0 && (
        <div>
          <SectionLabel label="Independent" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {standalone.map(a => <AgentCard key={a.id} agent={a} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="mb-5 flex items-center gap-2.5">
      <div className="text-2xs font-bold uppercase tracking-[0.09em] text-muted-foreground">
        {label}
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function OrgTree({ boss, reports }: { boss: Agent; reports: Agent[] }) {
  const n = reports.length;
  // total width of the reports row
  const rowW = n * CARD_W + Math.max(0, n - 1) * CARD_GAP;
  const bossW = Math.min(360, Math.max(CARD_W, rowW));
  const V_DROP = 32; // px from boss card bottom to horizontal bar
  const STUB_H = 20; // px from horizontal bar down to each report card

  return (
    <div>
      {/* Boss card — centered over the reports row */}
      <div className={cn('flex flex-col', n > 0 ? 'items-center' : 'items-start')}>
        <div className="max-w-full" style={{ width: bossW }}>
          <AgentCard agent={boss} />
        </div>

        {n > 0 && (
          <>
            {/* SVG connector: vertical stem + horizontal bar + stubs */}
            <svg
              width={Math.max(rowW, bossW)}
              height={V_DROP + STUB_H}
              className="block overflow-visible"
            >
              {(() => {
                const svgW = Math.max(rowW, bossW);
                const stemX = svgW / 2;
                const barY = V_DROP;
                // center of each report card
                const cardCenters = Array.from({ length: n }, (_, i) =>
                  i * (CARD_W + CARD_GAP) + CARD_W / 2 + (svgW - rowW) / 2
                );
                const barX1 = cardCenters[0];
                const barX2 = cardCenters[n - 1];
                return (
                  <g stroke="var(--border-2)" strokeWidth="1.5" fill="none">
                    {/* Vertical stem from boss */}
                    <line x1={stemX} y1={0} x2={stemX} y2={barY} />
                    {/* Horizontal bar */}
                    {n > 1 && <line x1={barX1} y1={barY} x2={barX2} y2={barY} />}
                    {/* Stubs down to each card */}
                    {cardCenters.map((cx, i) => (
                      <line key={i} x1={cx} y1={barY} x2={cx} y2={barY + STUB_H} />
                    ))}
                  </g>
                );
              })()}
            </svg>

            {/* Reports row */}
            <div className="flex items-start" style={{ gap: CARD_GAP, width: Math.max(rowW, bossW) }}>
              {/* Offset so cards align under SVG stubs */}
              <div className="flex" style={{ gap: CARD_GAP, marginLeft: (Math.max(rowW, bossW) - rowW) / 2 }}>
                {reports.map(agent => (
                  <div key={agent.id} className="shrink-0" style={{ width: CARD_W }}>
                    <AgentCard agent={agent} compact multiReport={(agent.reportsTo?.length ?? 0) > 1} />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Grid view ─────────────────────────────────────────────────────────────────

function GridView({ agents, label }: { agents: Agent[]; label?: string }) {
  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
        No agents match the current filters.
      </div>
    );
  }
  return (
    <>
      {label && (
        <div className="mb-3 pl-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {label}
        </div>
      )}
      <div className="stagger agent-grid grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
        {agents.map(agent => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </>
  );
}

// ── Agent card ────────────────────────────────────────────────────────────────

function AgentCard({ agent, compact, multiReport }: {
  agent: Agent;
  compact?: boolean;
  multiReport?: boolean;
}) {
  const noCreds = !agent.hasSlackCreds;
  const displayStatus = (agent.liveStatus ?? agent.status) as string;
  const color = noCreds ? '#f59e0b' : (STATUS_COLOR[displayStatus] ?? '#a3a3a3');
  const statusLabel = noCreds ? 'Not configured' : STATUS_LABEL[displayStatus];
  const inProgressMap = useContext(InProgressContext);
  const inProgress = inProgressMap[agent.id] ?? 0;
  const tags = agent.tags ?? [];
  const visibleTags = tags.slice(0, 1);
  const overflowTags = tags.length - visibleTags.length;
  const modelShort = agent.model.replace('claude-', '').split('-20')[0];
  const palette = avatarPalette(agent.name);
  const lastActive = relativeTime(agent.lastHeartbeat);
  const hasDescription = !!agent.description?.trim();
  const [imgFailed, setImgFailed] = useState(false);
  const showSlackImage = !!agent.slackBotImageUrl && !imgFailed;

  return (
    <Link
      href={`/agents/${agent.slug}`}
      className={cn(
        'fade-up agent-card-v2 ui-card ui-card-hover relative block rounded-lg border border-border bg-card no-underline shadow-sm',
        compact ? 'px-4 pb-3.5 pt-4' : 'p-[18px]',
      )}
    >
      {/* Avatar + name + status row */}
      <div className={cn('flex items-center gap-2.5', hasDescription ? 'mb-2' : 'mb-2.5')}>
        {/* Avatar wrapper — relative for status dot, no overflow:hidden so dot can sit outside circle */}
        <div className="relative h-11 w-11 shrink-0">
          <div
            className={cn(
              'flex h-11 w-11 items-center justify-center overflow-hidden rounded-full text-md font-semibold',
              showSlackImage && 'bg-muted',
            )}
            style={showSlackImage ? undefined : { background: palette.bg, color: palette.fg }}
          >
            {showSlackImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={agent.slackBotImageUrl}
                alt={agent.name}
                width={44}
                height={44}
                onError={() => setImgFailed(true)}
                className="block h-full w-full object-cover"
              />
            ) : (
              agent.name.charAt(0).toUpperCase()
            )}
          </div>
          {/* Status dot — bottom-right, outside the clipped avatar so it isn't cut off */}
          <span
            className={cn(
              'absolute bottom-0 right-0 box-content h-[11px] w-[11px] rounded-full border-2 border-card',
              displayStatus === 'running' && 'status-running',
            )}
            style={{ background: color }}
            title={statusLabel}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-base font-semibold text-foreground">
              {agent.name}
            </span>
            {agent.isBoss && (
              <span className="shrink-0 rounded-sm bg-primary px-[5px] py-px text-[9px] font-bold uppercase tracking-[0.05em] text-primary-foreground">Boss</span>
            )}
            {multiReport && (
              <span className="shrink-0 rounded-sm border border-border bg-muted px-1 py-px text-[9px] font-semibold text-muted-foreground">×2</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="font-medium" style={{ color }}>{statusLabel}</span>
            {displayStatus === 'running' && lastActive && (
              <>
                <span className="text-border">·</span>
                <span>{lastActive}</span>
              </>
            )}
          </div>
        </div>
        {inProgress > 0 && (
          <span className="inline-flex shrink-0 items-center gap-[3px] rounded-sm bg-blue/10 px-1.5 py-0.5 text-2xs font-semibold text-blue">
            <span className="status-running h-[5px] w-[5px] rounded-full bg-blue" />
            {inProgress > 1 ? `×${inProgress}` : ''}
          </span>
        )}
      </div>

      {/* Description — only if present, no italic placeholder noise */}
      {hasDescription && (
        <p className="mx-0 mb-2.5 mt-0 truncate text-xs leading-snug text-muted-foreground" title={agent.description}>
          {agent.description}
        </p>
      )}

      {/* Tags row + model badge — single line, model never overflows the card */}
      <div className="flex min-h-[18px] min-w-0 items-center gap-[5px]">
        <div className="flex min-w-0 flex-[0_1_auto] items-center gap-[5px] overflow-hidden">
          {visibleTags.map(tag => (
            <span key={tag} className="max-w-[110px] truncate rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{tag}</span>
          ))}
          {overflowTags > 0 && (
            <span className="shrink-0 text-[10px] text-muted-foreground">+{overflowTags}</span>
          )}
        </div>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
          {modelShort}
          {agent.slackBotUserId && (
            <span className="text-green" title={agent.slackBotHandle ? `@${agent.slackBotHandle}` : 'Slack connected'}>●</span>
          )}
        </span>
      </div>
    </Link>
  );
}

// ── Inline stat + filter chip helpers ─────────────────────────────────────────

function Stat({ n, label, colorClass }: { n: number; label: string; colorClass?: string }) {
  return (
    <span className="inline-flex items-baseline gap-[5px]">
      <strong className={cn('text-base font-bold tabular-nums', colorClass ?? 'text-foreground')}>{n}</strong>
      <span>{label}</span>
    </span>
  );
}

function FilterChip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'shrink-0 cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-all',
        active
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-card text-muted-foreground',
      )}
    >{children}</button>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
      {[1, 2, 3, 4, 5, 6].map(i => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card px-4 pb-3 pt-3.5 shadow-sm"
          style={{ opacity: 1 - (i - 1) * 0.12 }}
        >
          <div className="mb-2.5 flex gap-2.5">
            <Skel w={44} h={44} r={12} />
            <div className="flex-1 pt-1">
              <Skel w="60%" h={14} r={5} mb={6} />
              <Skel w="40%" h={11} r={4} />
            </div>
          </div>
          <Skel w="90%" h={11} r={4} mb={10} />
          <Skel w="50%" h={11} r={4} />
        </div>
      ))}
    </div>
  );
}

function Skel({ w, h, r = 4, mb = 0 }: { w: number | string; h: number; r?: number; mb?: number }) {
  return (
    <div className="bg-muted" style={{ width: w, height: h, borderRadius: r, marginBottom: mb }} />
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  const { canEdit } = useAuth();
  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-5 text-center">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
        <Bot size={30} />
      </div>
      <div>
        <p className="mx-0 mb-1.5 mt-0 text-lg font-semibold tracking-tight text-foreground">
          No agents yet
        </p>
        <p className="m-0 max-w-[300px] text-base text-muted-foreground">
          {canEdit ? 'Create your first Claude Code agent and connect it to Slack to get started.' : 'No agents have been configured yet. Ask an admin to set one up.'}
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        {canEdit && (
          <Button asChild size="lg">
            <Link href="/agents/new">
              <Plus size={14} />
              Create First Agent
            </Link>
          </Button>
        )}
        <a
          href="https://slackhive.mintlify.app/quickstart"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-2.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground"
        >
          Read the docs
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="shrink-0">
            <path d="M6 3h7v7M13 3L5 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </a>
      </div>
    </div>
  );
}
