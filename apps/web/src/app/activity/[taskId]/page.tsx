'use client';

/**
 * @fileoverview Task detail view — preview-only timeline of every agent turn
 * inside one Slack thread, with expandable tool calls. No full-body storage
 * and no live Slack fetch; we link back to Slack for the full conversation.
 *
 * @module web/app/activity/[taskId]
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { deepLinkLabelForPlatform } from '@slackhive/shared';
import {
  ArrowLeft, ExternalLink, ChevronRight, ChevronDown,
  Wrench, CheckCircle2, AlertTriangle, Loader2,
} from 'lucide-react';

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

interface ToolCall {
  id: string;
  activityId: string;
  toolName: string;
  argsPreview?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'in_progress' | 'ok' | 'error';
  resultPreview?: string;
}

interface Activity {
  id: string;
  taskId: string;
  agentId: string;
  platform: string;
  initiatorKind: 'user' | 'agent';
  initiatorUserId?: string;
  messageRef?: string;
  messagePreview?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'in_progress' | 'done' | 'error';
  error?: string;
  toolCallCount: number;
  toolCalls: ToolCall[];
}

interface TaskDetail {
  task: Task;
  activities: Activity[];
  deepLink: string | null;
}

interface AgentLite {
  id: string;
  slug: string;
  name: string;
}

function parseIso(s?: string): number | null {
  if (!s) return null;
  const ts = Date.parse(s.replace(' ', 'T') + 'Z');
  return Number.isNaN(ts) ? null : ts;
}

function relativeTime(isoLike?: string): string {
  const ts = parseIso(isoLike);
  if (ts == null) return '';
  const delta = Math.max(0, Date.now() - ts);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function durationLabel(startIso?: string, endIso?: string): string {
  const start = parseIso(startIso);
  if (start == null) return '';
  const end = parseIso(endIso) ?? Date.now();
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function agentColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

const STATUS_COLOR: Record<string, string> = {
  in_progress: '#2563eb',
  done:        '#059669',
  ok:          '#059669',
  error:       '#dc2626',
};

export default function TaskDetailPage(): React.JSX.Element {
  const params = useParams<{ taskId: string }>();
  const taskId = decodeURIComponent(params?.taskId ?? '');

  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/activity/${encodeURIComponent(taskId)}`);
      if (r.status === 404) { setError('Task not found'); return; }
      if (!r.ok) { setError('Failed to load task'); return; }
      setDetail(await r.json());
      setError(null);
    } catch {
      setError('Failed to load task');
    }
  }, [taskId]);

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then((rows: AgentLite[]) => setAgents(rows)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    if (pollRef.current) clearInterval(pollRef.current);
    // Only poll while the task still has in-flight work; otherwise a single
    // fetch is enough and we skip the timer. Re-evaluates every run of `load`.
    const hasInflight = detail?.activities.some(a => a.status === 'in_progress') ?? true;
    if (hasInflight) {
      pollRef.current = window.setInterval(load, 4000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load, detail?.activities]);

  const agentById = useMemo(() => {
    const m = new Map<string, AgentLite>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  if (error) {
    return (
      <div className="fade-up" style={{ padding: '36px 40px', maxWidth: 900, margin: '0 auto' }}>
        <BackLink />
        <div style={{
          marginTop: 20, padding: 24, textAlign: 'center',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, color: 'var(--muted)',
        }}>
          {error}
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="fade-up" style={{ padding: '36px 40px', maxWidth: 900, margin: '0 auto' }}>
        <BackLink />
        <div style={{ marginTop: 20, padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }

  const { task, activities, deepLink } = detail;
  const initiatorLabel = task.initiatorHandle || task.initiatorUserId || 'unknown';

  return (
    <div className="fade-up" style={{ padding: '36px 40px', maxWidth: 900, margin: '0 auto' }}>
      <BackLink />

      <div style={{
        marginTop: 16, padding: '18px 22px',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--subtle)', textTransform: 'uppercase', marginBottom: 6 }}>
              {task.platform} thread
            </div>
            <h1 style={{
              margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)',
              letterSpacing: '-0.01em', lineHeight: 1.4,
            }}>
              {task.summary || '(empty opening message)'}
            </h1>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginTop: 10,
              fontSize: 12, color: 'var(--muted)',
            }}>
              <span>Started by <strong style={{ color: 'var(--text)', fontWeight: 500 }}>@{initiatorLabel}</strong></span>
              <span>·</span>
              <span>{relativeTime(task.startedAt)}</span>
              <span>·</span>
              <span>{task.activityCount} turn{task.activityCount === 1 ? '' : 's'}</span>
            </div>
          </div>

          {deepLink && (
            <a href={deepLink} target="_blank" rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', fontSize: 12, fontWeight: 500,
                background: 'var(--accent)', color: 'var(--accent-fg)',
                border: 'none', borderRadius: 8,
                textDecoration: 'none', flexShrink: 0,
                fontFamily: 'var(--font-sans)',
              }}
            >
              {deepLinkLabelForPlatform(task.platform as 'slack' | 'discord' | 'telegram' | 'whatsapp' | 'teams')} <ExternalLink size={12} />
            </a>
          )}
        </div>
      </div>

      <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {activities.length === 0 && (
          <div style={{
            padding: 24, textAlign: 'center', color: 'var(--subtle)',
            background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 10, fontSize: 12,
          }}>
            No activity recorded yet.
          </div>
        )}
        {activities.map((act, idx) => (
          <ActivityCard
            key={act.id}
            activity={act}
            isFirst={idx === 0}
            agent={agentById.get(act.agentId)}
          />
        ))}
      </div>
    </div>
  );
}

function BackLink(): React.JSX.Element {
  return (
    <Link href="/activity" style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 12, color: 'var(--muted)', textDecoration: 'none',
    }}>
      <ArrowLeft size={13} /> Back to Activity
    </Link>
  );
}

function ActivityCard(props: {
  activity: Activity;
  isFirst: boolean;
  agent?: AgentLite;
}): React.JSX.Element {
  const { activity, agent } = props;
  const [open, setOpen] = useState(activity.status === 'in_progress' || activity.status === 'error');
  const label = agent?.name ?? activity.agentId.slice(0, 8);
  const color = agentColor(activity.agentId);
  const statusColor = STATUS_COLOR[activity.status] ?? 'var(--muted)';
  const hasToolCalls = activity.toolCalls.length > 0;

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, overflow: 'hidden',
    }}>
      <div
        onClick={() => (hasToolCalls || activity.error) && setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '14px 16px',
          cursor: hasToolCalls || activity.error ? 'pointer' : 'default',
        }}
      >
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: color, color: 'white',
            fontSize: 11, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{initials(label)}</div>
          <div style={{
            position: 'absolute', bottom: -1, right: -1,
            width: 10, height: 10, borderRadius: '50%',
            background: statusColor, border: '2px solid var(--surface)',
          }} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {agent ? (
              <Link href={`/agents/${agent.slug}`}
                style={{
                  fontSize: 13, fontWeight: 600, color: 'var(--text)',
                  textDecoration: 'none',
                }}
                onClick={e => e.stopPropagation()}
              >{label}</Link>
            ) : (
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</span>
            )}
            <StatusPill status={activity.status} />
            <span style={{ fontSize: 11, color: 'var(--subtle)' }}>
              {activity.initiatorKind === 'user' ? 'from user' : 'from agent'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--subtle)', marginLeft: 'auto' }}>
              {durationLabel(activity.startedAt, activity.finishedAt)}
              {' · '}
              {relativeTime(activity.startedAt)}
            </span>
          </div>
          {activity.messagePreview && (
            <div style={{
              marginTop: 8, fontSize: 13, color: 'var(--muted)',
              lineHeight: 1.5,
            }}>{activity.messagePreview}</div>
          )}
          {activity.error && (
            <div style={{
              marginTop: 8, padding: '8px 10px',
              background: 'rgba(220,38,38,0.06)',
              border: '1px solid rgba(220,38,38,0.2)',
              borderRadius: 6,
              fontSize: 12, color: '#b91c1c',
              fontFamily: 'var(--font-mono, monospace)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}>{activity.error}</div>
          )}
          {hasToolCalls && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              marginTop: 8, fontSize: 11, color: 'var(--muted)',
              fontWeight: 500,
            }}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Wrench size={11} />
              {activity.toolCalls.length} tool call{activity.toolCalls.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
      </div>

      {open && hasToolCalls && (
        <div style={{
          padding: '4px 16px 14px 60px',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {activity.toolCalls.map(tc => <ToolCallRow key={tc.id} call={tc} />)}
        </div>
      )}
    </div>
  );
}

function StatusPill(props: { status: Activity['status'] }): React.JSX.Element {
  const { status } = props;
  const map: Record<Activity['status'], { label: string; bg: string; fg: string; icon: React.ReactNode }> = {
    in_progress: {
      label: 'Running', bg: 'rgba(37,99,235,0.1)', fg: '#1d4ed8',
      icon: <Loader2 size={10} style={{ animation: 'spin 1.2s linear infinite' }} />,
    },
    done: {
      label: 'Done', bg: 'rgba(5,150,105,0.1)', fg: '#047857',
      icon: <CheckCircle2 size={10} />,
    },
    error: {
      label: 'Error', bg: 'rgba(220,38,38,0.1)', fg: '#b91c1c',
      icon: <AlertTriangle size={10} />,
    },
  };
  const v = map[status];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 7px', borderRadius: 10,
      background: v.bg, color: v.fg,
      fontSize: 10, fontWeight: 600, letterSpacing: '0.02em',
    }}>
      {v.icon}{v.label}
    </span>
  );
}

function ToolCallRow(props: { call: ToolCall }): React.JSX.Element {
  const { call } = props;
  const [open, setOpen] = useState(false);
  const color = STATUS_COLOR[call.status] ?? 'var(--muted)';
  const hasBody = !!(call.argsPreview || call.resultPreview);

  return (
    <div style={{
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 8, overflow: 'hidden',
    }}>
      <div
        onClick={() => hasBody && setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', cursor: hasBody ? 'pointer' : 'default',
          fontSize: 12,
        }}
      >
        {hasBody
          ? (open ? <ChevronDown size={12} style={{ color: 'var(--subtle)' }} /> : <ChevronRight size={12} style={{ color: 'var(--subtle)' }} />)
          : <span style={{ width: 12 }} />}
        <span style={{
          width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0,
        }} />
        <code style={{
          fontSize: 11, color: 'var(--text)',
          fontFamily: 'var(--font-mono, monospace)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{call.toolName}</code>
        <span style={{ fontSize: 10, color: 'var(--subtle)', marginLeft: 'auto' }}>
          {durationLabel(call.startedAt, call.finishedAt)}
        </span>
      </div>
      {open && hasBody && (
        <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {call.argsPreview && <PreBlock label="args" body={call.argsPreview} />}
          {call.resultPreview && <PreBlock label={call.status === 'error' ? 'error' : 'result'} body={call.resultPreview} />}
        </div>
      )}
    </div>
  );
}

function PreBlock(props: { label: string; body: string }): React.JSX.Element {
  return (
    <div>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
        color: 'var(--subtle)', textTransform: 'uppercase', marginBottom: 2,
      }}>{props.label}</div>
      <pre style={{
        margin: 0, padding: '6px 8px',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6,
        fontSize: 11, color: 'var(--text)',
        fontFamily: 'var(--font-mono, monospace)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        maxHeight: 160, overflow: 'auto',
      }}>{props.body}</pre>
    </div>
  );
}
