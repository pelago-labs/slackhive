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

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Activity as ActivityIcon, Coins, ShieldAlert, Wrench, ThumbsUp, ThumbsDown, Layers, Lock, ArrowRight, ExternalLink } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { FilterRow, parseWindowKey, timeParams, type WindowKey } from '../activity/_components/FilterRow';
import { formatTokens } from '../activity/_components/formatTokens';

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
interface ToolStat { name: string; calls: number; errors: number }
interface SessionRow {
  sessionId: string; summary: string | null; initiatorHandle: string | null; agentIds: string[];
  turns: number; inputTokens: number; outputTokens: number;
  status: 'active' | 'done' | 'error'; sensitive: boolean;
  feedbackUp: number; feedbackDown: number; startedAt: string; lastActivityAt: string;
}

interface InsightsResponse {
  scope: 'all' | 'agent' | 'session';
  agent?: string | null; session?: string; billing: boolean;
  rollup: Rollup | null;
  byAgent?: AgentTokens[]; powerUsers?: PowerUser[] | null;
  events?: SensEvent[]; flows?: SensFlow[]; tools?: ToolStat[]; sessions?: SessionRow[];
  models?: { model: string; turns: number; tokens: number }[]; agentIds?: string[];
}

type TabKey = 'overview' | 'tokens' | 'sensitive' | 'tools' | 'feedback' | 'sessions';
const SEV_COLOR: Record<Severity, string> = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#0891b2' };

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' };

export default function InsightsPage(): React.JSX.Element {
  return <Suspense fallback={null}><Body /></Suspense>;
}

function Body(): React.JSX.Element {
  const sp = useSearchParams();
  const router = useRouter();
  const { role } = useAuth();
  const isSuper = role === 'superadmin';

  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [agentFilter, setAgentFilter] = useState(sp?.get('agent') ?? '');
  const [from, setFrom] = useState(sp?.get('from') ?? '');
  const [to, setTo] = useState(sp?.get('to') ?? '');
  const [windowKey, setWindowKey] = useState<WindowKey>(parseWindowKey(sp?.get('window') ?? (sp?.get('from') && sp?.get('to') ? 'custom' : '24h')));
  const [tab, setTab] = useState<TabKey>((sp?.get('tab') as TabKey) || 'overview');
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const tabs: { key: TabKey; label: string; Icon: typeof ActivityIcon; superOnly?: boolean }[] = [
    { key: 'overview', label: 'Overview', Icon: ActivityIcon },
    { key: 'tokens', label: 'Tokens & Cost', Icon: Coins, superOnly: true },
    { key: 'sensitive', label: 'Sensitive', Icon: ShieldAlert },
    { key: 'tools', label: 'Tools', Icon: Wrench },
    { key: 'feedback', label: 'Feedback', Icon: ThumbsUp },
    { key: 'sessions', label: 'Sessions', Icon: Layers },
  ];
  const visibleTabs = tabs.filter(t => !t.superOnly || isSuper);
  const activeTab = visibleTabs.some(t => t.key === tab) ? tab : 'overview';

  return (
    <div style={{ padding: '36px 40px', maxWidth: 1600, margin: '0 auto' }} className="fade-up">
      <div style={{ marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>
          {scope === 'agent' ? `Observability · ${agentName.get(agentFilter) ?? 'Agent'}` : 'Observability'}
        </h1>
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
        Tokens, cost, sensitive data, tools, feedback and sessions across your agents.
      </div>

      {(
        <>
          <FilterRow
            agents={agents} agentFilter={agentFilter} windowKey={windowKey}
            onAgentChange={setAgentFilter} onWindowChange={setWindowKey}
            from={from} to={to} onRangeChange={(f, t) => { setFrom(f); setTo(t); }}
          />
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
            {visibleTabs.map(t => {
              const on = t.key === activeTab;
              return (
                <button key={t.key} onClick={() => setTab(t.key)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8,
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, cursor: 'pointer',
                  background: on ? 'var(--surface-2)' : 'var(--surface)', color: on ? 'var(--text)' : 'var(--muted)',
                  fontSize: 12.5, fontWeight: on ? 600 : 500, fontFamily: 'var(--font-sans)',
                }}><t.Icon size={13} /> {t.label}</button>
              );
            })}
          </div>

          {loading && !data ? <Muted>Loading…</Muted>
            : error ? <Muted>{error}</Muted>
            : !data ? <Muted>No data.</Muted>
            : activeTab === 'overview' ? <Overview data={data} agentName={agentName} isSuper={isSuper} onTab={setTab} />
            : activeTab === 'tokens' ? <Tokens data={data} agentName={agentName} isSuper={isSuper} />
            : activeTab === 'sensitive' ? <Sensitive events={data.events ?? []} flows={data.flows ?? []} />
            : activeTab === 'tools' ? <Tools tools={data.tools ?? []} />
            : activeTab === 'feedback' ? <Feedback r={data.rollup} scope={scope} />
            : <Sessions sessions={data.sessions ?? []} agentName={agentName} isSuper={isSuper} />}
        </>
      )}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ ...card, color: 'var(--muted)', fontSize: 13 }}>{children}</div>;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ ...card, minWidth: 120, flex: '1 1 120px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function fmtMs(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`; }
function fmtCost(n: number): string { return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`; }

function Bars({ rows, max }: { rows: { label: string; value: number; sub: string }[]; max: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '150px 1fr auto', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(3, max ? (r.value / max) * 100 : 0)}%`, height: '100%', background: 'var(--accent-2, #404040)', opacity: 0.75 }} />
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{r.sub}</span>
        </div>
      ))}
    </div>
  );
}

