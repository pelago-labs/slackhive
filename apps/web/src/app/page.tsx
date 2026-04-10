'use client';

/**
 * @fileoverview Dashboard — agent fleet overview.
 * Shows agent hierarchy by default (boss → reports) with grid toggle.
 *
 * @module web/app/page
 */

import { useEffect, useState } from 'react';
import type { Agent } from '@slackhive/shared';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { Bot, LayoutGrid, GitBranch } from 'lucide-react';

const STATUS_COLOR: Record<string, string> = {
  running: '#059669',
  stopped: '#a3a3a3',
  error:   '#dc2626',
};

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  error:   'Error',
};

export default function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('Welcome to SlackHive');
  const [view, setView] = useState<'hierarchy' | 'grid'>('hierarchy');
  const { canEdit } = useAuth();

  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then(setAgents)
      .finally(() => setLoading(false));
    fetch('/api/settings')
      .then(r => r.json())
      .then((s: Record<string, string>) => { if (s.dashboardTitle) setTitle(s.dashboardTitle); })
      .catch(() => {});
  }, []);

  const running = agents.filter(a => a.status === 'running').length;
  const stopped = agents.filter(a => a.status === 'stopped').length;
  const total   = agents.length;
  const bossCount = agents.filter(a => a.isBoss).length;

  const hasHierarchy = agents.some(a => a.isBoss) || agents.some(a => a.reportsTo?.length > 0);

  return (
    <div style={{ padding: '36px 40px', maxWidth: 1200 }} className="fade-up responsive-pad">

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

      {/* ── Stats ────────────────────────────────────────────────────────── */}
      {!loading && total > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 32 }} className="stagger stats-grid">
          <StatCard label="Total" value={total} sub={`${total} agent${total !== 1 ? 's' : ''} registered`} />
          <StatCard label="Running" value={running} color="#059669" sub={running > 0 ? 'All systems healthy' : 'None active'} />
          <StatCard label="Stopped" value={stopped} color="#a3a3a3" sub={stopped > 0 ? `${stopped} offline` : 'All online'} />
          <StatCard label="Boss" value={bossCount || '—'} color="#d97706" sub={bossCount > 0 ? `${bossCount} orchestrator${bossCount > 1 ? 's' : ''} active` : 'No boss assigned'} />
        </div>
      )}

      {/* ── Content ──────────────────────────────────────────────────────── */}
      {loading ? (
        <SkeletonGrid />
      ) : total === 0 ? (
        <EmptyState />
      ) : view === 'hierarchy' && hasHierarchy ? (
        <HierarchyView agents={agents} />
      ) : (
        <GridView agents={agents} />
      )}
    </div>
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

