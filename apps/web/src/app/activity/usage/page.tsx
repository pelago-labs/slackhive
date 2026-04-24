'use client';

/**
 * @fileoverview Token-usage dashboard — totals strip, per-agent bar chart,
 * top-users leaderboard. All driven by the shared FilterRow's agent/window
 * controls. Reads `/api/activity/usage` on filter changes; no polling.
 *
 * @module web/app/activity/usage
 */

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { BarChart3, ExternalLink, Lock, RefreshCw } from 'lucide-react';
import { TabSwitcher } from '../_components/TabSwitcher';
import { FilterRow, type WindowKey } from '../_components/FilterRow';
import { formatTokens } from '../_components/formatTokens';

interface AgentLite { id: string; slug: string; name: string }

interface AgentTokenUsage {
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turnCount: number;
}

interface UserActivitySummary {
  userId: string;
  handle: string | null;
  taskCount: number;
  turnCount: number;
  totalTokens: number;
}

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turnCount: number;
}

interface UsageResponse {
  byAgent: AgentTokenUsage[];
  byUser: UserActivitySummary[];
  totals: Totals;
}

const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';

const headerButtonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 10px', fontSize: 12, fontWeight: 500,
  color: 'var(--muted)', background: 'var(--surface)',
  border: '1px solid var(--border)', borderRadius: 8,
  cursor: 'pointer', fontFamily: 'var(--font-sans)',
  textDecoration: 'none', whiteSpace: 'nowrap',
};

const sectionStyle: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 12, padding: '14px 16px',
};

export default function UsagePage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <UsagePageBody />
    </Suspense>
  );
}

function UsagePageBody(): React.JSX.Element {
  const searchParams = useSearchParams();

  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [agentFilter, setAgentFilter] = useState<string>(searchParams?.get('agent') ?? '');
  const [windowKey, setWindowKey] = useState<WindowKey>(
    ((): WindowKey => {
      const w = searchParams?.get('window');
      return w === '1h' || w === '5h' || w === '24h' || w === '7d' || w === '30d' ? w : '5h';
    })(),
  );
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then((rows: AgentLite[]) => setAgents(rows)).catch(() => {});
  }, []);

  const agentById = useMemo(() => {
    const m = new Map<string, AgentLite>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ window: windowKey });
    if (agentFilter) params.set('agent', agentFilter);
    try {
      const r = await fetch(`/api/activity/usage?${params.toString()}`);
      if (r.status === 403) {
        setDenied(true);
        setData(null);
        return;
      }
      setDenied(false);
      if (r.ok) setData(await r.json());
    } finally {
      setLoading(false);
    }
  }, [agentFilter, windowKey]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="fade-up" style={{ padding: '36px 40px', maxWidth: 1600, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <BarChart3 size={20} /> Activity
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Token usage across your agents and team.
          </p>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <a
            href={CLAUDE_USAGE_URL}
            target="_blank"
            rel="noreferrer"
            title="Check remaining quota on Anthropic"
            style={headerButtonStyle}
          >
            Check remaining <ExternalLink size={12} />
          </a>
          <button
            onClick={load}
            disabled={loading}
            title="Refresh"
            style={{
              ...headerButtonStyle,
              cursor: loading ? 'wait' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      <TabSwitcher />

      {denied ? (
        <AccessDeniedCard />
      ) : (
        <>
          <TotalsStrip totals={data?.totals ?? null} windowLabel={windowLabel(windowKey)} />

          <div style={{ marginTop: 14 }}>
            <FilterRow
              agents={agents}
              agentFilter={agentFilter}
              windowKey={windowKey}
              onAgentChange={setAgentFilter}
              onWindowChange={setWindowKey}
            />
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)',
            gap: 14, marginTop: 14,
          }}>
            <AgentBars byAgent={data?.byAgent ?? null} agentById={agentById} loading={loading && !data} />
            <PowerUsers byUser={data?.byUser ?? null} loading={loading && !data} />
          </div>
        </>
      )}
    </div>
  );
}

function windowLabel(w: WindowKey): string {
  return w === '1h' ? 'last hour'
       : w === '5h' ? 'last 5 hours'
       : w === '24h' ? 'last 24 hours'
       : w === '7d' ? 'last 7 days'
       : 'last 30 days';
}

function AccessDeniedCard(): React.JSX.Element {
  return (
    <section style={{
      ...sectionStyle,
      textAlign: 'center',
      padding: '32px 16px',
    }}>
      <div style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 40, height: 40, borderRadius: '50%',
        background: 'var(--surface-2)', marginBottom: 12,
        color: 'var(--muted)',
      }}>
        <Lock size={18} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
        Usage is superadmin-only
      </div>
      <div style={{ fontSize: 12, color: 'var(--subtle)', maxWidth: 420, margin: '0 auto' }}>
        Token usage and the power-user leaderboard contain billing-adjacent
        data. Ask a superadmin if you need access.
      </div>
    </section>
  );
}

