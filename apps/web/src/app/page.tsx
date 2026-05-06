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
import { Bot, LayoutGrid, GitBranch, Search, ArrowUpDown } from 'lucide-react';

type SortKey = 'boss-first' | 'name' | 'recent' | 'status';
const SORT_LABELS: Record<SortKey, string> = {
  'boss-first': 'Boss first',
  'name': 'A → Z',
  'recent': 'Recently active',
  'status': 'Status',
};
const STATUS_RANK: Record<string, number> = { running: 0, error: 1, stopped: 2, stale: 3 };

// Deterministic avatar palette — pairs of colors that feel calm together.
// Picked to read on both light and dark surface; saturation kept moderate.
const AVATAR_PALETTES = [
  ['#fb923c', '#f59e0b'], // orange
  ['#34d399', '#059669'], // emerald
  ['#60a5fa', '#2563eb'], // blue
  ['#a78bfa', '#7c3aed'], // violet
  ['#f472b6', '#db2777'], // pink
  ['#fbbf24', '#d97706'], // amber
  ['#22d3ee', '#0891b2'], // cyan
  ['#f87171', '#dc2626'], // red
  ['#4ade80', '#16a34a'], // green
  ['#94a3b8', '#475569'], // slate
];
function avatarPalette(name: string): [string, string] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTES[Math.abs(h) % AVATAR_PALETTES.length] as [string, string];
}

function relativeTime(iso?: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!t) return null;
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
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

interface ClaudeStatus {
  status: 'connected' | 'disconnected' | 'expired';
  source?: string;
  expiresIn?: string;
  error?: string;
}

