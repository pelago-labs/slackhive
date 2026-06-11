'use client';

/**
 * @fileoverview Tool drill-down — per-tool call + error counts for an agent,
 * each expandable to its aggregated error messages (identical text → count),
 * with a link into a sample session. Opened from the dashboard's "Top tools".
 *
 * @module web/app/activity/tools
 */

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Wrench, ArrowLeft, ChevronRight, ChevronDown, ArrowUpRight } from 'lucide-react';
import { FilterRow, parseWindowKey, timeParams, type WindowKey } from '../_components/FilterRow';

interface ToolErrorGroup { message: string; count: number; sampleSessionId: string | null }
interface ToolStat { name: string; calls: number; errors: number; errorGroups: ToolErrorGroup[] }
interface AgentLite { id: string; slug: string; name: string }

export default function ToolsPage(): React.JSX.Element {
  return <Suspense fallback={null}><Body /></Suspense>;
}

function Body(): React.JSX.Element {
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [tools, setTools] = useState<ToolStat[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [agentFilter, setAgentFilter] = useState(searchParams?.get('agent') ?? '');
  const [from, setFrom] = useState(searchParams?.get('from') ?? '');
  const [to, setTo] = useState(searchParams?.get('to') ?? '');
  const [windowKey, setWindowKey] = useState<WindowKey>(
    parseWindowKey(searchParams?.get('window') ?? (searchParams?.get('from') && searchParams?.get('to') ? 'custom' : null)),
  );
  const timeQs = () => timeParams(windowKey, from, to);

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then((rows: AgentLite[]) => setAgents(rows)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ ...timeQs() });
    if (agentFilter) params.set('agent', agentFilter);
    const r = await fetch(`/api/activity/tools?${params.toString()}`);
    if (r.ok) { const d = await r.json(); setTools(d.tools ?? []); }
    setLoaded(true);
  }, [agentFilter, windowKey, from, to]);

  useEffect(() => { load(); }, [load]);

  const maxCalls = Math.max(1, ...tools.map(t => t.calls));

  return (
    <div className="fade-up" style={{ padding: '36px 40px', maxWidth: 1100, margin: '0 auto' }}>
      <Link href="/activity" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', textDecoration: 'none' }}>
        <ArrowLeft size={13} /> Back to Activity
      </Link>
      <div style={{ margin: '14px 0 22px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Wrench size={19} /> Tools
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
          Tool usage and failures per agent — expand a tool to see its error messages.
        </p>
      </div>

      <FilterRow agents={agents} agentFilter={agentFilter} windowKey={windowKey} onAgentChange={setAgentFilter} onWindowChange={setWindowKey} from={from} to={to} onRangeChange={(f, t) => { setFrom(f); setTo(t); }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loaded && tools.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }}>
            No tool calls in this window.
          </div>
        )}
        {tools.map(t => <ToolRow key={t.name} tool={t} maxCalls={maxCalls} />)}
      </div>
    </div>
  );
}

function ToolRow({ tool, maxCalls }: { tool: ToolStat; maxCalls: number }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const hasErrors = tool.errors > 0;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div onClick={() => hasErrors && setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: hasErrors ? 'pointer' : 'default' }}>
        {hasErrors ? (open ? <ChevronDown size={14} style={{ color: 'var(--subtle)', flexShrink: 0 }} /> : <ChevronRight size={14} style={{ color: 'var(--subtle)', flexShrink: 0 }} />) : <span style={{ width: 14, flexShrink: 0 }} />}
        <code style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', flexShrink: 0, minWidth: 180, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.name}</code>
        <div style={{ flex: 1, height: 8, background: 'var(--surface-3, var(--border))', borderRadius: 4, overflow: 'hidden', maxWidth: 420 }}>
          <div style={{ width: `${Math.max(3, (tool.calls / maxCalls) * 100)}%`, height: '100%', background: 'var(--accent-2)', borderRadius: 4, opacity: 0.85 }} />
        </div>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 14, fontSize: 12, fontFamily: 'var(--font-mono, monospace)' }}>
          <span style={{ color: 'var(--muted)' }}>{tool.calls} calls</span>
          <span style={{ color: hasErrors ? 'var(--red)' : 'var(--subtle)', minWidth: 56, textAlign: 'right' }}>{tool.errors} err</span>
        </div>
      </div>
      {open && hasErrors && (
        <div style={{ padding: '0 16px 14px 42px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)', margin: '2px 0 4px' }}>Error messages</div>
          {tool.errorGroups.map((g, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 6, borderLeft: '2px solid var(--red)' }}>
              <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--font-mono, monospace)', minWidth: 28 }}>{g.count}×</span>
              <pre style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 120, overflow: 'auto' }}>{g.message}</pre>
              {g.sampleSessionId && (
                <Link href={`/activity/${encodeURIComponent(g.sampleSessionId)}`} title="View a session with this error" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 500, color: 'var(--accent)', textDecoration: 'none' }}>
                  session <ArrowUpRight size={12} />
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