function TotalsStrip(props: { totals: Totals | null; windowLabel: string }): React.JSX.Element {
  const { totals, windowLabel } = props;
  const t = totals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turnCount: 0 };
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
      gap: 10,
    }}>
      <TotalCard label="Input"          value={formatTokens(t.inputTokens)}         sub={windowLabel} />
      <TotalCard label="Output"         value={formatTokens(t.outputTokens)}        sub={windowLabel} />
      <TotalCard label="Cache read"     value={formatTokens(t.cacheReadTokens)}     sub={windowLabel} />
      <TotalCard label="Cache written"  value={formatTokens(t.cacheCreationTokens)} sub={windowLabel} />
      <TotalCard label="Turns"          value={String(t.turnCount)}                 sub={windowLabel} />
    </div>
  );
}

function TotalCard(props: { label: string; value: string; sub?: string }): React.JSX.Element {
  const { label, value, sub } = props;
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 14px',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
        color: 'var(--subtle)', textTransform: 'uppercase',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em',
        color: 'var(--text)', marginTop: 4, lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function AgentBars(props: {
  byAgent: AgentTokenUsage[] | null;
  agentById: Map<string, AgentLite>;
  loading: boolean;
}): React.JSX.Element {
  const { byAgent, agentById, loading } = props;
  const rows = byAgent ?? [];
  const max = rows.reduce((m, r) => Math.max(m, r.inputTokens + r.outputTokens), 0);

  return (
    <section style={sectionStyle}>
      <SectionHeader title="By agent" subtitle="sorted by input + output tokens" />
      {loading && <EmptyRow text="Loading…" />}
      {!loading && rows.length === 0 && <EmptyRow text="No agent activity in this window." />}
      {!loading && rows.map(row => {
        const total = row.inputTokens + row.outputTokens;
        const pct = max > 0 ? Math.round((total / max) * 100) : 0;
        const name = agentById.get(row.agentId)?.name ?? row.agentId.slice(0, 8);
        return (
          <div key={row.agentId} style={{
            display: 'grid', gridTemplateColumns: '150px 1fr auto', alignItems: 'center',
            gap: 10, padding: '8px 0',
          }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </div>
            <div style={{ position: 'relative', height: 8, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{
                position: 'absolute', inset: 0, width: `${pct}%`,
                background: 'var(--text)', opacity: 0.7,
                borderRadius: 4, transition: 'width 0.2s',
              }} />
            </div>
            <div style={{
              fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}>
              {formatTokens(row.inputTokens)} in · {formatTokens(row.outputTokens)} out · {row.turnCount} turn{row.turnCount === 1 ? '' : 's'}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function PowerUsers(props: {
  byUser: UserActivitySummary[] | null;
  loading: boolean;
}): React.JSX.Element {
  const { byUser, loading } = props;
  const rows = byUser ?? [];
  return (
    <section style={sectionStyle}>
      <SectionHeader title="Power users" subtitle="ranked by tasks started" />
      {loading && <EmptyRow text="Loading…" />}
      {!loading && rows.length === 0 && <EmptyRow text="No user activity in this window." />}
      {!loading && rows.map((row, i) => (
        <div key={row.userId} style={{
          display: 'grid', gridTemplateColumns: '22px 1fr auto', alignItems: 'center',
          gap: 10, padding: '8px 0',
        }}>
          <div style={{ fontSize: 12, color: 'var(--subtle)', fontVariantNumeric: 'tabular-nums' }}>
            {i + 1}.
          </div>
          <div
            title={row.handle ? undefined : row.userId}
            style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            @{row.handle ?? 'unknown'}
          </div>
          <div style={{
            fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}>
            {row.taskCount} task{row.taskCount === 1 ? '' : 's'} · {row.turnCount} turn{row.turnCount === 1 ? '' : 's'} · {formatTokens(row.totalTokens)} tok
          </div>
        </div>
      ))}
    </section>
  );
}

function SectionHeader(props: { title: string; subtitle?: string }): React.JSX.Element {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{props.title}</div>
      {props.subtitle && <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 2 }}>{props.subtitle}</div>}
    </div>
  );
}

function EmptyRow(props: { text: string }): React.JSX.Element {
  return (
    <div style={{
      padding: '18px 4px', fontSize: 12, color: 'var(--subtle)', textAlign: 'center',
    }}>
      {props.text}
    </div>
  );
}