// ── Table primitive + cell helpers ───────────────────────────────────────────

function relativeTime(isoLike: string): string {
  const ts = Date.parse(isoLike.replace(' ', 'T') + 'Z');
  if (Number.isNaN(ts)) return '';
  const s = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface Col<T> { label: string; align?: 'left' | 'right' | 'center'; width?: string; render: (row: T) => React.ReactNode }

function Table<T>({ cols, rows, rowHref, empty }: { cols: Col<T>[]; rows: T[]; rowHref?: (r: T) => string; empty: string }) {
  const router = useRouter();
  if (rows.length === 0) return <div style={{ padding: '14px 4px', color: 'var(--muted)', fontSize: 12.5 }}>{empty}</div>;
  const th: React.CSSProperties = { textAlign: 'left', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--subtle)', padding: '6px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { fontSize: 12.5, color: 'var(--text)', padding: '8px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)' }}>
        <thead><tr>{cols.map((c, i) => <th key={i} style={{ ...th, textAlign: c.align ?? 'left', width: c.width }}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, ri) => {
            const href = rowHref?.(row);
            return (
              <tr key={ri} className={href ? 'trace-node' : undefined}
                onClick={href ? () => router.push(href) : undefined}
                style={{ cursor: href ? 'pointer' : 'default' }}>
                {cols.map((c, ci) => <td key={ci} style={{ ...td, textAlign: c.align ?? 'left' }}>{c.render(row)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatePill({ status }: { status: 'active' | 'done' | 'error' }) {
  const c = status === 'error' ? '#dc2626' : status === 'active' ? '#2563eb' : '#16a34a';
  const label = status === 'active' ? 'Running' : status === 'error' ? 'Error' : 'OK';
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: c }}>
    <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />{label}</span>;
}

function FeedbackCell({ up, down }: { up: number; down: number }) {
  if (up + down === 0) return <span style={{ color: 'var(--subtle)' }}>—</span>;
  return <span style={{ display: 'inline-flex', gap: 10, fontSize: 12 }}>
    {up > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#16a34a' }}><ThumbsUp size={12} />{up}</span>}
    {down > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#dc2626' }}><ThumbsDown size={12} />{down}</span>}
  </span>;
}

function SevBadge({ s }: { s: Severity }) {
  return <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 6, background: `${SEV_COLOR[s]}1a`, color: SEV_COLOR[s] }}>{s}</span>;
}

function truncate(str: string, n: number): string { return str.length > n ? str.slice(0, n - 1) + '…' : str; }

function Overview({ data, agentName, isSuper, onTab }: { data: InsightsResponse; agentName: Map<string, string>; isSuper: boolean; onTab: (t: TabKey) => void }) {
  const r = data.rollup;
  if (!r) return <Muted>No activity in this window.</Muted>;
  const up = r.feedbackUp ?? 0, down = r.feedbackDown ?? 0;
  const sat = up + down > 0 ? Math.round((up / (up + down)) * 100) : null;
  const topTools = r.topTools ?? [];
  const tokDays = r.tokensByDay ?? [];
  const maxDay = Math.max(1, ...tokDays.map(d => d.input + d.output));
  const sessions = (data.sessions ?? []).slice(0, 6);
  const events = [...(data.events ?? [])].sort((a, b) => b.startMs - a.startMs).slice(0, 6);
  const sectionTitle = (label: string, t?: TabKey): React.ReactNode => (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      {t && <button onClick={() => onTab(t)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11.5, fontFamily: 'var(--font-sans)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>View all <ArrowRight size={11} /></button>}
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* KPI strip */}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Kpi label="Sessions" value={String(r.sessions ?? 0)} sub={`${r.turns} turns`} />
        <Kpi label="Errors" value={String(r.errorTurns ?? 0)} sub={r.turns ? `${Math.round(((r.errorTurns ?? 0) / r.turns) * 100)}% of turns` : '—'} />
        <Kpi label="Latency p50/p95" value={fmtMs(r.p50DurationMs)} sub={`p95 ${fmtMs(r.p95DurationMs)}`} />
        <Kpi label="Tool calls" value={String(r.toolCalls)} />
        <Kpi label="Sensitive" value={String(r.sensitiveEvents ?? 0)} sub="flagged events" />
        <Kpi label="Satisfaction" value={sat === null ? '—' : `${sat}%`} sub={`${up}↑ ${down}↓`} />
        {isSuper && <Kpi label="Tokens" value={formatTokens(r.totalTokens)} sub={`${formatTokens(r.inputTokens)} in · ${formatTokens(r.outputTokens)} out`} />}
        {isSuper && <Kpi label="Cost" value={fmtCost(r.costUsd)} sub="traced turns" />}
      </div>

      {/* Tokens per day (superadmin) */}
      {isSuper && tokDays.length > 1 && (
        <div style={card}>
          {sectionTitle('Tokens per day')}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 64 }}>
            {tokDays.map(d => {
              const total = d.input + d.output;
              return (
                <div key={d.date} title={`${d.date}: ${formatTokens(d.input)} in · ${formatTokens(d.output)} out`}
                  style={{ flex: 1, minWidth: 4, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                  <div style={{ width: '100%', height: `${Math.max(3, (total / maxDay) * 100)}%`, display: 'flex', flexDirection: 'column', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: `${total ? (d.output / total) * 100 : 0}%`, background: 'var(--text-2)' }} />
                    <div style={{ height: `${total ? (d.input / total) * 100 : 0}%`, background: 'var(--muted)' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Two-up: models + top tools */}
      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        {r.models.length > 0 && (
          <div style={card}>
            {sectionTitle('By model')}
            <Bars max={Math.max(1, ...r.models.map(m => isSuper ? m.tokens : m.turns))}
              rows={r.models.map(m => ({ label: m.model, value: isSuper ? m.tokens : m.turns, sub: isSuper ? `${formatTokens(m.tokens)} tok` : `${m.turns} turns` }))} />
          </div>
        )}
        {topTools.length > 0 && (
          <div style={card}>
            {sectionTitle('Top tools', 'tools')}
            <Bars max={Math.max(1, ...topTools.map(t => t.count))}
              rows={topTools.slice(0, 6).map(t => ({ label: t.name, value: t.count, sub: `${t.count}${t.errors ? ` · ${t.errors} err` : ''}` }))} />
          </div>
        )}
      </div>

      {/* Recent sessions */}
      {sessions.length > 0 && (
        <div style={card}>
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
        <div style={card}>
          {sectionTitle('Recent sensitive activity', 'sensitive')}
          <Table<SensEvent> rows={events} empty="" rowHref={e => `/activity/${encodeURIComponent(e.sessionId)}?span=${encodeURIComponent(e.spanId)}`}
            cols={[
              { label: 'Severity', render: e => e.severity ? <SevBadge s={e.severity} /> : <Subtle>—</Subtle> },
              { label: 'Type', render: e => <Mono>{e.reason ?? ''}</Mono> },
              { label: 'Where', render: e => <code style={{ fontSize: 12, fontWeight: 600 }}>{e.toolName ?? 'response'}</code> },
              { label: 'When', align: 'right', render: e => <Subtle>{relativeTime(new Date(e.startMs).toISOString())}</Subtle> },
            ]} />
        </div>
      )}
    </div>
  );
}

function Tokens({ data, agentName, isSuper }: { data: InsightsResponse; agentName: Map<string, string>; isSuper: boolean }) {
  if (!isSuper) return <DeniedCard />;
  const byAgent = (data.byAgent ?? []).slice().sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
  const power = data.powerUsers ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Tokens by agent</div>
        <Table<AgentTokens> rows={byAgent} empty="No token usage in this window."
          cols={[
            { label: 'Agent', render: a => <span style={{ fontWeight: 500 }}>{agentName.get(a.agentId) ?? a.agentId}</span> },
            { label: 'Input', align: 'right', render: a => <Mono>{formatTokens(a.inputTokens)}</Mono> },
            { label: 'Output', align: 'right', render: a => <Mono>{formatTokens(a.outputTokens)}</Mono> },
            { label: 'Total', align: 'right', render: a => <Mono>{formatTokens(a.inputTokens + a.outputTokens)}</Mono> },
            { label: 'Turns', align: 'right', render: a => <Mono>{a.turnCount}</Mono> },
          ]} />
      </div>
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Power users</div>
        <Table<PowerUser> rows={power} empty="No users in this window."
          cols={[
            { label: '#', width: '32px', render: (_u: PowerUser) => <span /> },
            { label: 'User', render: u => <span>@{u.handle ?? 'unknown'}</span> },
            { label: 'Tasks', align: 'right', render: u => <Mono>{u.taskCount}</Mono> },
            { label: 'Turns', align: 'right', render: u => <Mono>{u.turnCount}</Mono> },
            { label: 'Tokens', align: 'right', render: u => <Mono>{formatTokens(u.totalTokens)}</Mono> },
          ]} />
      </div>
    </div>
  );
}

function Sensitive({ events, flows }: { events: SensEvent[]; flows: SensFlow[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {flows.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Exfiltration flows</div>
          <Table<SensFlow> rows={flows} empty="" rowHref={f => `/activity/${encodeURIComponent(f.sessionId ?? '')}?span=${encodeURIComponent(f.sinkSpanId)}`}
            cols={[
              { label: 'Severity', render: f => <SevBadge s={f.severity} /> },
              { label: 'Kind', render: f => <span style={{ fontWeight: 500 }}>{f.label}</span> },
              { label: 'Source → Sink', render: f => <Mono>{f.sourceLabel} → {f.sinkLabel}</Mono> },
              { label: 'When', align: 'right', render: f => <Subtle>{relativeTime(new Date(f.startMs).toISOString())}</Subtle> },
            ]} />
        </div>
      )}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Sensitive access</div>
        <Table<SensEvent> rows={[...events].sort((a, b) => b.startMs - a.startMs)} empty="Nothing flagged in this window."
          rowHref={e => `/activity/${encodeURIComponent(e.sessionId)}?span=${encodeURIComponent(e.spanId)}`}
          cols={[
            { label: 'Severity', render: e => e.severity ? <SevBadge s={e.severity} /> : <Subtle>—</Subtle> },
            { label: 'Type', render: e => <Mono>{e.reason ?? ''}</Mono> },
            { label: 'Where', render: e => <code style={{ fontSize: 12, fontWeight: 600 }}>{e.toolName ?? 'response'}</code> },
            { label: 'Source', render: e => e.caughtByLlm
              ? <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 6, background: 'rgba(124,58,237,0.12)', color: '#7c3aed' }}>Caught by LLM</span>
              : <Subtle>regex</Subtle> },
            { label: 'Agent', render: e => <Subtle>{e.agentName ?? ''}</Subtle> },
            { label: 'When', align: 'right', render: e => <Subtle>{relativeTime(new Date(e.startMs).toISOString())}</Subtle> },
          ]} />
      </div>
    </div>
  );
}

function Tools({ tools }: { tools: ToolStat[] }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Tools</div>
      <Table<ToolStat> rows={[...tools].sort((a, b) => b.calls - a.calls)} empty="No tool calls in this window."
        cols={[
          { label: 'Tool', render: t => <code style={{ fontSize: 12, fontWeight: 600 }}>{t.name}</code> },
          { label: 'Calls', align: 'right', render: t => <Mono>{t.calls}</Mono> },
          { label: 'Errors', align: 'right', render: t => <span style={{ fontFamily: 'var(--font-mono)', color: t.errors ? '#dc2626' : 'var(--subtle)' }}>{t.errors}</span> },
          { label: 'Error rate', align: 'right', render: t => <Mono>{t.calls ? `${Math.round((t.errors / t.calls) * 100)}%` : '0%'}</Mono> },
        ]} />
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) { return <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{children}</span>; }
function Subtle({ children }: { children: React.ReactNode }) { return <span style={{ color: 'var(--subtle)' }}>{children}</span>; }

function Feedback({ r, scope }: { r: Rollup | null; scope: string }) {
  if (!r) return <Muted>No feedback in this window.</Muted>;
  const up = r.feedbackUp ?? 0, down = r.feedbackDown ?? 0;
  const total = up + down;
  const pct = total ? Math.round((up / total) * 100) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={card}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)' }}>Satisfaction</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
          <span style={{ fontSize: 32, fontWeight: 700, color: 'var(--text)' }}>{pct === null ? '—' : `${pct}%`}</span>
          <span style={{ display: 'inline-flex', gap: 14, fontSize: 13, color: 'var(--muted)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ThumbsUp size={14} style={{ color: '#16a34a' }} /> {up}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ThumbsDown size={14} style={{ color: '#dc2626' }} /> {down}</span>
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--subtle)', marginTop: 8 }}>
          {scope === 'all' ? 'Select a single agent to see individual ratings.' : 'Lifetime ratings for this agent.'}
        </div>
      </div>
    </div>
  );
}

function Sessions({ sessions, agentName, isSuper }: { sessions: SessionRow[]; agentName: Map<string, string>; isSuper: boolean }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(s =>
      (s.summary ?? '').toLowerCase().includes(needle) ||
      (s.initiatorHandle ?? '').toLowerCase().includes(needle) ||
      s.agentIds.some(id => (agentName.get(id) ?? '').toLowerCase().includes(needle)));
  }, [sessions, q, agentName]);
  const names = (ids: string[]) => ids.map(id => agentName.get(id) ?? id).join(', ');
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Sessions</div>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search sessions…" style={{
          marginLeft: 'auto', width: 220, padding: '6px 10px', fontSize: 12.5, borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontFamily: 'var(--font-sans)',
        }} />
        <span style={{ fontSize: 11.5, color: 'var(--subtle)' }}>{filtered.length}</span>
      </div>
      <Table<SessionRow> rows={filtered} empty="No sessions in this window." rowHref={s => `/activity/${encodeURIComponent(s.sessionId)}`}
        cols={[
          { label: 'Request', render: s => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {s.sensitive && <ShieldAlert size={12} style={{ color: '#b45309', flexShrink: 0 }} />}
              <span title={s.summary ?? ''}>{truncate(s.summary || '(no summary)', 60)}</span>
            </span>
          ) },
          { label: 'Agent', render: s => <Subtle>{truncate(names(s.agentIds) || '—', 28)}</Subtle> },
          { label: 'Turns', align: 'right', render: s => <Mono>{s.turns}</Mono> },
          ...(isSuper ? [{ label: 'Tokens', align: 'right' as const, render: (s: SessionRow) => <Mono>{formatTokens(s.inputTokens + s.outputTokens)}</Mono> }] : []),
          { label: 'State', render: s => <StatePill status={s.status} /> },
          { label: 'Feedback', render: s => <FeedbackCell up={s.feedbackUp} down={s.feedbackDown} /> },
          { label: 'Updated', align: 'right', render: s => <Subtle>{relativeTime(s.lastActivityAt)}</Subtle> },
        ]} />
    </div>
  );
}

function DeniedCard(): React.JSX.Element {
  return (
    <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 12 }}>
      <Lock size={18} style={{ color: 'var(--muted)' }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Tokens & cost are superadmin-only</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Billing-adjacent data. Ask a superadmin if you need access.</div>
      </div>
    </div>
  );
}
