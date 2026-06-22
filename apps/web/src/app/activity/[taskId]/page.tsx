'use client';

/**
 * @fileoverview Session trace view — a Langfuse-style LLM trace for one Slack
 * thread. Header + analytics card (tokens / cost / latency p50-p95 / tool +
 * model breakdown + charts), then a conversation timeline: each turn shows who
 * sent it (user or delegating agent), the message, an expandable observation
 * tree (reasoning → tool calls → final answer) with per-step durations + full
 * content, and the final answer. Data comes from the OpenTelemetry span tree
 * persisted by the runner.
 *
 * @module web/app/activity/[taskId]
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { deepLinkLabelForPlatform } from '@slackhive/shared';
import {
  ArrowLeft, ExternalLink, ChevronRight, ChevronDown,
  Wrench, CheckCircle2, AlertTriangle, Loader2, Brain,
  ThumbsUp, ThumbsDown, Coins, GitBranch, Copy, Check, Layers, Clock, ShieldAlert, ArrowRight, Lock,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatTokens } from '../_components/formatTokens';
import { markSensitiveWith, SENS_COLOR, CAT_LABEL, humanizeTag, type SensitiveCategory as SensCategory, type SensScope, type ExtraMark } from '@slackhive/shared';

// A highlighted sensitive token: a colored-background tag. Click it to reveal what
// kind of data it is. The popover is portaled to <body> with fixed positioning so
// the surrounding scroll container's overflow can't clip it ("on click is cut").
/** True when the viewer may reveal raw sensitive values (admins only). */
const RevealCtx = React.createContext(false);

/** A sensitive value, MASKED by default (shown as its kind, e.g. "Phone number").
 *  Admins can click to reveal/hide the real value; non-admins only ever see the
 *  masked label. */
function SensitiveMark({ cat, label, llm, children }: { cat: SensCategory; label: string; llm?: boolean; children: React.ReactNode }): React.JSX.Element {
  const canReveal = React.useContext(RevealCtx);
  const [revealed, setRevealed] = useState(false);
  // Only mask actual VALUES (PII / secrets) and LLM-found excerpts. The data:/tool:
  // categories are keyword/path LABELS (e.g. "payment", "cvv", ".env"), not values —
  // masking those common words is pure noise, so render them as plain text.
  if (!llm && cat !== 'secret' && cat !== 'pii') return <>{children}</>;
  const color = SENS_COLOR[cat];
  const human = humanizeTag(label);
  const shown = revealed && canReveal;
  const onClick = (e: React.MouseEvent) => { e.stopPropagation(); if (canReveal) setRevealed(r => !r); };
  const kindNote = llm ? `${CAT_LABEL[cat] ?? cat} · caught by LLM` : (CAT_LABEL[cat] ?? cat);
  return (
    <mark
      onClick={onClick}
      title={canReveal ? (shown ? 'Click to hide' : `Click to reveal (${kindNote})`) : `Hidden — admins only (${kindNote})`}
      style={{
        background: `${color}26`, color, borderRadius: 3, padding: '0 4px', fontWeight: 600,
        cursor: canReveal ? 'pointer' : 'not-allowed', boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone',
        ...(llm ? { boxShadow: `inset 0 -2px 0 ${color}` } : {}),
      }}
    >
      {shown ? children : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <Lock size={10} style={{ flexShrink: 0 }} />{human.label}
      </span>}
    </mark>
  );
}

// When set (sensitive section), wrap text runs in marks for matched PII/secrets/
// data — so the agent's own answer (rendered as markdown) highlights like tool I/O.
// The context value is the highlight scope ('all' for tool I/O, 'text' for prose),
// or null when off.
const SensCtx = React.createContext<SensScope | null>(null);
// LLM-detector excerpts to also highlight inline (regex can't re-match these).
const EMPTY_HITS: ExtraMark[] = [];
const LlmHitsCtx = React.createContext<ExtraMark[]>(EMPTY_HITS);
function Hl({ children }: { children: React.ReactNode }): React.JSX.Element {
  const scope = React.useContext(SensCtx);
  const llmHits = React.useContext(LlmHitsCtx);
  if (!scope) return <>{children}</>;
  return <>{React.Children.map(children, (child) =>
    typeof child === 'string'
      ? markSensitiveWith(child, scope, llmHits).map((seg, i) => seg.cat
          ? <SensitiveMark key={i} cat={seg.cat} label={seg.label ?? seg.cat} llm={seg.llm}>{seg.text}</SensitiveMark>
          : <React.Fragment key={i}>{seg.text}</React.Fragment>)
      : child)}</>;
}

/** Normalize Slack mrkdwn the agent emitted so the trace renders it like Slack
 * did, not as literal GitHub markdown. Most visibly, a Slack link `<url|label>`
 * carries the value twice (in the url AND the label) — GH-markdown prints both,
 * which looked like a "duplicated" phone number; Slack shows only the label. */
