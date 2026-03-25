'use client';

/**
 * @fileoverview Dashboard — agent fleet overview.
 * Shows all agents as cards with live status, quick actions, and empty state.
 *
 * @module web/app/page
 */

import { useEffect, useState } from 'react';
import type { Agent } from '@slack-agent-team/shared';
import Link from 'next/link';

const STATUS_COLOR = {
  running: '#16a34a',
  stopped: '#94a3b8',
  error:   '#dc2626',
} as const;

const STATUS_LABEL = {
  running: 'Running',
  stopped: 'Stopped',
  error:   'Error',
} as const;

/**
 * Main dashboard page.
 * Fetches all agents and renders them as cards in a responsive grid.
 *
 * @returns {JSX.Element}
 */
export default function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then(setAgents)
      .finally(() => setLoading(false));
  }, []);

  const running = agents.filter(a => a.status === 'running').length;
  const total   = agents.length;

  return (
    <div style={{ padding: '32px 36px', maxWidth: 1100 }} className="fade-up">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            Agent Fleet
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            {loading ? 'Loading…' : `${running} of ${total} agent${total !== 1 ? 's' : ''} running`}
          </p>
        </div>
        <Link href="/agents/new" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--accent)', color: '#fff',
          padding: '8px 16px', borderRadius: 8,
          fontSize: 13, fontWeight: 500, textDecoration: 'none',
          transition: 'opacity 0.15s',
        }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          New Agent
        </Link>
      </div>

      {/* ── Stats row ────────────────────────────────────────────────────── */}
      {!loading && total > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 24 }} className="stagger">
          {[
            { label: 'Total Agents', value: total, color: 'var(--text)' },
            { label: 'Running', value: running, color: '#16a34a' },
            { label: 'Stopped', value: agents.filter(a => a.status === 'stopped').length, color: 'var(--muted)' },
            { label: 'Errors', value: agents.filter(a => a.status === 'error').length, color: '#dc2626' },
            { label: 'Boss Agent', value: agents.filter(a => a.isBoss).length > 0 ? 'Yes' : 'No', color: '#f59e0b' },
          ].map(stat => (
            <div key={stat.label} className="fade-up" style={{
              flex: 1,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '14px 16px',
            }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, letterSpacing: '0.02em' }}>
                {stat.label}
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: stat.color, letterSpacing: '-0.02em' }}>
                {stat.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Agent grid ───────────────────────────────────────────────────── */}
      {loading ? (
        <SkeletonGrid />
      ) : total === 0 ? (
        <EmptyState />
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
          gap: 14,
        }} className="stagger">
          {agents.map(agent => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Agent card ────────────────────────────────────────────────────────────────

/**
 * Renders a single agent card with status, description, and quick info.
 *
 * @param {{ agent: Agent }} props
 */
function AgentCard({ agent }: { agent: Agent }) {
  const color = STATUS_COLOR[agent.status] ?? '#334155';

  return (
    <Link
      href={`/agents/${agent.slug}`}
      className="fade-up"
      style={{
        display: 'block', textDecoration: 'none',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '18px 20px',
        transition: 'border-color 0.15s, background 0.15s',
        cursor: 'pointer',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)';
        (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
        (e.currentTarget as HTMLElement).style.background = 'var(--surface)';
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {/* Avatar */}
          <div style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            background: agent.isBoss
              ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
              : 'linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700, color: '#fff',
          }}>
            {agent.name.charAt(0).toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>
                {agent.name}
              </span>
              {agent.isBoss && (
                <span style={{
                  fontSize: 9.5, fontWeight: 600, letterSpacing: '0.06em',
                  background: 'rgba(245,158,11,0.15)', color: '#f59e0b',
                  padding: '1.5px 6px', borderRadius: 4, border: '1px solid rgba(245,158,11,0.25)',
                  textTransform: 'uppercase',
                }}>Boss</span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
              @{agent.slug}
            </div>
          </div>
        </div>

        {/* Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <div
            className={agent.status === 'running' ? 'status-running' : ''}
            style={{
              width: 7, height: 7, borderRadius: '50%',
              background: color,
            }}
          />
          <span style={{ fontSize: 11.5, color: color, fontWeight: 500 }}>
            {STATUS_LABEL[agent.status]}
          </span>
        </div>
      </div>

      {/* Description */}
      <p style={{
        margin: 0, fontSize: 12.5, color: 'var(--muted)',
        lineHeight: 1.5,
        display: '-webkit-box', WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical', overflow: 'hidden',
        minHeight: 36,
      }}>
        {agent.description || <span style={{ color: 'var(--subtle)', fontStyle: 'italic' }}>No description</span>}
      </p>

      {/* Footer */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 11, color: 'var(--subtle)', fontFamily: 'var(--font-mono)' }}>
          {agent.model.replace('claude-', '').split('-20')[0]}
        </span>
        <span style={{ fontSize: 11, color: 'var(--subtle)' }}>
          {agent.slackBotUserId ? `Slack: ${agent.slackBotUserId}` : 'Not connected'}
        </span>
      </div>
    </Link>
  );
}

// ── Skeleton loader ───────────────────────────────────────────────────────────

function SkeletonGrid() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 14 }}>
      {[1, 2, 3].map(i => (
        <div key={i} style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '18px 20px', opacity: 1 - (i - 1) * 0.25,
        }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <Skel w={32} h={32} r={8} />
            <div style={{ flex: 1 }}>
              <Skel w="60%" h={14} r={4} mb={6} />
              <Skel w="40%" h={11} r={4} />
            </div>
          </div>
          <Skel w="100%" h={11} r={4} mb={5} />
          <Skel w="75%" h={11} r={4} />
        </div>
      ))}
    </div>
  );
}

function Skel({ w, h, r = 4, mb = 0 }: { w: number | string; h: number; r?: number; mb?: number }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: r,
      background: 'var(--border)', marginBottom: mb,
      opacity: 0.6,
    }} />
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      minHeight: 380, gap: 16, textAlign: 'center',
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 18,
        background: 'var(--surface)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 28,
      }}>
        🤖
      </div>
      <div>
        <p style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
          No agents yet
        </p>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', maxWidth: 280 }}>
          Create your first Claude Code agent to connect it to Slack.
        </p>
      </div>
      <Link href="/agents/new" style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: 'var(--accent)', color: '#fff',
        padding: '9px 20px', borderRadius: 8,
        fontSize: 13, fontWeight: 500, textDecoration: 'none',
        transition: 'opacity 0.15s',
      }}>
        Create First Agent
      </Link>
    </div>
  );
}
