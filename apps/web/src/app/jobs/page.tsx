'use client';

/**
 * @fileoverview Scheduled jobs page — create, manage, and monitor recurring tasks.
 *
 * Jobs are executed by the boss agent on a cron schedule.
 * Results are posted to a Slack channel or DM.
 *
 * @module web/app/jobs
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { Portal } from '@/lib/portal';
import { Hash, MessageSquare, CalendarClock } from 'lucide-react';

interface JobRun {
  id: string;
  jobId: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'success' | 'error';
  output?: string;
  error?: string;
}

interface Job {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  cronSchedule: string;
  targetType: 'channel' | 'dm';
  targetId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRun?: JobRun;
}

const PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 8 AM', cron: '0 8 * * *' },
  { label: 'Daily at 9 AM', cron: '0 9 * * *' },
  { label: 'Mon-Fri at 9 AM', cron: '0 9 * * 1-5' },
  { label: 'Weekly Mon 9 AM', cron: '0 9 * * 1' },
];

/**
 * Converts a cron expression to a human-readable string.
 * Simple implementation — covers common patterns.
 */
function cronToHuman(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  if (min === '0' && hour === '*') return 'Every hour';
  if (min === '0' && hour.startsWith('*/')) return `Every ${hour.slice(2)} hours`;
  if (min === '0' && dow === '1-5' && dom === '*' && mon === '*') return `Weekdays at ${hour}:00`;
  if (min === '0' && dow === '1' && dom === '*' && mon === '*') return `Mondays at ${hour}:00`;
  if (min === '0' && dow === '*' && dom === '*' && mon === '*') return `Daily at ${hour}:00`;
  if (dom !== '*' && mon === '*') return `Day ${dom} at ${hour}:${min.padStart(2, '0')}`;
  return cron;
}

/**
 * Scheduled jobs management page.
 *
 * @returns {JSX.Element}
 */
interface AgentOption { id: string; name: string; slug: string; isBoss: boolean; hasWhatsappCreds?: boolean; }