function slackToMd(s: string): string {
  return s
    // <url|label> → label (Slack shows the label; keeps the value once)
    .replace(/<((?:https?|mailto|tel):[^|>\s]+)\|([^>]+)>/gi, '$2')
    // <url> (non-http schemes like tel: aren't GH autolinks) → bare url
    .replace(/<((?:https?|mailto|tel):[^|>\s]+)>/gi, '$1')
    // <@U…|name> / <#C…|name> mentions → the readable name
    .replace(/<[@#!][^|>]+\|([^>]+)>/g, '$1')
    .replace(/<[@#!]([^|>]+)>/g, '@$1')
    // Slack bold *x* → GH **x** (skip `**`, word-adjacent, and `* ` list bullets)
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\*)/g, '$1**$2**')
    // Slack strike ~x~ → GH ~~x~~
    .replace(/(^|[^~])~(?=\S)([^~\n]+?)(?<=\S)~(?!~)/g, '$1~~$2~~');
}

/** Compact markdown styling for reasoning / answers inside trace nodes. */
const MD: Components = {
  p: ({ children }) => <p style={{ margin: '0 0 6px', lineHeight: 1.6 }}><Hl>{children}</Hl></p>,
  ul: ({ children }) => <ul style={{ margin: '0 0 6px', paddingLeft: 18, lineHeight: 1.6 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 6px', paddingLeft: 18, lineHeight: 1.6 }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: 2 }}><Hl>{children}</Hl></li>,
  h1: ({ children }) => <h1 style={{ fontSize: 14, fontWeight: 600, margin: '6px 0 4px' }}><Hl>{children}</Hl></h1>,
  h2: ({ children }) => <h2 style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 4px' }}><Hl>{children}</Hl></h2>,
  h3: ({ children }) => <h3 style={{ fontSize: 13, fontWeight: 600, margin: '5px 0 3px' }}><Hl>{children}</Hl></h3>,
  strong: ({ children }) => <strong><Hl>{children}</Hl></strong>,
  em: ({ children }) => <em><Hl>{children}</Hl></em>,
  table: ({ children }) => <div style={{ overflow: 'auto', margin: '4px 0 8px' }}><table style={{ borderCollapse: 'collapse', fontSize: 11 }}>{children}</table></div>,
  th: ({ children }) => <th style={{ border: '1px solid var(--border)', padding: '3px 7px', background: 'var(--surface-2)', textAlign: 'left', fontWeight: 600 }}><Hl>{children}</Hl></th>,
  td: ({ children }) => <td style={{ border: '1px solid var(--border)', padding: '3px 7px' }}><Hl>{children}</Hl></td>,
  code: ({ className, children, ...props }) => className?.startsWith('language-')
    ? <code className={className} style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }} {...props}>{children}</code>
    : <code style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px', fontSize: 11.5, fontFamily: 'var(--font-mono)' }} {...props}><Hl>{children}</Hl></code>,
  pre: ({ children }) => <pre style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, margin: '4px 0 6px', fontSize: 11.5, lineHeight: 1.5, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{children}</pre>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}><Hl>{children}</Hl></a>,
};

interface Task {
  id: string; platform: string; channelId: string; threadTs: string;
  initiatorUserId?: string; initiatorHandle?: string; initialAgentId?: string;
  summary?: string; startedAt: string; lastActivityAt: string; activityCount: number;
}
type SpanKind = 'agent' | 'generation' | 'tool' | 'event';
interface TraceSpan {
  spanId: string; parentSpanId: string | null; kind: SpanKind; name: string;
  model: string | null; provider: string | null;
  startMs: number; endMs: number | null; durationMs: number | null;
  status: 'ok' | 'error'; statusMessage: string | null; toolName: string | null;
  inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null;
  cacheReadTokens: number | null; cacheCreationTokens: number | null;
  costUsd: number | null; finishReason: string | null;
  input: string | null; output: string | null; reasoning: string | null;
  sensitive: boolean; sensitiveCategories: string[]; sensitiveReason: string | null;
  sensitiveLlm?: boolean;
  sensitiveLlmHits?: { text: string; category: SensCategory; label: string; severity: string }[];
}
interface TurnFeedback { sentiment: 'up' | 'down'; note: string | null; raterHandle: string | null }
interface TraceTurn {
  activityId: string; agentId: string; agentName: string | null; agentSlug: string | null;
  status: 'in_progress' | 'done' | 'error'; startedAt: string; finishedAt: string | null;
  messagePreview: string | null; error: string | null;
  initiatorKind: 'user' | 'agent'; initiatorHandle: string | null;
  delegatedByAgentName: string | null; delegatedByAgentSlug: string | null;
  durationMs: number | null;
  inputTokens: number; outputTokens: number; reasoningTokens: number;
  cacheReadTokens: number; cacheCreationTokens: number; costUsd: number;
  finalAnswer: string | null; sensitive: boolean; sensitiveCategories: string[];
  feedback: TurnFeedback[]; spans: TraceSpan[];
}
interface ModelUsage { model: string; turns: number; tokens: number }
interface SessionRollup {
  turns: number; toolCalls: number; generations: number;
  inputTokens: number; outputTokens: number; reasoningTokens: number;
  cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number;
  costUsd: number; errorCount: number;
  totalDurationMs: number; p50DurationMs: number; p95DurationMs: number; models: ModelUsage[];
}
type Severity = 'critical' | 'high' | 'medium' | 'low';
interface TraceFlow {
  id: string; label: string; category: string; severity: Severity;
  sourceLabel: string; sinkLabel: string; sourceSpanId: string; sinkSpanId: string;
}
interface TraceDetail { task: Task; turns: TraceTurn[]; rollup: SessionRollup | null; deepLink: string | null; flows?: TraceFlow[] }
const SEV_COLOR: Record<Severity, string> = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#0891b2' };

function parseIso(s?: string): number | null {
  if (!s) return null;
  const ts = Date.parse(s.replace(' ', 'T') + 'Z');
  return Number.isNaN(ts) ? null : ts;
}
function relativeTime(isoLike?: string): string {
  const ts = parseIso(isoLike);
  if (ts == null) return '';
  const s = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60); const rem = Math.round(s - m * 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}
function formatCost(n: number): string {
  if (!n) return '—';
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p.length === 1 ? p[0].slice(0, 2) : p[0][0] + p[p.length - 1][0]).toUpperCase();
}
function agentColor(id: string): string {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffffff;
  return `hsl(${Math.abs(h) % 360}, 55%, 55%)`;
}
const STATUS_COLOR: Record<string, string> = {
  in_progress: '#2563eb', done: '#059669', ok: '#059669', error: '#dc2626',
};

