'use client';

/**
 * @fileoverview Sensitive-access audit feed — a chronological list of tool calls
 * the sensitivity monitor flagged (credential/DB access, PII, secrets, sensitive
 * data). Each row links into the session trace. Privacy-safe: shows category
 * tags only, never the matched value.
 *
 * @module web/app/activity/sensitive
 */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ShieldAlert, Database, KeyRound, UserRound, FileWarning, ExternalLink, ArrowLeft } from 'lucide-react';
import { FilterRow, parseWindowKey, timeParams, type WindowKey } from '../_components/FilterRow';
import { humanizeTag } from '@slackhive/shared';

interface SensitiveEvent {
  spanId: string; sessionId: string; activityId: string | null;
  agentId: string | null; agentName: string | null; toolName: string | null;
  categories: string[]; reason: string | null; startMs: number; sessionSummary: string | null;
}
interface AgentLite { id: string; slug: string; name: string }

const CAT_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  tool:   { label: 'Tool',   icon: <Database size={11} />,    color: '#2563eb' },
  data:   { label: 'Data',   icon: <FileWarning size={11} />, color: '#0891b2' },
  pii:    { label: 'PII',    icon: <UserRound size={11} />,   color: '#dc2626' },
  secret: { label: 'Secret', icon: <KeyRound size={11} />,    color: '#b45309' },
};

/** Parse the reason string into specific chips; fall back to the broad categories. */
function detailChips(reason: string | null, categories: string[]): { category: string; label: string }[] {
  const tags = (reason ?? '').split(',').map(t => t.trim()).filter(Boolean);
  if (tags.length) return tags.map(humanizeTag);
  return categories.map(c => ({ category: c, label: CAT_META[c]?.label ?? c }));
}

function relativeTime(ms: number): string {
  const s = Math.floor(Math.max(0, Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function SensitivePage(): React.JSX.Element {
  return <Suspense fallback={null}><Body /></Suspense>;
}

function Body(): React.JSX.Element {
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [events, setEvents] = useState<SensitiveEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [agentFilter, setAgentFilter] = useState(searchParams?.get('agent') ?? '');
  const [from, setFrom] = useState(searchParams?.get('from') ?? '');
  const [to, setTo] = useState(searchParams?.get('to') ?? '');
  const [windowKey, setWindowKey] = useState<WindowKey>(
    parseWindowKey(searchParams?.get('window') ?? (searchParams?.get('from') && searchParams?.get('to') ? 'custom' : null)),
  );
  const timeQs = () => timeParams(windowKey, from, to);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then((rows: AgentLite[]) => setAgents(rows)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ ...timeQs() });
    if (agentFilter) params.set('agent', agentFilter);
    const r = await fetch(`/api/activity/sensitive?${params.toString()}`);
    if (r.ok) { const body = await r.json(); setEvents(body.events ?? []); }
    setLoaded(true);
  }, [agentFilter, windowKey, from, to]);

  useEffect(() => {
    load();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(load, 8000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const agentById = useMemo(() => {
    const m = new Map<string, AgentLite>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  return (
    <div className="fade-up" style={{ padding: '36px 40px', maxWidth: 1100, margin: '0 auto' }}>
      <Link href="/activity" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', textDecoration: 'none' }}>
        <ArrowLeft size={13} /> Back to Activity
      </Link>
      <div style={{ margin: '14px 0 22px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
          <ShieldAlert size={20} /> Sensitive access
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
          Tool calls that touched credentials, databases, PII, or secrets — newest first.
        </p>
      </div>

      <FilterRow agents={agents} agentFilter={agentFilter} windowKey={windowKey} onAgentChange={setAgentFilter} onWindowChange={setWindowKey} from={from} to={to} onRangeChange={(f, t) => { setFrom(f); setTo(t); }} />

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {loaded && events.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No sensitive access in this window.
          </div>
        )}
        {events.map((e, i) => {
          const agent = (e.agentId && agentById.get(e.agentId)) || null;
          const chips = detailChips(e.reason, e.categories);
          // Deep-link to the exact offending tool call so the full (flag-gated)
          // args/result are one click away — that's where you see the actual value.
          const href = `/activity/${encodeURIComponent(e.sessionId)}?span=${encodeURIComponent(e.spanId)}`;
          return (
            <Link key={e.spanId} href={href}
              className="trace-node"
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', textDecoration: 'none', borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
              <ShieldAlert size={16} style={{ color: '#b45309', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <code style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>{e.toolName ?? 'response'}</code>
                  {chips.map((c, ci) => {
                    const m = CAT_META[c.category] ?? { label: c.label, icon: null, color: 'var(--muted)' };
                    return (
                      <span key={ci} title={`${c.category} match`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: `${m.color}1a`, color: m.color }}>
                        {m.icon}{c.label}
                      </span>
                    );
                  })}
                </div>
                <div style={{ marginTop: 3, fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agent?.name ?? (e.agentName ?? 'agent')}
                  {e.sessionSummary ? <span style={{ color: 'var(--subtle)' }}> · {e.sessionSummary}</span> : null}
                </div>
              </div>
              <span style={{ fontSize: 11, color: 'var(--subtle)', flexShrink: 0 }}>{relativeTime(e.startMs)}</span>
              <ExternalLink size={13} style={{ color: 'var(--subtle)', flexShrink: 0 }} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