export default function JobsPage() {
  const { canEdit } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<Record<string, JobRun[]>>({});

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/jobs').then(r => r.json()),
      fetch('/api/agents').then(r => r.json()),
    ]).then(([j, a]) => { setJobs(j); setAgents(a); }).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const toggleRuns = async (jobId: string) => {
    const next = new Set(expandedRuns);
    if (next.has(jobId)) {
      next.delete(jobId);
    } else {
      next.add(jobId);
      if (!runs[jobId]) {
        const r = await fetch(`/api/jobs/${jobId}/runs`);
        const data = await r.json();
        setRuns(prev => ({ ...prev, [jobId]: data }));
      }
    }
    setExpandedRuns(next);
  };

  const toggleEnabled = async (job: Job) => {
    await fetch(`/api/jobs/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !job.enabled }),
    });
    load();
  };

  const deleteJob = async (job: Job) => {
    if (!confirm(`Delete job "${job.name}"?`)) return;
    await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
    load();
  };

  const [runningNow, setRunningNow] = useState<Set<string>>(new Set());

  const runNow = async (job: Job) => {
    setRunningNow(prev => new Set(prev).add(job.id));
    try {
      await fetch(`/api/jobs/${job.id}/run`, { method: 'POST' });
      // Refresh runs list if expanded
      if (expandedRuns.has(job.id)) {
        const r = await fetch(`/api/jobs/${job.id}/runs`);
        const data = await r.json();
        setRuns(prev => ({ ...prev, [job.id]: data }));
      }
      load();
    } finally {
      setRunningNow(prev => { const s = new Set(prev); s.delete(job.id); return s; });
    }
  };

  const openEdit = (job: Job) => { setEditingJob(job); setShowForm(true); };
  const openCreate = () => { setEditingJob(null); setShowForm(true); };

  return (
    <div className="fade-up" style={{ padding: '36px 40px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>
            Scheduled Jobs
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Recurring tasks executed by any agent on a cron schedule.
          </p>
        </div>
        {canEdit && (
          <button onClick={openCreate} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--accent)', color: 'var(--accent-fg)',
            padding: '9px 18px', borderRadius: 8,
            fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
          }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            New Job
          </button>
        )}
      </div>

      {/* Job list */}
      {loading ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading...</p>
      ) : jobs.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '60px 20px',
          border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}><CalendarClock size={32} style={{ color: 'var(--border-2)' }} /></div>
          <p style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>No scheduled jobs</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', maxWidth: 300, marginInline: 'auto' }}>
            {canEdit ? 'Create a recurring task for the boss agent to execute on a schedule.' : 'No jobs have been configured yet.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {jobs.map(job => (
            <div key={job.id} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 12, boxShadow: 'var(--shadow-sm)', overflow: 'hidden',
            }}>
              {/* Job row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px' }}>
                {/* Status indicator */}
                <div style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: !job.enabled ? 'var(--border-2)'
                    : job.lastRun?.status === 'error' ? '#dc2626'
                    : job.lastRun?.status === 'success' ? '#059669'
                    : job.lastRun?.status === 'running' ? '#2563eb'
                    : 'var(--border-2)',
                }} />

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{job.name}</span>
                    {!job.enabled && (
                      <span style={{
                        fontSize: 10, fontWeight: 600, color: 'var(--subtle)',
                        background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 4,
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>Paused</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span>{cronToHuman(job.cronSchedule)}</span>
                    {job.agentId && (() => {
                      const a = agents.find(x => x.id === job.agentId);
                      return a ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: a.isBoss ? 'var(--accent)' : 'var(--muted)', display: 'inline-block' }} />
                          {a.name}
                        </span>
                      ) : null;
                    })()}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      {job.targetType === 'dm' ? <MessageSquare size={11} /> : <Hash size={11} />}
                      {job.targetType === 'dm' ? 'DM' : 'Channel'}: <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{job.targetId}</code>
                    </span>
                  </div>
                </div>

                {/* Last run */}
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  {job.lastRun ? (
                    <>
                      <div style={{
                        fontSize: 11, fontWeight: 600,
                        color: job.lastRun.status === 'success' ? '#059669'
                          : job.lastRun.status === 'error' ? '#dc2626'
                          : '#2563eb',
                        textTransform: 'uppercase',
                      }}>{job.lastRun.status}</div>
                      <div style={{ fontSize: 11, color: 'var(--subtle)' }}>
                        {new Date(job.lastRun.startedAt).toLocaleString()}
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 11, color: 'var(--subtle)' }}>Never run</div>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {/* Run Now */}
                  {canEdit && (
                    <button
                      onClick={() => runNow(job)}
                      disabled={runningNow.has(job.id)}
                      title="Run now"
                      style={{
                        background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                        width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: runningNow.has(job.id) ? 'not-allowed' : 'pointer',
                        color: runningNow.has(job.id) ? 'var(--subtle)' : '#2563eb',
                        opacity: runningNow.has(job.id) ? 0.5 : 1,
                        transition: 'color 0.12s',
                      }}
                    >
                      {runningNow.has(job.id) ? (
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3"/></svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 3l9 5-9 5V3z" fill="currentColor"/></svg>
                      )}
                    </button>
                  )}
                  {/* History toggle */}
                  <button onClick={() => toggleRuns(job.id)} title="Run history" style={{
                    background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                    width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', color: 'var(--muted)', transition: 'color 0.12s, border-color 0.12s',
                  }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; }}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M2 3h12M2 7h12M2 11h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                    </svg>
                  </button>
                  {canEdit && (
                    <>
                      {/* Toggle enabled */}
                      <button onClick={() => toggleEnabled(job)} title={job.enabled ? 'Pause' : 'Enable'} style={{
                        background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                        width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', color: job.enabled ? '#059669' : 'var(--subtle)',
                        transition: 'color 0.12s',
                      }}>
                        {job.enabled ? (
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 3v10M10 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 3l9 5-9 5V3z" fill="currentColor"/></svg>
                        )}
                      </button>
                      <button onClick={() => openEdit(job)} title="Edit" style={{
                        background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                        width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', color: 'var(--muted)',
                      }}>
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
                      </button>
                      <button onClick={() => deleteJob(job)} title="Delete" style={{
                        background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                        width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', color: '#dc2626', opacity: 0.6,
                      }}>
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V2h4v2M5 4v9h6V4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Prompt preview */}
              <div style={{
                padding: '0 20px 14px', fontSize: 12, color: 'var(--muted)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                <span style={{ color: 'var(--subtle)', fontSize: 11 }}>Prompt:</span> {job.prompt}
              </div>

              {/* Run history (expanded) */}
              {expandedRuns.has(job.id) && (
                <div style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                  <div style={{ padding: '10px 20px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    Run History
                  </div>
                  {(runs[job.id] ?? []).length === 0 ? (
                    <div style={{ padding: '12px 20px', fontSize: 12, color: 'var(--subtle)' }}>No runs yet</div>
                  ) : (
                    (runs[job.id] ?? []).slice(0, 10).map(run => (
                      <div key={run.id} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 10,
                        padding: '10px 20px', borderTop: '1px solid var(--border)',
                        fontSize: 12,
                      }}>
                        <div style={{
                          width: 6, height: 6, borderRadius: '50%', marginTop: 5, flexShrink: 0,
                          background: run.status === 'success' ? '#059669' : run.status === 'error' ? '#dc2626' : '#2563eb',
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', gap: 10, color: 'var(--muted)' }}>
                            <span style={{
                              fontWeight: 600, textTransform: 'uppercase',
                              color: run.status === 'success' ? '#059669' : run.status === 'error' ? '#dc2626' : '#2563eb',
                            }}>{run.status}</span>
                            <span>{new Date(run.startedAt).toLocaleString()}</span>
                            {run.finishedAt && (
                              <span style={{ color: 'var(--subtle)' }}>
                                ({Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s)
                              </span>
                            )}
                          </div>
                          {run.output && (
                            <pre style={{
                              margin: '4px 0 0', fontSize: 11, color: 'var(--text)',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                              fontFamily: 'var(--font-mono)', maxHeight: 100, overflow: 'auto',
                              background: 'var(--surface)', padding: '6px 8px', borderRadius: 6,
                              border: '1px solid var(--border)',
                            }}>{run.output.slice(0, 500)}</pre>
                          )}
                          {run.error && (
                            <div style={{ margin: '4px 0 0', fontSize: 11, color: '#dc2626' }}>
                              {run.error}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create/edit modal */}
      {showForm && (
        <JobFormModal
          job={editingJob}
          agents={agents}
          onClose={() => { setShowForm(false); setEditingJob(null); }}
          onSaved={() => { setShowForm(false); setEditingJob(null); load(); }}
        />
      )}
    </div>
  );
}

// =============================================================================
// Job form modal
// =============================================================================

function JobFormModal({ job, agents, onClose, onSaved }: {
  job: Job | null; agents: AgentOption[]; onClose: () => void; onSaved: () => void;
}) {
  const isEdit = !!job;
  const [agentId, setAgentId] = useState(job?.agentId ?? agents[0]?.id ?? '');
  const [name, setName] = useState(job?.name ?? '');
  const [prompt, setPrompt] = useState(job?.prompt ?? '');
  const [cronSchedule, setCronSchedule] = useState(job?.cronSchedule ?? '0 8 * * *');
  const [targetType, setTargetType] = useState<'channel' | 'dm'>(job?.targetType ?? 'channel');
  const [targetId, setTargetId] = useState(job?.targetId ?? '');

  const selectedAgent = agents.find(a => a.id === agentId);
  const isWhatsApp = !!selectedAgent?.hasWhatsappCreds;
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!agentId || !name || !prompt || !cronSchedule || !targetId) {
      setError('All fields are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body = { agentId, name, prompt, cronSchedule, targetType, targetId, enabled };
      const r = isEdit
        ? await fetch(`/api/jobs/${job!.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) {
        const data = await r.json();
        setError(data.error || 'Failed');
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Portal>
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      zIndex: 9999, padding: '40px 16px',
      overflowY: 'auto',
      backdropFilter: 'blur(2px)',
    }}>
      <div style={{
        background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)',
        padding: 28, width: 480, maxWidth: '100%', boxShadow: 'var(--shadow-lg)',
        display: 'flex', flexDirection: 'column', gap: 16,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
            {isEdit ? 'Edit Job' : 'New Scheduled Job'}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>&times;</button>
        </div>

        {/* Agent */}
        <div>
          <label style={labelStyle}>Agent</label>
          <select value={agentId} onChange={e => {
            const a = agents.find(x => x.id === e.target.value);
            setAgentId(e.target.value);
            if (a?.hasWhatsappCreds) setTargetType('dm');
          }} style={inputStyle}>
            {agents.length === 0 && <option value="">No agents available</option>}
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.name}{a.isBoss ? ' (Boss)' : ''}</option>
            ))}
          </select>
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>
            The agent that will receive and execute this prompt.
          </p>
        </div>

        {/* Name */}
        <div>
          <label style={labelStyle}>Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Daily Booking Report"
            style={inputStyle} />
        </div>

        {/* Prompt */}
        <div>
          <label style={labelStyle}>Prompt</label>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
            placeholder="What should this agent do? e.g. Generate a summary of yesterday's bookings with key metrics"
            rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-sans)' }} />
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>
            Sent to the agent on each scheduled run.
          </p>
        </div>

        {/* Schedule */}
        <div>
          <label style={labelStyle}>Schedule</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {PRESETS.map(p => (
              <button key={p.cron} onClick={() => setCronSchedule(p.cron)}
                style={{
                  padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                  border: cronSchedule === p.cron ? '1px solid var(--accent)' : '1px solid var(--border)',
                  background: cronSchedule === p.cron ? 'var(--surface-2)' : '#fff',
                  color: cronSchedule === p.cron ? 'var(--text)' : 'var(--muted)',
                  cursor: 'pointer', fontFamily: 'var(--font-sans)',
                }}>{p.label}</button>
            ))}
          </div>
          <input type="text" value={cronSchedule} onChange={e => setCronSchedule(e.target.value)}
            placeholder="0 8 * * *" style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} />
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>
            Cron expression: minute hour day month weekday — <span style={{ color: 'var(--text)' }}>{cronToHuman(cronSchedule)}</span>
          </p>
        </div>

        {/* Target */}
        <div>
          <label style={labelStyle}>Deliver to</label>
          {isWhatsApp ? (
            <>
              <input type="text" value={targetId} onChange={e => setTargetId(e.target.value)}
                placeholder="Phone number (e.g. 6591234567)"
                style={inputStyle} />
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)', marginTop: 4 }}>
                WhatsApp phone number to send the job output to (no + prefix, digits only).
              </p>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                {(['channel', 'dm'] as const).map(t => (
                  <label key={t} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                    border: targetType === t ? '1px solid var(--accent)' : '1px solid var(--border)',
                    borderRadius: 7, cursor: 'pointer', fontSize: 13,
                    background: targetType === t ? 'var(--surface-2)' : '#fff',
                    color: targetType === t ? 'var(--text)' : 'var(--muted)',
                  }}>
                    <input type="radio" name="targetType" checked={targetType === t} onChange={() => setTargetType(t)} style={{ display: 'none' }} />
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {t === 'channel' ? <Hash size={13} /> : <MessageSquare size={13} />}
                      {t === 'channel' ? 'Channel' : 'DM'}
                    </span>
                  </label>
                ))}
              </div>
              <input type="text" value={targetId} onChange={e => setTargetId(e.target.value)}
                placeholder={targetType === 'channel' ? 'Channel ID (e.g. C0ANTCQ918U)' : 'User ID (e.g. U095GQAM6PL)'}
                style={inputStyle} />
            </>
          )}
        </div>

        {/* Enabled */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }} />
          <span style={{ fontSize: 13, color: 'var(--text)' }}>Enabled</span>
        </label>

        {error && <div style={{ fontSize: 12, color: '#dc2626', background: 'rgba(220,38,38,0.06)', padding: '6px 10px', borderRadius: 6 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            padding: '8px 16px', borderRadius: 7, border: '1px solid var(--border)',
            background: 'var(--surface)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)',
          }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{
            padding: '8px 18px', borderRadius: 7, border: 'none',
            background: 'var(--accent)', color: 'var(--accent-fg)', fontSize: 13, fontWeight: 500,
            cursor: 'pointer', fontFamily: 'var(--font-sans)',
          }}>{saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Job'}</button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5,
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', borderRadius: 7,
  border: '1px solid var(--border)', fontSize: 13, outline: 'none',
  boxSizing: 'border-box' as const, fontFamily: 'var(--font-sans)',
  color: 'var(--text)',
};