export default function TaskTracePage(): React.JSX.Element {
  const params = useParams<{ taskId: string }>();
  const taskId = decodeURIComponent(params?.taskId ?? '');
  const { role } = useAuth();
  const canReveal = role === 'admin' || role === 'superadmin';
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fbFilter, setFbFilter] = useState<'all' | 'up' | 'down'>('all');
  // `?span=<id>` deep-link (from the Sensitive feed) — expand + scroll to that node.
  const [highlightSpanId, setHighlightSpanId] = useState<string | null>(null);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search).get('span');
    if (sp) setHighlightSpanId(sp);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/activity/${encodeURIComponent(taskId)}`);
      if (r.status === 404) { setError('Task not found'); return; }
      if (!r.ok) { setError('Failed to load task'); return; }
      setDetail(await r.json()); setError(null);
    } catch { setError('Failed to load task'); }
  }, [taskId]);

  // Initial load (and reload when the task changes).
  useEffect(() => { load(); }, [load]);

  // Poll ONLY while a turn is in progress, and re-evaluate only when that boolean
  // flips — depending on `detail.turns` here re-ran the effect (and refetched) on
  // every response, a tight loop that hammered the API and re-rendered constantly.
  const inflight = detail ? detail.turns.some(t => t.status === 'in_progress') : false;
  useEffect(() => {
    if (!inflight) return;
    const id = window.setInterval(load, 4000);
    return () => clearInterval(id);
  }, [inflight, load]);

  if (error) return <Shell><Empty>{error}</Empty></Shell>;
  if (!detail) return <Shell><div style={{ marginTop: 20, padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading…</div></Shell>;

  const { task, turns, rollup, deepLink } = detail;
  const flows = detail.flows ?? [];
  const initiator = task.initiatorHandle || task.initiatorUserId || 'unknown';
  const anyRunning = turns.some(t => t.status === 'in_progress');
  const anyError = turns.some(t => t.status === 'error');
  const sessionStatus = anyRunning ? 'in_progress' : anyError ? 'error' : 'done';

  // Turn-level feedback rollup + filter ("see where the agent went wrong").
  const upTurns = turns.filter(t => t.feedback.some(f => f.sentiment === 'up')).length;
  const downTurns = turns.filter(t => t.feedback.some(f => f.sentiment === 'down')).length;
  const indexedTurns = turns.map((t, i) => ({ t, i }));
  const visibleTurns = fbFilter === 'all'
    ? indexedTurns
    : indexedTurns.filter(({ t }) => t.feedback.some(f => f.sentiment === fbFilter));

  const agents = [...new Set(turns.map(t => ({ name: t.agentName, slug: t.agentSlug })).filter(a => a.name).map(a => JSON.stringify(a)))].map(s => JSON.parse(s) as { name: string; slug: string | null });

  return (
    <RevealCtx.Provider value={canReveal}>
    <Shell>
      {/* Title + description (the Back button above handles navigation) */}
      <div style={{ marginTop: 16 }}>
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', lineHeight: 1.35 }}>
          {task.summary || '(empty opening message)'}
        </h1>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
          Started by <strong style={{ color: 'var(--text)', fontWeight: 500 }}>@{initiator}</strong> · {relativeTime(task.startedAt)}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', marginTop: 18, flexWrap: 'wrap' }}>
        {/* ── Main column: analytics + flows + activity timeline ── */}
        <div style={{ flex: '1 1 600px', minWidth: 0 }}>
          {rollup && <Analytics rollup={rollup} turns={turns} />}

          {flows.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <SectionLabel>Sensitive data flows</SectionLabel>
              <div style={{ marginTop: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                {flows.map((f, i) => (
                  <a key={f.id} href={`#span-${f.sinkSpanId}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', textDecoration: 'none', color: 'inherit', borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                    <span style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 6, background: `${SEV_COLOR[f.severity]}1a`, color: SEV_COLOR[f.severity] }}>{f.severity}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', flexShrink: 0 }}>{f.label}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono, monospace)', minWidth: 0 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.sourceLabel}</span>
                      <ArrowRight size={12} style={{ color: 'var(--red)', flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.sinkLabel}</span>
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 8px' }}>
              <SectionLabel>Activity</SectionLabel>
              {(upTurns > 0 || downTurns > 0) && (
                <div style={{ display: 'inline-flex', gap: 4 }}>
                  <FbChip label="All" active={fbFilter === 'all'} onClick={() => setFbFilter('all')} />
                  <FbChip icon={<ThumbsUp size={11} />} label={String(upTurns)} active={fbFilter === 'up'} color="#16a34a" onClick={() => setFbFilter(fbFilter === 'up' ? 'all' : 'up')} />
                  <FbChip icon={<ThumbsDown size={11} />} label={String(downTurns)} active={fbFilter === 'down'} color="#dc2626" onClick={() => setFbFilter(fbFilter === 'down' ? 'all' : 'down')} />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {turns.length === 0 && <Empty>No activity recorded yet.</Empty>}
              {turns.length > 0 && visibleTurns.length === 0 && <Empty>No turns match this filter.</Empty>}
              {visibleTurns.map(({ t, i }, vi) => <TurnCard key={t.activityId} turn={t} index={i} isLast={vi === visibleTurns.length - 1} highlightSpanId={highlightSpanId} />)}
            </div>
          </div>
        </div>

        {/* ── Properties rail ── */}
        <aside style={{ flex: '0 0 240px', maxWidth: '100%', position: 'sticky', top: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)', marginBottom: 12 }}>Properties</div>
          <PropRow label="Status"><StatusPill status={sessionStatus} /></PropRow>
          <PropRow label="Assignee">
            <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{agents.length ? agents.map(a => a.name).join(', ') : '—'}</span>
          </PropRow>
          <PropRow label="Initiator"><span style={{ fontSize: 12.5, color: 'var(--text)' }}>@{initiator}</span></PropRow>
          <PropRow label="Started"><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{relativeTime(task.startedAt)}</span></PropRow>
          {turns.some(t => t.sensitive) && (
            <PropRow label="Sensitive"><SensitiveBadge categories={[...new Set(turns.flatMap(t => t.sensitiveCategories))]} /></PropRow>
          )}
          {deepLink && (
            <a href={deepLink} target="_blank" rel="noopener noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 14, padding: '8px 14px', fontSize: 12.5, fontWeight: 500,
              background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 8, textDecoration: 'none',
            }}>
              {deepLinkLabelForPlatform(task.platform as 'slack' | 'discord' | 'telegram' | 'whatsapp' | 'teams')} <ExternalLink size={12} />
            </a>
          )}
        </aside>
      </div>
    </Shell>
    </RevealCtx.Provider>
  );
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const router = useRouter();
  // Go to the actual previous page (Activity, Observability, …) rather than a fixed
  // route; fall back to /activity on a direct/deep load with no in-app history.
  const back = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back();
    else router.push('/activity');
  };
  return (
    <div className="fade-up" style={{ padding: '36px 40px', maxWidth: 1600, margin: '0 auto' }}>
      <button onClick={back} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)',
        background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)',
      }}>
        <ArrowLeft size={13} /> Back
      </button>
      {children}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ marginTop: 20, padding: 24, textAlign: 'center', background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 12, color: 'var(--muted)', fontSize: 13 }}>{children}</div>;
}
function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)', padding: '0 4px 8px' }}>{children}</div>;
}
/** A label/value row in the session Properties rail. */
function PropRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 30 }}>
      <span style={{ flexShrink: 0, width: 72, fontSize: 12, color: 'var(--muted)' }}>{label}</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
    </div>
  );
}