export default function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('Welcome to SlackHive');
  const [view, setView] = useState<'hierarchy' | 'grid'>('hierarchy');
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
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
    fetch('/api/system/claude-status').then(r => r.json()).then(setClaudeStatus).catch(() => {});
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
      .then(setAgents)
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
    <div style={{ padding: '32px 40px', maxWidth: 1440 }} className="fade-up responsive-pad">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{
            margin: 0, fontSize: 26, fontWeight: 700,
            letterSpacing: '-0.03em', color: 'var(--text)',
          }}>
            {title}
          </h1>
          <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 14 }}>
            {loading ? 'Loading agents…' : `${running} of ${total} agent${total !== 1 ? 's' : ''} online`}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Claude Code status badge */}
          {claudeStatus && (
            <div style={{ position: 'relative' }}>
              <button onClick={() => setStatusOpen(!statusOpen)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '7px 12px', fontSize: 12,
                cursor: 'pointer', fontFamily: 'var(--font-sans)', color: 'var(--text)',
              }}>
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                  background: claudeStatus.status === 'connected' ? '#10b981'
                            : claudeStatus.status === 'expired' ? '#f59e0b'
                            : '#dc2626',
                }} />
                Claude {claudeStatus.status === 'connected' ? 'connected' : claudeStatus.status === 'expired' ? 'expired' : 'disconnected'}
              </button>
              {statusOpen && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 6,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: '12px 14px', minWidth: 260, zIndex: 100,
                  boxShadow: 'var(--shadow-md)', fontSize: 12,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontWeight: 600, color: 'var(--text)' }}>Claude Code Status</span>
                    <button onClick={() => setStatusOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0 }}>×</button>
                  </div>
                  <div style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
                    <div>Status: <strong style={{ color: 'var(--text)' }}>{claudeStatus.status}</strong></div>
                    {claudeStatus.source && <div>Source: <strong style={{ color: 'var(--text)' }}>{claudeStatus.source}</strong></div>}
                    {claudeStatus.expiresIn && <div>Expires in: <strong style={{ color: 'var(--text)' }}>{claudeStatus.expiresIn}</strong></div>}
                    {claudeStatus.status !== 'connected' && (
                      <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 6, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        Run on host: <code>claude login</code>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {/* View toggle */}
          {!loading && total > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center',
              background: 'var(--surface-2)', borderRadius: 8,
              padding: 3, gap: 2,
              border: '1px solid var(--border)',
            }}>
              <ViewBtn active={view === 'hierarchy'} onClick={() => setView('hierarchy')} title="Hierarchy">
                <GitBranch size={14} />
              </ViewBtn>
              <ViewBtn active={view === 'grid'} onClick={() => setView('grid')} title="Grid">
                <LayoutGrid size={14} />
              </ViewBtn>
            </div>
          )}
          {canEdit && (
            <Link href="/agents/new" style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              background: 'var(--accent)', color: 'var(--accent-fg)',
              padding: '10px 20px', borderRadius: 8,
              fontSize: 13.5, fontWeight: 500, textDecoration: 'none',
              boxShadow: 'var(--shadow-sm)',
              transition: 'opacity 0.15s, transform 0.15s',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.85'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
              New Agent
            </Link>
          )}
        </div>
      </div>

      {/* ── Inline stats strip ───────────────────────────────────────────── */}
      {!loading && total > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
          fontSize: 13, color: 'var(--muted)', marginBottom: 18,
        }}>
          <Stat n={total} label={`agent${total !== 1 ? 's' : ''}`} />
          <span style={{ color: 'var(--border-2)' }}>·</span>
          <Stat n={running} label="running" color="#059669" />
          <span style={{ color: 'var(--border-2)' }}>·</span>
          <Stat n={stopped} label="stopped" color={stopped > 0 ? '#a3a3a3' : undefined} />
          {bossCount > 0 && (
            <>
              <span style={{ color: 'var(--border-2)' }}>·</span>
              <Stat n={bossCount} label={bossCount === 1 ? 'boss' : 'bosses'} color="#d97706" />
            </>
          )}
        </div>
      )}

      {/* ── Sticky search + sort + tag filter bar ────────────────────────── */}
      {!loading && total > 0 && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 20,
          background: 'var(--bg)', paddingTop: 4, paddingBottom: 14, marginBottom: 18,
          borderBottom: '1px solid var(--border)',
          boxShadow: scrolled ? '0 4px 12px -8px rgba(0,0,0,0.12)' : 'none',
          transition: 'box-shadow 0.18s ease',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: allTags.length > 0 ? 12 : 0 }}>
            {/* Search */}
            <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
              <Search size={14} style={{
                position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--subtle)', pointerEvents: 'none',
              }} />
              <input
                type="search"
                placeholder="Search agents…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  width: '100%', height: 34, padding: '0 12px 0 34px',
                  fontSize: 13, color: 'var(--text)',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 8, outline: 'none',
                  fontFamily: 'var(--font-sans)',
                }}
              />
            </div>
            {/* Sort */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setSortOpen(!sortOpen)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  height: 34, padding: '0 12px',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 8, cursor: 'pointer',
                  fontSize: 12.5, color: 'var(--text)', fontFamily: 'var(--font-sans)',
                }}
              >
                <ArrowUpDown size={13} />
                {SORT_LABELS[sort]}
              </button>
              {sortOpen && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: 4, minWidth: 180, zIndex: 30,
                  boxShadow: 'var(--shadow-md)',
                }}>
                  {(Object.keys(SORT_LABELS) as SortKey[]).map(k => (
                    <button
                      key={k}
                      onClick={() => { setSort(k); setSortOpen(false); }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        padding: '7px 10px', fontSize: 12.5,
                        background: sort === k ? 'var(--surface-2)' : 'transparent',
                        color: 'var(--text)', border: 'none', borderRadius: 6,
                        cursor: 'pointer', fontWeight: sort === k ? 600 : 400,
                      }}
                    >{SORT_LABELS[k]}</button>
                  ))}
                </div>
              )}
            </div>
            {/* Match count */}
            <span style={{ fontSize: 12, color: 'var(--subtle)', marginLeft: 'auto' }}>
              {filteredAgents.length} of {total}
            </span>
          </div>
          {/* Tag chips */}
          {allTags.length > 0 && (
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
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
    </div>
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
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 30, height: 30, borderRadius: 6, border: 'none',
        background: active ? 'var(--surface)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--muted)',
        cursor: 'pointer',
        boxShadow: active ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
        transition: 'all 0.15s',
      }}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 56 }}>
      {bosses.map(boss => (
        <OrgTree key={boss.id} boss={boss} reports={reportMap.get(boss.id) ?? []} />
      ))}

      {standalone.length > 0 && (
        <div>
          <SectionLabel label="Independent" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {standalone.map(a => <AgentCard key={a.id} agent={a} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', color: 'var(--subtle)', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
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
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: n > 0 ? 'center' : 'flex-start' }}>
        <div style={{ width: bossW, maxWidth: '100%' }}>
          <AgentCard agent={boss} highlight />
        </div>

        {n > 0 && (
          <>
            {/* SVG connector: vertical stem + horizontal bar + stubs */}
            <svg
              width={Math.max(rowW, bossW)}
              height={V_DROP + STUB_H}
              style={{ display: 'block', overflow: 'visible' }}
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
            <div style={{
              display: 'flex', gap: CARD_GAP, alignItems: 'flex-start',
              width: Math.max(rowW, bossW),
            }}>
              {/* Offset so cards align under SVG stubs */}
              <div style={{
                display: 'flex', gap: CARD_GAP,
                marginLeft: (Math.max(rowW, bossW) - rowW) / 2,
              }}>
                {reports.map(agent => (
                  <div key={agent.id} style={{ width: CARD_W, flexShrink: 0 }}>
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
      <div style={{
        textAlign: 'center', padding: '48px 24px', color: 'var(--muted)',
        fontSize: 13, background: 'var(--surface)', borderRadius: 'var(--radius-lg)',
        border: '1px dashed var(--border)',
      }}>
        No agents match the current filters.
      </div>
    );
  }
  return (
    <>
      {label && (
        <div style={{
          fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
          color: 'var(--subtle)', textTransform: 'uppercase',
          marginBottom: 12, paddingLeft: 2,
        }}>
          {label}
        </div>
      )}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 12,
      }} className="stagger agent-grid">
        {agents.map(agent => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </>
  );
}

// ── Agent card ────────────────────────────────────────────────────────────────

function AgentCard({ agent, highlight, compact, multiReport }: {
  agent: Agent;
  highlight?: boolean;
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
  const visibleTags = tags.slice(0, 2);
  const overflowTags = tags.length - visibleTags.length;
  const modelShort = agent.model.replace('claude-', '').split('-20')[0];
  const [g1, g2] = avatarPalette(agent.name);
  const lastActive = relativeTime(agent.lastHeartbeat);
  const hasDescription = !!agent.description?.trim();

  return (
    <Link
      href={`/agents/${agent.slug}`}
      className="fade-up agent-card-v2"
      style={{
        display: 'block', textDecoration: 'none',
        background: agent.isBoss
          ? 'linear-gradient(135deg, var(--surface) 0%, rgba(217,119,6,0.04) 100%)'
          : 'var(--surface)',
        border: agent.isBoss
          ? '1px solid rgba(217,119,6,0.22)'
          : highlight ? '1.5px solid rgba(217,119,6,0.25)' : '1px solid var(--border)',
        borderRadius: 14,
        padding: compact ? '14px 14px 12px' : '14px 16px 12px',
        boxShadow: agent.isBoss || highlight
          ? '0 0 0 1px rgba(217,119,6,0.06), var(--shadow-sm)'
          : 'var(--shadow-sm)',
        transition: 'box-shadow 0.2s cubic-bezier(0.16,1,0.3,1), transform 0.2s cubic-bezier(0.16,1,0.3,1), border-color 0.2s',
        cursor: 'pointer',
        position: 'relative',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = agent.isBoss || highlight
          ? '0 0 0 1px rgba(217,119,6,0.18), var(--shadow-hover)'
          : 'var(--shadow-hover)';
        el.style.transform = 'translateY(-2px)';
        el.style.borderColor = agent.isBoss || highlight ? 'rgba(217,119,6,0.35)' : 'var(--border-2)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = agent.isBoss || highlight
          ? '0 0 0 1px rgba(217,119,6,0.06), var(--shadow-sm)'
          : 'var(--shadow-sm)';
        el.style.transform = 'translateY(0)';
        el.style.borderColor = agent.isBoss
          ? 'rgba(217,119,6,0.22)'
          : highlight ? 'rgba(217,119,6,0.25)' : 'var(--border)';
      }}
    >
      {/* Avatar + name + status row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: hasDescription ? 8 : 10 }}>
        <div style={{
          width: 44, height: 44,
          borderRadius: 12, flexShrink: 0,
          background: agent.isBoss
            ? 'linear-gradient(135deg, #171717 0%, #404040 100%)'
            : `linear-gradient(135deg, ${g1} 0%, ${g2} 100%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, fontWeight: 600,
          color: '#fff',
          textShadow: '0 1px 2px rgba(0,0,0,0.15)',
          position: 'relative',
        }}>
          {agent.name.charAt(0).toUpperCase()}
          {/* Status dot — bottom-right of avatar */}
          <span
            className={displayStatus === 'running' ? 'status-running' : ''}
            style={{
              position: 'absolute', bottom: -2, right: -2,
              width: 12, height: 12, borderRadius: '50%',
              background: color, border: '2px solid var(--surface)',
            }}
            title={statusLabel}
          />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{
              fontSize: 14, fontWeight: 600, color: 'var(--text)',
              letterSpacing: '-0.01em',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              minWidth: 0,
            }}>
              {agent.name}
            </span>
            {agent.isBoss && (
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
                background: 'rgba(217,119,6,0.12)', color: '#d97706',
                padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase',
                flexShrink: 0,
              }}>Boss</span>
            )}
            {multiReport && (
              <span style={{
                fontSize: 9, fontWeight: 600,
                background: 'rgba(99,102,241,0.1)', color: '#6366f1',
                padding: '1px 4px', borderRadius: 3,
                flexShrink: 0,
              }}>×2</span>
            )}
          </div>
          <div style={{
            fontSize: 11.5, color: 'var(--muted)',
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 2,
          }}>
            <span style={{ color, fontWeight: 500 }}>{statusLabel}</span>
            {displayStatus === 'running' && lastActive && (
              <>
                <span style={{ color: 'var(--border-2)' }}>·</span>
                <span>{lastActive}</span>
              </>
            )}
          </div>
        </div>
        {inProgress > 0 && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            fontSize: 10, fontWeight: 600, color: '#2563eb',
            background: 'rgba(37,99,235,0.08)',
            padding: '2px 6px', borderRadius: 4, flexShrink: 0,
          }}>
            <span className="status-running" style={{ width: 5, height: 5, borderRadius: '50%', background: '#2563eb' }} />
            {inProgress > 1 ? `×${inProgress}` : ''}
          </span>
        )}
      </div>

      {/* Description — only if present, no italic placeholder noise */}
      {hasDescription && (
        <p style={{
          margin: '0 0 10px', fontSize: 12, color: 'var(--muted)',
          lineHeight: 1.45,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }} title={agent.description}>
          {agent.description}
        </p>
      )}

      {/* Tags row + model badge — single line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minHeight: 18 }}>
        {visibleTags.map(tag => (
          <span key={tag} style={{
            fontSize: 10, fontWeight: 500, padding: '2px 6px', borderRadius: 4,
            background: 'var(--surface-2)', color: 'var(--muted)',
            border: '1px solid var(--border)',
            whiteSpace: 'nowrap',
          }}>{tag}</span>
        ))}
        {overflowTags > 0 && (
          <span style={{ fontSize: 10, color: 'var(--subtle)' }}>+{overflowTags}</span>
        )}
        <span style={{
          marginLeft: 'auto',
          fontSize: 10, color: 'var(--subtle)',
          fontFamily: 'var(--font-mono)',
          whiteSpace: 'nowrap',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          {modelShort}
          {agent.slackBotUserId && (
            <span style={{ color: '#059669' }} title={agent.slackBotHandle ? `@${agent.slackBotHandle}` : 'Slack connected'}>●</span>
          )}
        </span>
      </div>
    </Link>
  );
}

// ── Inline stat + filter chip helpers ─────────────────────────────────────────

function Stat({ n, label, color }: { n: number; label: string; color?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <strong style={{
        fontSize: 14, fontWeight: 700, color: color ?? 'var(--text)',
        fontVariantNumeric: 'tabular-nums',
      }}>{n}</strong>
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
      style={{
        flexShrink: 0,
        fontSize: 12, fontWeight: 500, padding: '4px 12px', borderRadius: 20,
        border: `1px solid ${active ? 'var(--text)' : 'var(--border-2)'}`,
        cursor: 'pointer',
        background: active ? 'var(--text)' : 'var(--surface)',
        color: active ? 'var(--surface)' : 'var(--muted)',
        transition: 'all 0.15s',
      }}
    >{children}</button>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonGrid() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
      {[1, 2, 3, 4, 5, 6].map(i => (
        <div key={i} style={{
          background: 'var(--surface)', borderRadius: 14, padding: '14px 16px 12px',
          border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
          opacity: 1 - (i - 1) * 0.12,
        }}>
          <div style={{ display: 'flex', gap: 11, marginBottom: 10 }}>
            <Skel w={44} h={44} r={12} />
            <div style={{ flex: 1, paddingTop: 4 }}>
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
    <div style={{
      width: w, height: h, borderRadius: r,
      background: 'var(--surface-2)', marginBottom: mb,
    }} />
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  const { canEdit } = useAuth();
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      minHeight: 400, gap: 20, textAlign: 'center',
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: 20,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)',
      }}>
        <Bot size={32} />
      </div>
      <div>
        <p style={{
          margin: '0 0 6px', fontSize: 18, fontWeight: 600,
          color: 'var(--text)', letterSpacing: '-0.02em',
        }}>
          No agents yet
        </p>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)', maxWidth: 300 }}>
          {canEdit ? 'Create your first Claude Code agent and connect it to Slack to get started.' : 'No agents have been configured yet. Ask an admin to set one up.'}
        </p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {canEdit && (
          <Link href="/agents/new" style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            background: 'var(--accent)', color: 'var(--accent-fg)',
            padding: '10px 22px', borderRadius: 8,
            fontSize: 14, fontWeight: 500, textDecoration: 'none',
            boxShadow: 'var(--shadow-sm)',
            transition: 'opacity 0.15s',
          }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            Create First Agent
          </Link>
        )}
        <a
          href="https://slackhive.mintlify.app/quickstart"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            color: 'var(--muted)', fontSize: 13, textDecoration: 'none',
            padding: '10px 14px', borderRadius: 8,
            transition: 'color 0.15s, background 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          Read the docs
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <path d="M6 3h7v7M13 3L5 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </a>
      </div>
    </div>
  );
}
