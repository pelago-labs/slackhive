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
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Hash,
  History,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageShell, PageHeader, EmptyState } from '@/components/patterns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

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
  createdBy: string;
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
interface AgentOption { id: string; name: string; slug: string; isBoss: boolean; }

/** Maps a run/last-run status to the semantic dot background + text color. */
function statusDotClass(status?: string): string {
  return status === 'error' ? 'bg-red'
    : status === 'success' ? 'bg-green'
    : 'bg-blue';
}
function statusTextClass(status?: string): string {
  return status === 'success' ? 'text-green'
    : status === 'error' ? 'text-red'
    : 'text-blue';
}

export default function JobsPage() {
  const { canEdit } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [writableAgents, setWritableAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<Record<string, JobRun[]>>({});
  const [runningNow, setRunningNow] = useState<Set<string>>(new Set());

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/jobs').then(r => r.json()).then(d => Array.isArray(d) ? d : []),
      fetch('/api/agents').then(r => r.json()).then(d => Array.isArray(d) ? d : []),
      fetch('/api/agents?writable=true').then(r => r.json()).then(d => Array.isArray(d) ? d : []),
    ]).then(([j, a, w]) => { setJobs(j); setAgents(a); setWritableAgents(w); }).catch(() => {}).finally(() => setLoading(false));
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

  const runNow = async (job: Job) => {
    setRunningNow(prev => new Set(prev).add(job.id));
    try {
      const r = await fetch(`/api/jobs/${job.id}/run`, { method: 'POST' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error ?? 'Failed to trigger run'); return; }
      // Give the runner a moment to insert the run row, then refresh.
      setTimeout(load, 1200);
    } finally {
      setTimeout(() => setRunningNow(prev => { const n = new Set(prev); n.delete(job.id); return n; }), 1500);
    }
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

  const openEdit = (job: Job) => { setEditingJob(job); setShowForm(true); };
  const openCreate = () => { setEditingJob(null); setShowForm(true); };

  return (
    <PageShell>
      <div className="max-w-[1180px]">
      <PageHeader
        title="Scheduled Jobs"
        subtitle="Recurring tasks executed by any agent on a cron schedule."
        action={canEdit && (
          <Button onClick={openCreate} size="sm" className="gap-1.5">
            <Plus size={14} />
            New Job
          </Button>
        )}
      />

      {/* Job list */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={<CalendarClock size={32} />}
          title="No scheduled jobs"
          hint={canEdit ? 'Create a recurring task for the boss agent to execute on a schedule.' : 'No jobs have been configured yet.'}
        />
      ) : (
        <section className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-secondary/45 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                <CalendarClock size={16} />
              </span>
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  Configured schedules
                  <span className="rounded-md border border-border bg-card px-1.5 py-px text-2xs font-medium text-muted-foreground">
                    {jobs.length}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Recurring prompts with delivery targets and run history.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-green" />
                {jobs.filter(j => j.enabled).length} active
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                {jobs.filter(j => !j.enabled).length} paused
              </span>
            </div>
          </div>
          <div className="divide-y divide-border">
          {jobs.map(job => (
            <div key={job.id} className="overflow-hidden bg-card transition-colors hover:bg-secondary/35">
              {/* Job row */}
              <div className="grid gap-3 px-4 py-3.5 lg:grid-cols-[minmax(0,1fr)_190px_auto] lg:items-start">
                {/* Status indicator */}
                <div className="flex min-w-0 items-start gap-3">
                  <div title={
                    !job.enabled ? 'Paused'
                    : job.lastRun?.status === 'error' ? 'Last run errored'
                    : job.lastRun?.status === 'success' ? 'Last run succeeded'
                    : job.lastRun?.status === 'running' ? 'Running now'
                    : 'Scheduled — waiting for first run'
                  } className={cn(
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                    !job.enabled ? 'bg-muted-foreground'
                      : job.lastRun?.status === 'error' ? 'bg-red'
                      : job.lastRun?.status === 'success' ? 'bg-green'
                      : job.lastRun?.status === 'running' ? 'bg-blue'
                      : 'bg-amber',
                  )} />

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{job.name}</span>
                      <span className="rounded-md border border-border bg-secondary px-1.5 py-px font-mono text-2xs font-semibold text-muted-foreground">
                        {job.cronSchedule}
                      </span>
                    {!job.enabled && (
                        <span className="rounded-md bg-secondary px-1.5 py-px text-2xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">Paused</span>
                    )}
                  </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{cronToHuman(job.cronSchedule)}</span>
                    {job.agentId && (() => {
                      const a = agents.find(x => x.id === job.agentId);
                      return a ? (
                        <span className="inline-flex items-center gap-1">
                          <span className={cn('inline-block h-1.5 w-1.5 rounded-full', a.isBoss ? 'bg-primary' : 'bg-muted-foreground')} />
                          {a.name}
                        </span>
                      ) : null;
                    })()}
                    <span className="inline-flex items-center gap-1">
                      {job.targetType === 'dm' ? <MessageSquare size={11} /> : <Hash size={11} />}
                      {job.targetType === 'dm' ? 'DM' : 'Channel'}: <code className="font-mono text-2xs">{job.targetId}</code>
                    </span>
                    {job.createdBy && (
                      <span className="inline-flex items-center gap-1">
                        by <strong className="font-semibold text-foreground">{job.createdBy}</strong>
                      </span>
                    )}
                    </div>
                  </div>
                </div>

                {/* Last run */}
                <div className="shrink-0 text-left lg:text-right">
                  {job.lastRun ? (
                    <>
                      <div className={cn('inline-flex items-center gap-1.5 text-2xs font-semibold uppercase', statusTextClass(job.lastRun.status))}>
                        {job.lastRun.status === 'success' ? <CheckCircle2 size={12} /> : job.lastRun.status === 'error' ? <AlertCircle size={12} /> : <Clock3 size={12} />}
                        {job.lastRun.status}
                      </div>
                      <div className="mt-1 text-2xs text-muted-foreground">
                        {new Date(job.lastRun.startedAt).toLocaleString()}
                      </div>
                    </>
                  ) : (
                    <div className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
                      <Clock3 size={12} />
                      Never run
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex shrink-0 justify-start gap-1.5 lg:justify-end">
                  {/* History toggle */}
                  <button onClick={() => toggleRuns(job.id)} title="Run history"
                    className="flex h-[30px] w-[30px] items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-input hover:text-foreground"
                  >
                    <History size={14} />
                  </button>
                  {canEdit && (
                    <>
                      {/* Run now (manual test trigger) */}
                      <button onClick={() => runNow(job)} disabled={runningNow.has(job.id)} title="Run now"
                        className="inline-flex h-[30px] items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground disabled:cursor-default disabled:opacity-50"
                      >
                        {runningNow.has(job.id) ? (
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ animation: 'spin 0.8s linear infinite' }}><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" strokeDasharray="28" strokeDashoffset="10" strokeLinecap="round"/></svg>
                        ) : (
                          <Play size={14} />
                        )}
                        Run
                      </button>
                      {/* Toggle enabled */}
                      <button onClick={() => toggleEnabled(job)} title={job.enabled ? 'Pause schedule' : 'Enable schedule'}
                        className={cn(
                          'flex h-[30px] w-[30px] items-center justify-center rounded-md border border-border transition-colors',
                          job.enabled ? 'text-green' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {job.enabled ? <Pause size={14} /> : <Power size={14} />}
                      </button>
                      <button onClick={() => openEdit(job)} title="Edit"
                        className="flex h-[30px] w-[30px] items-center justify-center rounded-md border border-border text-muted-foreground"
                      >
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => deleteJob(job)} title="Delete"
                        className="flex h-[30px] w-[30px] items-center justify-center rounded-md border border-border text-red opacity-60 hover:opacity-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Run history (expanded) */}
              {expandedRuns.has(job.id) && (
                <div className="border-t border-border bg-secondary">
                  <div className="px-5 py-2.5 text-2xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                    Run History
                  </div>
                  {(runs[job.id] ?? []).length === 0 ? (
                    <div className="px-5 py-3 text-xs text-muted-foreground">No runs yet</div>
                  ) : (
                    (runs[job.id] ?? []).slice(0, 10).map(run => (
                      <div key={run.id} className="flex items-start gap-2.5 border-t border-border px-5 py-2.5 text-xs">
                        <div className={cn('mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass(run.status))} />
                        <div className="min-w-0 flex-1">
                          <div className="flex gap-2.5 text-muted-foreground">
                            <span className={cn('font-semibold uppercase', statusTextClass(run.status))}>{run.status}</span>
                            <span>{new Date(run.startedAt).toLocaleString()}</span>
                            {run.finishedAt && (
                              <span className="text-muted-foreground">
                                ({Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s)
                              </span>
                            )}
                          </div>
                          {run.output && (
                            <pre className="mt-1 max-h-[100px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card px-2 py-1.5 font-mono text-2xs text-foreground">{run.output.slice(0, 500)}</pre>
                          )}
                          {run.error && (
                            <div className="mt-1 text-2xs text-red">
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
        </section>
      )}

      {/* Create/edit modal */}
      {showForm && (
        <JobFormModal
          job={editingJob}
          agents={writableAgents}
          onClose={() => { setShowForm(false); setEditingJob(null); }}
          onSaved={() => { setShowForm(false); setEditingJob(null); load(); }}
        />
      )}
      </div>
    </PageShell>
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
    <div className="fixed inset-0 z-[9999] flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-10 backdrop-blur-[2px]">
      <div className="flex w-[480px] max-w-full shrink-0 flex-col gap-4 rounded-xl border border-border bg-card p-7 shadow-lg">
        <div className="flex items-center justify-between">
          <h3 className="m-0 text-md font-semibold text-foreground">
            {isEdit ? 'Edit Job' : 'New Scheduled Job'}
          </h3>
          <button onClick={onClose} className="border-none bg-transparent text-lg text-muted-foreground">&times;</button>
        </div>

        {/* Agent */}
        <div>
          <Label className={labelClass}>Agent</Label>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger>
              <SelectValue placeholder="No agents available" />
            </SelectTrigger>
            <SelectContent>
              {agents.map(a => (
                <SelectItem key={a.id} value={a.id}>{a.name}{a.isBoss ? ' (Boss)' : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-2xs text-muted-foreground">
            The agent that will receive and execute this prompt.
          </p>
        </div>

        {/* Name */}
        <div>
          <Label className={labelClass}>Name</Label>
          <Input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Daily Booking Report" />
        </div>

        {/* Prompt */}
        <div>
          <Label className={labelClass}>Prompt</Label>
          <Textarea value={prompt} onChange={e => setPrompt(e.target.value)}
            placeholder="What should this agent do? e.g. Generate a summary of yesterday's bookings with key metrics"
            rows={3} className="resize-y" />
          <p className="mt-1 text-2xs text-muted-foreground">
            Sent to the agent on each scheduled run.
          </p>
        </div>

        {/* Schedule */}
        <div>
          <Label className={labelClass}>Schedule</Label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PRESETS.map(p => (
              <button key={p.cron} onClick={() => setCronSchedule(p.cron)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-2xs font-medium',
                  cronSchedule === p.cron
                    ? 'border-primary bg-secondary text-foreground'
                    : 'border-border bg-card text-muted-foreground',
                )}>{p.label}</button>
            ))}
          </div>
          <Input type="text" value={cronSchedule} onChange={e => setCronSchedule(e.target.value)}
            placeholder="0 8 * * *" className="font-mono" />
          <p className="mt-1 text-2xs text-muted-foreground">
            Cron expression: minute hour day month weekday — <span className="text-foreground">{cronToHuman(cronSchedule)}</span>
          </p>
        </div>

        {/* Target */}
        <div>
          <Label className={labelClass}>Deliver to</Label>
          <div className="mb-2 flex gap-2">
            {(['channel', 'dm'] as const).map(t => (
              <label key={t} className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm',
                targetType === t
                  ? 'border-primary bg-secondary text-foreground'
                  : 'border-border bg-card text-muted-foreground',
              )}>
                <input type="radio" name="targetType" checked={targetType === t} onChange={() => setTargetType(t)} className="hidden" />
                <span className="inline-flex items-center gap-1">
                  {t === 'channel' ? <Hash size={13} /> : <MessageSquare size={13} />}
                  {t === 'channel' ? 'Channel' : 'DM'}
                </span>
              </label>
            ))}
          </div>
          <Input type="text" value={targetId} onChange={e => setTargetId(e.target.value)}
            placeholder={targetType === 'channel' ? 'Channel ID (e.g. C0ANTCQ918U)' : 'User ID (e.g. U095GQAM6PL)'} />
        </div>

        {/* Enabled */}
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox checked={enabled} onCheckedChange={v => setEnabled(v === true)} />
          <span className="text-sm text-foreground">Enabled</span>
        </label>

        {error && <div className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">{error}</div>}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Job'}</Button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

const labelClass = 'mb-1.5 block text-xs font-medium text-muted-foreground';