// ── Analytics card (boxed KPIs + charts) ─────────────────────────────────────
function Analytics({ rollup, turns }: { rollup: SessionRollup; turns: TraceTurn[] }): React.JSX.Element {
  const tokenData = turns.map((t, i) => ({ label: `#${i + 1}`, input: t.inputTokens, output: t.outputTokens }));
  const latencySeries = turns.map(t => t.durationMs ?? 0);
  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Kpi icon={<Layers size={13} />} label="Turns" value={String(rollup.turns)} />
        <Kpi icon={<Wrench size={13} />} label="Tool calls" value={String(rollup.toolCalls)} />
        <Kpi icon={<Coins size={13} />} label="Tokens" value={rollup.totalTokens > 0 ? formatTokens(rollup.totalTokens) : '—'} sub={rollup.totalTokens > 0 ? `${formatTokens(rollup.inputTokens)} in · ${formatTokens(rollup.outputTokens)} out` : undefined} />
        <Kpi icon={<Clock size={13} />} label="Latency" value={formatMs(rollup.p50DurationMs)} sub={`p95 ${formatMs(rollup.p95DurationMs)}`} />
      </div>
      {(rollup.inputTokens > 0 || rollup.outputTokens > 0 || rollup.reasoningTokens > 0) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <TokenChip label="in" value={rollup.inputTokens} />
          <TokenChip label="out" value={rollup.outputTokens} />
          {rollup.reasoningTokens > 0 && <TokenChip label="reasoning" value={rollup.reasoningTokens} />}
          {rollup.cacheReadTokens > 0 && <TokenChip label="cache read" value={rollup.cacheReadTokens} />}
          {rollup.cacheCreationTokens > 0 && <TokenChip label="cache write" value={rollup.cacheCreationTokens} />}
        </div>
      )}
      {turns.length > 1 && (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <StackBars title="Tokens per turn" data={tokenData} onBarClick={scrollToTurn} />
          <Bars title="Latency per turn" series={latencySeries} format={formatMs} color="var(--muted)" onBarClick={scrollToTurn} />
        </div>
      )}
      {rollup.models.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)', marginBottom: 6 }}>Models</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {rollup.models.map(m => {
              const max = rollup.models[0].tokens || 1;
              return (
                <div key={m.model} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <code style={{ flexShrink: 0, width: 160, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.model}</code>
                  <div style={{ flex: 1, height: 8, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(3, (m.tokens / max) * 100)}%`, height: '100%', background: 'var(--accent-2)', borderRadius: 4 }} />
                  </div>
                  <span style={{ flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, minWidth: 48, textAlign: 'right' }}>{formatTokens(m.tokens)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi(props: { icon: React.ReactNode; label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <div style={{ padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', color: 'var(--subtle)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{props.icon}{props.label}</div>
      <div style={{ marginTop: 4, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{props.value}</div>
      {props.sub && <div style={{ marginTop: 2, fontSize: 11, color: 'var(--subtle)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{props.sub}</div>}
    </div>
  );
}
function TokenChip(props: { label: string; value: number }): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, padding: '3px 8px', borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
      <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 9, fontWeight: 600, color: 'var(--subtle)' }}>{props.label}</span>
      <span style={{ color: 'var(--text)', fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>{formatTokens(props.value)}</span>
    </span>
  );
}
function Bars(props: { title: string; series: number[]; format: (n: number) => string; color: string; onBarClick?: (i: number) => void }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...props.series);
  return (
    <div style={{ padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, minHeight: 14 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)' }}>{props.title}</span>
        {hover != null && (
          <span style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)' }}>
            <span style={{ color: 'var(--subtle)' }}>#{hover + 1}</span> {props.format(props.series[hover])}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 }} onMouseLeave={() => setHover(null)}>
        {props.series.map((v, i) => (
          <div
            key={i}
            onMouseEnter={() => setHover(i)}
            onClick={() => props.onBarClick?.(i)}
            style={{ flex: 1, minWidth: 2, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: props.onBarClick ? 'pointer' : 'default' }}
          >
            <div style={{ width: '100%', height: `${Math.max(2, (v / max) * 100)}%`, background: props.color, borderRadius: 2, opacity: hover === i ? 1 : 0.5, transition: 'opacity 0.1s' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Scroll the timeline to a specific turn (used by chart bar clicks). */
function scrollToTurn(i: number): void {
  document.getElementById(`turn-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Interactive stacked in/out token chart (input lighter, output darker). */
function StackBars(props: { title: string; data: { label: string; input: number; output: number }[]; onBarClick?: (i: number) => void }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...props.data.map(d => d.input + d.output));
  const h = hover != null ? props.data[hover] : null;
  return (
    <div style={{ padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, minHeight: 14 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--subtle)' }}>{props.title}</span>
        {h && <span style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)' }}><span style={{ color: 'var(--subtle)' }}>{h.label}</span> {formatTokens(h.input)} in · {formatTokens(h.output)} out</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 }} onMouseLeave={() => setHover(null)}>
        {props.data.map((d, i) => {
          const total = d.input + d.output;
          return (
            <div key={i} onMouseEnter={() => setHover(i)} onClick={() => props.onBarClick?.(i)} style={{ flex: 1, minWidth: 2, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: props.onBarClick ? 'pointer' : 'default' }}>
              <div style={{ width: '100%', height: `${Math.max(2, (total / max) * 100)}%`, display: 'flex', flexDirection: 'column', borderRadius: 2, overflow: 'hidden', opacity: hover === i ? 1 : 0.7, transition: 'opacity 0.1s' }}>
                <div style={{ height: `${total ? (d.output / total) * 100 : 0}%`, background: 'var(--text-2)' }} />
                <div style={{ height: `${total ? (d.input / total) * 100 : 0}%`, background: 'var(--muted)' }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10, color: 'var(--subtle)' }}>
        <span><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--muted)', display: 'inline-block', marginRight: 4 }} />in</span>
        <span><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--text-2)', display: 'inline-block', marginRight: 4 }} />out</span>
      </div>
    </div>
  );
}

// ── Turn ────────────────────────────────────────────────────────────────────
function TurnCard({ turn, index, isLast, highlightSpanId }: { turn: TraceTurn; index: number; isLast?: boolean; highlightSpanId?: string | null }): React.JSX.Element {
  const nodes = buildNodes(turn);
  const containsHighlight = !!highlightSpanId && nodes.some(n => n.key === highlightSpanId);
  // Expand the most recent (last visible) turn by default; also a deep-linked turn,
  // and any still-running or errored turn so failures aren't hidden behind a card.
  const [open, setOpen] = useState(!!isLast || containsHighlight || turn.status === 'in_progress' || turn.status === 'error');
  const label = turn.agentName ?? turn.agentId.slice(0, 8);
  const color = agentColor(turn.agentId);
  const statusColor = STATUS_COLOR[turn.status] ?? 'var(--muted)';
  const tokens = turn.inputTokens + turn.outputTokens;
  const toolCount = turn.spans.filter(s => s.kind === 'tool').length;
  const toolErrors = turn.spans.filter(s => s.kind === 'tool' && s.status === 'error').length;
  const sentiment = turn.feedback.length ? (turn.feedback.some(f => f.sentiment === 'down') ? 'down' : 'up') : null;
  // Longest step drives the comparative duration-bar scale (left-aligned, not
  // absolute-positioned — clearer than a waterfall when tool spans are ~0ms).
  const maxStepMs = Math.max(1, ...nodes.map(n => n.durationMs ?? 0));

  // Author line — who sent / whose idea.
  const author = turn.initiatorKind === 'agent'
    ? (turn.delegatedByAgentName ? `via @${turn.delegatedByAgentName}` : 'from agent')
    : `from @${turn.initiatorHandle || 'user'}`;

  const running = turn.status === 'in_progress';
  return (
    <div id={`turn-${index}`} style={{
      background: running ? 'color-mix(in srgb, #2563eb 4%, var(--surface))' : 'var(--surface)',
      border: `1px solid ${running ? 'rgba(37,99,235,0.35)' : 'var(--border)'}`,
      borderRadius: 12, overflow: 'hidden', scrollMarginTop: 16, boxShadow: 'var(--shadow-sm)',
    }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: '50%', background: color, color: 'white', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{initials(label)}</div>
          <div style={{ position: 'absolute', bottom: -1, right: -1, width: 10, height: 10, borderRadius: '50%', background: statusColor, border: '2px solid var(--surface)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--subtle)', fontWeight: 600 }}>#{index + 1}</span>
            {turn.agentSlug
              ? <Link href={`/agents/${turn.agentSlug}`} onClick={e => e.stopPropagation()} style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', textDecoration: 'none' }}>{label}</Link>
              : <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</span>}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--subtle)' }}>
              {turn.initiatorKind === 'agent' && <GitBranch size={11} />}{author}
            </span>
            {running && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#2563eb' }}><Loader2 size={11} style={{ animation: 'spin 1.2s linear infinite' }} /> Working</span>}
            {sentiment && (sentiment === 'up' ? <ThumbsUp size={13} style={{ color: '#16a34a' }} /> : <ThumbsDown size={13} style={{ color: '#dc2626' }} />)}
            {turn.sensitive && <SensitiveBadge categories={turn.sensitiveCategories} />}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginLeft: 'auto', fontSize: 11, color: 'var(--subtle)' }}>
              {toolCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Wrench size={11} />{toolCount}{toolErrors > 0 && <span style={{ color: 'var(--red)', fontWeight: 600 }}> {toolErrors}✕</span>}</span>}
              {tokens > 0 && <span title={`${formatTokens(turn.inputTokens)} in · ${formatTokens(turn.outputTokens)} out`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Coins size={11} />{formatTokens(turn.inputTokens)} in · {formatTokens(turn.outputTokens)} out</span>}
              {turn.costUsd > 0 && <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{formatCost(turn.costUsd)}</span>}
              <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{formatMs(turn.durationMs)}</span>
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </div>
          {turn.messagePreview && <div style={{ marginTop: 6, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{turn.messagePreview}</div>}
        </div>
      </div>

      {open && (
        <div style={{ padding: '4px 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {turn.spans.length === 0 && turn.status === 'in_progress' && (
            <div style={{ fontSize: 12, color: 'var(--subtle)', display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: 4 }}><Loader2 size={12} style={{ animation: 'spin 1.2s linear infinite' }} /> running…</div>
          )}
          {/* Observation list: type tag · name · proportional duration bar · duration. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {nodes.map(node => <NodeRow key={node.key} node={node} maxMs={maxStepMs} highlight={!!highlightSpanId && node.key === highlightSpanId} />)}
          </div>

          {turn.feedback.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 6, background: f.sentiment === 'up' ? 'rgba(22,163,74,0.06)' : 'rgba(220,38,38,0.06)', border: `1px solid ${f.sentiment === 'up' ? 'rgba(22,163,74,0.2)' : 'rgba(220,38,38,0.2)'}` }}>
              {f.sentiment === 'up' ? <ThumbsUp size={13} style={{ color: '#16a34a', flexShrink: 0, marginTop: 1 }} /> : <ThumbsDown size={13} style={{ color: '#dc2626', flexShrink: 0, marginTop: 1 }} />}
              <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text)' }}>
                {f.raterHandle && <span style={{ fontWeight: 500 }}>@{f.raterHandle}</span>}
                {f.note && <span style={{ color: 'var(--muted)' }}>{f.raterHandle ? ' — ' : ''}{f.note}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Observation node ─────────────────────────────────────────────────────────
type NodeKind = 'generation' | 'tool' | 'event' | 'final' | 'error';
// Minimal palette: neutral grays everywhere; color reserved for the two signals
// that matter — errors (red) and the final answer (green).
// NodeRow renders a leading kind ICON (not a tag pill) + colors derived inline from
// node.kind / error state (see Icon/tagColor/barColor there).

interface NodeSection { label: string; body: string; markdown?: boolean }
interface NodeData {
  key: string;
  kind: NodeKind;
  title: string;
  model: string | null;
  startMs?: number;
  endMs?: number | null;
  durationMs: number | null;
  tokens: number;
  costUsd: number;
  error?: boolean;
  sections: NodeSection[];
  defaultOpen?: boolean;
  sensitive?: boolean;
  sensitiveCategories?: string[];
  sensitiveLlm?: boolean;
  sensitiveLlmHits?: ExtraMark[];
}

/** Flatten a turn into ordered tree nodes: each span, then the final answer,
 * then an error node (if any). */
function buildNodes(turn: TraceTurn): NodeData[] {
  const nodes: NodeData[] = [];
  const finalTrim = turn.finalAnswer?.trim();
  // The generation that produced the final answer is shown as the green ANSWER
  // node, so we skip it here — but carry its sensitivity + span id onto that node
  // so a flagged answer still highlights and its Sensitive-feed deep-link resolves.
  const toExtra = (hits?: TraceSpan['sensitiveLlmHits']): ExtraMark[] =>
    (hits ?? []).map(h => ({ text: h.text, cat: h.category, label: h.label }));
  let answerGen: { sensitive?: boolean; cats?: string[]; spanId?: string; llm?: boolean; hits?: ExtraMark[] } | null = null;
  for (const sp of turn.spans) {
    // Skip empty tool-decision generations and the generation that duplicates
    // the final answer (shown as the green ANSWER node).
    if (sp.kind === 'generation') {
      if (finalTrim && sp.output && sp.output.trim() === finalTrim) {
        answerGen = { sensitive: sp.sensitive, cats: sp.sensitiveCategories, spanId: sp.spanId, llm: sp.sensitiveLlm, hits: toExtra(sp.sensitiveLlmHits) };
        continue;
      }
      if (!sp.reasoning && !sp.output) continue;
    }
    const sections: NodeSection[] = [];
    if (sp.reasoning) sections.push({ label: 'thinking', body: sp.reasoning, markdown: true });
    if (sp.input) sections.push({ label: sp.kind === 'tool' ? 'args' : 'input', body: sp.input });
    if (sp.output) sections.push({ label: sp.status === 'error' ? 'error' : sp.kind === 'tool' ? 'result' : 'output', body: sp.output, markdown: sp.kind === 'generation' });
    const title = sp.kind === 'tool' ? (sp.toolName ?? sp.name)
      : sp.kind === 'generation' ? (sp.output ? 'Response' : sp.reasoning ? 'Thinking' : 'Generation')
      : sp.name;
    nodes.push({
      key: sp.spanId,
      kind: sp.kind as NodeKind,
      title,
      model: sp.kind === 'generation' ? sp.model : null,
      startMs: sp.startMs,
      endMs: sp.endMs,
      durationMs: sp.durationMs,
      tokens: (sp.inputTokens ?? 0) + (sp.outputTokens ?? 0),
      costUsd: sp.costUsd ?? 0,
      error: sp.status === 'error',
      sections,
      sensitive: sp.sensitive,
      sensitiveCategories: sp.sensitiveCategories,
      sensitiveLlm: sp.sensitiveLlm,
      sensitiveLlmHits: toExtra(sp.sensitiveLlmHits),
    });
  }
  if (turn.finalAnswer) {
    nodes.push({
      key: answerGen?.spanId ?? '__final', kind: 'final', title: 'Final answer', model: null, durationMs: null,
      tokens: 0, costUsd: 0, sections: [{ label: 'answer', body: turn.finalAnswer, markdown: true }], defaultOpen: true,
      sensitive: answerGen?.sensitive, sensitiveCategories: answerGen?.cats, sensitiveLlm: answerGen?.llm, sensitiveLlmHits: answerGen?.hits,
    });
  }
  if (turn.error) {
    nodes.push({
      key: '__error', kind: 'error', title: 'Error', model: null, durationMs: null,
      tokens: 0, costUsd: 0, sections: [{ label: 'error', body: turn.error }], defaultOpen: true,
    });
  }
  return nodes;
}

const META = { fontSize: 11, color: 'var(--subtle)', flexShrink: 0, fontFamily: 'var(--font-mono, monospace)', fontVariantNumeric: 'tabular-nums' } as const;

/** One observation row: chevron · type tag · name · model/tokens · a comparative
 * duration bar (length ∝ how long this step took vs the slowest in the turn) ·
 * duration. Click to expand its content. */
function NodeRow({ node, maxMs, highlight }: { node: NodeData; maxMs: number; highlight?: boolean }): React.JSX.Element {
  const has = node.sections.length > 0;
  // Deep-linked node (from the Sensitive feed) opens automatically and flashes.
  const [open, setOpen] = useState(!!node.defaultOpen || !!highlight);
  const rowRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(!!highlight);
  useEffect(() => {
    if (!highlight) return;
    rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setFlash(false), 2600);
    return () => clearTimeout(t);
  }, [highlight]);
  const isErr = node.kind === 'error' || node.error;
  // Leading icon per step kind — cleaner than a boxy LLM/TOOL tag pill.
  const Icon = isErr ? AlertTriangle : node.kind === 'final' ? CheckCircle2 : node.kind === 'tool' ? Wrench : node.kind === 'event' ? Clock : Brain;
  const tagColor = isErr ? 'var(--red)' : node.kind === 'final' ? 'var(--green)' : 'var(--muted)';
  const barColor = isErr ? 'var(--red)' : 'var(--text-2)';
  const titleColor = node.kind === 'final' ? 'var(--green)' : isErr ? 'var(--red)' : 'var(--text)';
  // Only errors get a colored left rule; the final answer doesn't need a green tint.
  const accent = isErr ? 'var(--red)' : undefined;

  const hasDur = node.durationMs != null;
  const pct = hasDur ? Math.max(2, Math.min(100, ((node.durationMs as number) / maxMs) * 100)) : 0;
  const durText = !hasDur ? '' : (node.durationMs && node.durationMs > 0 ? formatMs(node.durationMs) : '<1ms');

  return (
    <div id={`span-${node.key}`} ref={rowRef} style={{ borderRadius: 8, scrollMarginTop: 80, transition: 'box-shadow 0.4s, background 0.4s', ...(flash ? { boxShadow: '0 0 0 2px var(--accent)', background: 'var(--surface-2)' } : {}) }}>
      <div className="trace-node" onClick={() => has && setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', borderRadius: 6, minHeight: 30, cursor: has ? 'pointer' : 'default' }}>
        {has
          ? (open ? <ChevronDown size={13} style={{ color: 'var(--subtle)', flexShrink: 0 }} /> : <ChevronRight size={13} style={{ color: 'var(--subtle)', flexShrink: 0 }} />)
          : <span style={{ width: 13, flexShrink: 0 }} />}
        {/* leading kind icon */}
        <Icon size={13} style={{ flexShrink: 0, color: tagColor }} />
        <span style={{ fontSize: 12.5, fontWeight: 500, color: titleColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto', minWidth: 60, fontStyle: node.kind === 'generation' && node.title === 'Thinking' ? 'italic' : 'normal' }}>{node.title}</span>
        {node.sensitive && <SensitiveBadge categories={node.sensitiveCategories ?? []} compact llm={node.sensitiveLlm} />}
        {/* spacer keeps the badge next to the title and the metrics right-aligned */}
        <div style={{ flex: 1, minWidth: 8 }} />
        {node.model && <span style={{ fontSize: 10, color: 'var(--subtle)', flexShrink: 0, whiteSpace: 'nowrap' }}>{node.model}</span>}
        {node.tokens > 0 && <span style={META}>{formatTokens(node.tokens)}</span>}
        {/* comparative duration bar (left-aligned column) */}
        <div style={{ flexShrink: 0, width: 140 }}>
          {hasDur && (
            <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
              <div title={durText} style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 3, opacity: 0.55 }} />
            </div>
          )}
        </div>
        <span style={{ ...META, minWidth: 50, textAlign: 'right' }} title={hasDur && !(node.durationMs && node.durationMs > 0) ? 'Instant / not reported by backend' : undefined}>{durText}</span>
      </div>
      {open && has && (
        <div style={{ paddingLeft: 24, paddingRight: 4, paddingBottom: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {node.sections.map((s, i) => <Content key={i} label={s.label} body={s.body} markdown={s.markdown} accent={accent} sensitive={node.sensitive} scope={node.kind === 'tool' ? 'all' : 'text'} llmHits={node.sensitiveLlmHits} />)}
          {node.sensitive && <SensitiveNote categories={node.sensitiveCategories ?? []} hits={node.sensitiveLlmHits ?? []} llm={node.sensitiveLlm} />}
        </div>
      )}
    </div>
  );
}

/** Section body: markdown for prose (thinking / answers / responses), pretty
 * code for tool args/results. Filled (not bordered) for a calmer look. */
function Content({ label, body, markdown, accent, sensitive, scope = 'all', llmHits }: { label: string; body: string; markdown?: boolean; accent?: string; sensitive?: boolean; scope?: SensScope; llmHits?: ExtraMark[] }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const hits = llmHits ?? EMPTY_HITS;
  let text = body;
  if (!markdown) {
    try { const t = body.trim(); if (t.startsWith('{') || t.startsWith('[')) text = JSON.stringify(JSON.parse(t), null, 2); } catch { /* raw */ }
  }
  // Memoize the regex scan so the 4s poll doesn't re-highlight unchanged content.
  // buildNodes allocates a fresh hits array each render, so key the memo on the
  // hits' VALUE (text/cat/label), not its reference, or it would recompute every poll.
  const hitsKey = hits.map(h => `${h.text}${h.cat}${h.label}`).join('');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hitsKey is the value-stable proxy for `hits`
  const segments = useMemo(() => (sensitive && !markdown ? markSensitiveWith(text, scope, hits) : null), [sensitive, markdown, text, scope, hitsKey]);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  };
  const shell: React.CSSProperties = {
    background: 'var(--surface-2)', borderRadius: 6, padding: '8px 10px',
    borderLeft: accent ? `2px solid ${accent}` : undefined,
    maxHeight: 360, overflow: 'auto',
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.07em', color: 'var(--subtle)', textTransform: 'uppercase' }}>{label}</span>
        <button onClick={copy} title="Copy" style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: copied ? 'var(--green)' : 'var(--subtle)', padding: 2 }}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
      {markdown ? (
        <div style={{ ...shell, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.55 }}>
          <SensCtx.Provider value={sensitive ? scope : null}>
            {/* Markdown rendering strips Slack emphasis (*bold*, _italic_, ~strike~,
                `code`), so an LLM excerpt captured with that markup won't match the
                on-screen text. Strip it from the excerpts before matching. */}
            <LlmHitsCtx.Provider value={hits.map(h => ({ ...h, text: h.text.replace(/[*_~`]/g, '').trim() })).filter(h => h.text)}>
              <ReactMarkdown components={MD} remarkPlugins={[remarkGfm]}>{slackToMd(body)}</ReactMarkdown>
            </LlmHitsCtx.Provider>
          </SensCtx.Provider>
        </div>
      ) : (
        <pre style={{ ...shell, margin: 0, fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {segments
            ? segments.map((seg, i) => seg.cat
                ? <SensitiveMark key={i} cat={seg.cat} label={seg.label ?? seg.cat} llm={seg.llm}>{seg.text}</SensitiveMark>
                : <React.Fragment key={i}>{seg.text}</React.Fragment>)
            : text}
        </pre>
      )}
    </div>
  );
}

function FbChip({ label, icon, active, color, onClick }: { label: string; icon?: React.ReactNode; active: boolean; color?: string; onClick: () => void }): React.JSX.Element {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 7,
      fontSize: 11, fontWeight: 600, cursor: 'pointer',
      border: `1px solid ${active ? 'var(--border-2)' : 'var(--border)'}`,
      background: active ? 'var(--surface-2)' : 'transparent',
      color: active && color ? color : active ? 'var(--text)' : 'var(--muted)',
    }}>
      {icon}{label}
    </button>
  );
}

function SensitiveBadge({ categories, compact, llm }: { categories: string[]; compact?: boolean; llm?: boolean }): React.JSX.Element {
  // Keep the shield as the sensitive icon; when the Smart (LLM) detector caught it,
  // mark it with a small "AI" superscript (same amber color — no purple, no pill).
  const cats = categories.length ? categories.join(', ') : 'data touched';
  const title = llm ? `Sensitive (caught by the Smart LLM detector): ${cats}` : `Sensitive: ${cats}`;
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      color: '#b45309', fontSize: 10, fontWeight: 600, letterSpacing: '0.02em',
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'flex-start' }}>
        <ShieldAlert size={compact ? 12 : 13} />
        {llm && <sup style={{ fontSize: 7, fontWeight: 700, lineHeight: 1, marginLeft: 0.5 }}>AI</sup>}
      </span>
      {compact ? null : 'Sensitive'}
    </span>
  );
}

/** Humanize a `category:detail` tag, falling back to the category label for a
 * bare category (e.g. "pii" -> "Personal info" rather than "pii"). */
function catLabel(tag: string): string {
  const h = humanizeTag(tag);
  return h.label === h.category ? (CAT_LABEL[h.category] ?? h.label) : h.label;
}

/** One simple line under the node content naming WHAT was flagged sensitive —
 * and, when the detector captured the specific span(s), quoting them so the
 * viewer can find the value in the message above. */
function SensitiveNote({ categories, hits, llm }: { categories: string[]; hits: ExtraMark[]; llm?: boolean }): React.JSX.Element {
  const suffix = llm ? ' (caught by the Smart detector)' : '';
  const cap = (s: string): string => s.replace(/^\w/, c => c.toUpperCase());
  // Only PII/secrets are actual VALUES worth masking + revealing. data/tool hits
  // ("financial", ".env") are category keywords, not values — they have nothing
  // to reveal, so don't render them as clickable locks (matches SensitiveMark).
  const valueHits = [...new Map(
    hits.filter(h => (h.cat === 'pii' || h.cat === 'secret') && h.text?.trim()).map(h => [`${h.label}:${h.text}`, h]),
  ).values()].slice(0, 4);
  if (valueHits.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11.5, color: '#b45309' }}>
        <ShieldAlert size={12} style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <span>Flagged{suffix}:</span>
          {valueHits.map((h, i) => (
            <SensitiveMark key={i} cat={(h.cat ?? 'pii') as SensCategory} label={h.label} llm>{h.text}</SensitiveMark>
          ))}
        </span>
      </div>
    );
  }
  // No revealable value — the detector classified the content (e.g. "Financial").
  // Name the classification plainly instead of faking a maskable value.
  const labels = [...new Set([
    ...categories.map(catLabel),
    ...hits.filter(h => h.cat !== 'pii' && h.cat !== 'secret').map(h => cap(catLabel(h.label))),
  ].filter(Boolean))];
  const what = labels.length ? labels.join(', ') : 'sensitive data';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#b45309' }}>
      <ShieldAlert size={12} style={{ flexShrink: 0 }} />
      <span>Flagged as {what}{suffix}.</span>
    </div>
  );
}

function StatusPill({ status }: { status: 'in_progress' | 'done' | 'error' }): React.JSX.Element {
  const map = {
    in_progress: { label: 'Running', bg: 'rgba(37,99,235,0.1)', fg: '#1d4ed8', icon: <Loader2 size={10} style={{ animation: 'spin 1.2s linear infinite' }} /> },
    done: { label: 'Done', bg: 'rgba(5,150,105,0.1)', fg: '#047857', icon: <CheckCircle2 size={10} /> },
    error: { label: 'Error', bg: 'rgba(220,38,38,0.1)', fg: '#b91c1c', icon: <AlertTriangle size={10} /> },
  }[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 10, background: map.bg, color: map.fg, fontSize: 10, fontWeight: 600, letterSpacing: '0.02em' }}>
      {map.icon}{map.label}
    </span>
  );
}