function GridView({ agents, label = 'All Agents' }: { agents: Agent[]; label?: string }) {
  return (
    <>
      <div style={{
        fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
        color: 'var(--subtle)', textTransform: 'uppercase',
        marginBottom: 12, paddingLeft: 2,
      }}>
        {label}
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 14,
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
  const color = STATUS_COLOR[agent.status] ?? '#a3a3a3';

  return (
    <Link
      href={`/agents/${agent.slug}`}
      className="fade-up"
      style={{
        display: 'block', textDecoration: 'none',
        background: 'var(--surface)',
        border: highlight ? '1.5px solid rgba(217,119,6,0.25)' : 'none',
        borderRadius: 'var(--radius-lg)',
        padding: compact ? '14px 16px' : '22px 24px',
        boxShadow: highlight
          ? '0 0 0 1px rgba(217,119,6,0.12), var(--shadow-card)'
          : 'var(--shadow-card)',
        transition: 'box-shadow 0.2s cubic-bezier(0.16,1,0.3,1), transform 0.2s cubic-bezier(0.16,1,0.3,1)',
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = highlight
          ? '0 0 0 1px rgba(217,119,6,0.2), var(--shadow-hover)'
          : 'var(--shadow-hover)';
        el.style.transform = 'translateY(-3px)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = highlight
          ? '0 0 0 1px rgba(217,119,6,0.12), var(--shadow-card)'
          : 'var(--shadow-card)';
        el.style.transform = 'translateY(0)';
      }}
    >
      {/* Boss accent bar */}
      {agent.isBoss && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 2,
          background: 'linear-gradient(90deg, #d97706, #f59e0b)',
        }} />
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: compact ? 8 : 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            width: compact ? 30 : 36, height: compact ? 30 : 36,
            borderRadius: compact ? 8 : 10, flexShrink: 0,
            background: agent.isBoss ? '#171717' : 'var(--surface-2)',
            border: agent.isBoss ? 'none' : '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: compact ? 12 : 14, fontWeight: 600,
            color: agent.isBoss ? '#fff' : 'var(--text)',
          }}>
            {agent.name.charAt(0).toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: compact ? 13 : 14.5, fontWeight: 600, color: 'var(--text)',
                letterSpacing: '-0.01em',
              }}>
                {agent.name}
              </span>
              {agent.isBoss && (
                <span style={{
                  fontSize: 9.5, fontWeight: 600, letterSpacing: '0.04em',
                  background: 'rgba(217,119,6,0.1)', color: '#d97706',
                  padding: '2px 6px', borderRadius: 4,
                  textTransform: 'uppercase',
                }}>Boss</span>
              )}
              {multiReport && (
                <span style={{
                  fontSize: 9, fontWeight: 600, letterSpacing: '0.03em',
                  background: 'rgba(99,102,241,0.08)', color: '#6366f1',
                  padding: '2px 5px', borderRadius: 4,
                }}>×2 bosses</span>
              )}
            </div>
            <div style={{
              fontSize: 11.5, color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
            }}>
              @{agent.slug}
            </div>
          </div>
        </div>

        {/* Status */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          flexShrink: 0, marginTop: 2,
        }}>
          <div
            className={agent.status === 'running' ? 'status-running' : ''}
            style={{ width: 7, height: 7, borderRadius: '50%', background: color }}
          />
          <span style={{ fontSize: 11.5, color, fontWeight: 500 }}>
            {STATUS_LABEL[agent.status]}
          </span>
        </div>
      </div>

      {/* Description — hide in compact if no description */}
      {(!compact || agent.description) && (
        <p style={{
          margin: `0 0 ${compact ? 10 : 16}px`, fontSize: 12.5, color: 'var(--muted)',
          lineHeight: 1.55,
          display: '-webkit-box', WebkitLineClamp: compact ? 1 : 2,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
          minHeight: compact ? 'auto' : 38,
        }}>
          {agent.description || (
            <span style={{ color: 'var(--subtle)', fontStyle: 'italic' }}>No description</span>
          )}
        </p>
      )}

      {/* Footer */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: compact ? 10 : 14, borderTop: '1px solid var(--border)',
      }}>
        <span style={{
          fontSize: 11, color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          background: 'var(--surface-2)',
          padding: '2px 7px', borderRadius: 4,
        }}>
          {agent.model.replace('claude-', '').split('-20')[0]}
        </span>
        <span style={{
          fontSize: 11,
          color: agent.slackBotUserId ? '#059669' : 'var(--subtle)',
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          {agent.slackBotUserId ? (
            <>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#059669' }} />
              Connected
            </>
          ) : 'Not connected'}
        </span>
      </div>
    </Link>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, color, sub }: {
  label: string; value: number | string; color?: string; sub?: string;
}) {
  return (
    <div className="fade-up" style={{
      background: 'var(--surface)',
      border: 'none',
      borderRadius: 'var(--radius-lg)',
      padding: '20px 24px',
      boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, letterSpacing: '0.05em',
        color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 28, fontWeight: 700, color: color ?? 'var(--text)',
        letterSpacing: '-0.03em', lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: 'var(--subtle)', marginTop: 6 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonGrid() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
      {[1, 2, 3].map(i => (
        <div key={i} style={{
          background: 'var(--surface)', borderRadius: 'var(--radius-lg)', padding: '22px 24px',
          boxShadow: 'var(--shadow-card)', opacity: 1 - (i - 1) * 0.2,
        }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <Skel w={36} h={36} r={10} />
            <div style={{ flex: 1 }}>
              <Skel w="55%" h={15} r={5} mb={6} />
              <Skel w="35%" h={12} r={4} />
            </div>
          </div>
          <Skel w="100%" h={12} r={4} mb={6} />
          <Skel w="70%" h={12} r={4} />
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
    </div>
  );
}
