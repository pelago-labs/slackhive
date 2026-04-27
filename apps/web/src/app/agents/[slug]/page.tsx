'use client';

/**
 * @fileoverview Agent detail page — tabbed control panel.
 *
 * Tabs: Overview · Skills · MCPs · Permissions · Memory · Logs
 *
 * Route: /agents/[slug]
 * @module web/app/agents/[slug]
 */

import React, { useEffect, useState, useRef, use, useMemo } from 'react';
import { Brain, Camera, Clock, History, Upload, Download, Wand2, Loader2, Link2, FileText, GitBranch, BookOpen, ChevronRight, ChevronDown, ArrowLeft, Folder, FolderOpen, Library, X, Search, Code2, Database, Layers, Briefcase, Sparkles, MessageSquare, Activity as ActivityIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Agent, Skill, McpServer, Memory, Permission, Restriction, AgentSnapshot } from '@slackhive/shared';
import { PERSONA_CATALOG, searchPersonas, MODELS } from '@slackhive/shared';
import type { PersonaTemplate, PersonaCategory } from '@slackhive/shared';
import { Portal } from '@/lib/portal';
import { useAuth } from '@/lib/auth-context';
import { FilesChanged, type FileChange } from './diff-view';
import { CoachPanel } from './coach-panel';
import { TestPanel } from './test-panel';

type Tab = 'overview' | 'instructions' | 'tools' | 'knowledge' | 'logs' | 'history';

interface AgentExportPayload {
  version: number;
  exportedAt?: string;
  name?: string;
  persona?: string;
  description?: string;
  claudeMd: string;
  skills: { category: string; filename: string; content: string; sortOrder: number }[];
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',      label: 'Overview'      },
  { id: 'instructions',  label: 'Instructions'  },
  { id: 'tools',         label: 'Tools'         },
  { id: 'knowledge',     label: 'Wiki'           },
  { id: 'logs',          label: 'Logs'          },
  { id: 'history',       label: 'History'       },
];

const STATUS_COLOR = {
  running: '#16a34a',
  stopped: 'var(--border-2)',
  error: '#ef4444',
  stale: '#f59e0b',
} as const;

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Agent detail page — loads the agent by slug then renders the tabbed UI.
 *
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export default function AgentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { role, canManageUsers, username } = useAuth();
  // Arriving from the new-agent wizard (?coach=open) lands on Overview as
  // usual, but arms the Coach to auto-open the first time the user opens the
  // Instructions tab. We don't pop the panel on Overview — users deserve to
  // see their new agent before we shove a chat in their face.
  // useSearchParams is hydration-safe (returns the same value on server + client).
  const coachArmedFromWizard = useSearchParams().get('coach') === 'open';
  const router = useRouter();
  const [coachOpen, setCoachOpen] = useState(false);
  const [pendingCoachOpen, setPendingCoachOpen] = useState(coachArmedFromWizard);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  /** Full-main-window mode swap. `test` replaces the agent header + tabs +
   *  tab content with <TestPanel>. The global SlackHive sidebar (rendered by
   *  layout-shell.tsx) remains visible — clicking it navigates away and
   *  naturally unmounts this page, resetting back to `normal` on next load. */
  const [mode, setMode] = useState<'normal' | 'test'>('normal');

  // Strip ?coach=open from the URL after the first render so refreshing
  // the page doesn't keep rearming the auto-open.
  useEffect(() => {
    if (!coachArmedFromWizard) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('coach');
    window.history.replaceState({}, '', url.toString());
  }, [coachArmedFromWizard]);

  // When the user navigates to Instructions and Coach is armed, pop it open
  // once, then disarm so subsequent Instructions visits stay quiet.
  useEffect(() => {
    if (tab === 'instructions' && pendingCoachOpen) {
      setCoachOpen(true);
      setPendingCoachOpen(false);
    }
  }, [tab, pendingCoachOpen]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');

  useEffect(() => {
    setCanEdit(false);
    setViewOnly(false);
    fetch('/api/agents')
      .then(r => r.json())
      .then((agents: Agent[]) => {
        setAllAgents(agents);
        const found = agents.find(a => a.slug === slug) ?? null;
        if (!found) {
          setAgent(null);
          return;
        }
        if (role === 'admin' || role === 'superadmin') {
          setCanEdit(true);
          // Admins/superadmins can see Slack tokens — fetch detail endpoint
          fetch(`/api/agents/${found.id}`)
            .then(r => r.json())
            .then((detail: Agent) => setAgent(detail))
            .catch(() => setAgent(found));
        } else if (role === 'editor' || role === 'viewer') {
          setAgent(found);
          fetch(`/api/agents/${found.id}/access`)
            .then(r => r.json())
            .then(data => {
              const canRead = data.canRead ?? false;
              if (!canRead) { router.push('/agents'); return; }
              const writable = data.canWrite ?? false;
              setCanEdit(writable);
              const readOnly = !writable;
              setViewOnly(readOnly);
              if (readOnly) setTab(t => (t === 'logs' || t === 'history') ? 'overview' : t);
              if (writable) {
                // Editors with write access can also see tokens
                fetch(`/api/agents/${found.id}`)
                  .then(r => r.json())
                  .then((detail: Agent) => setAgent(detail))
                  .catch(() => {});
              }
            });
        }
      })
      .finally(() => setLoading(false));
  }, [slug, role]);

  const triggerAction = async (action: 'start' | 'stop' | 'reload') => {
    if (!agent) return;
    setActionMsg(action === 'start' ? 'Starting…' : action === 'stop' ? 'Stopping…' : 'Reloading…');
    await fetch(`/api/agents/${agent.id}/${action}`, { method: 'POST' });
    const r = await fetch(`/api/agents/${agent.id}`);
    setAgent(await r.json());
    setActionMsg('Done');
    setTimeout(() => setActionMsg(''), 2000);
    window.dispatchEvent(new Event('slackhive:sidebar-refresh'));
  };

  if (loading) return <PageLoader />;
  if (!agent)  return <NotFound slug={slug} />;

  // Prefer the API-computed liveStatus (accounts for heartbeat staleness) over
  // the raw DB status. A green "running" dot with no recent heartbeat means
  // the owning runner crashed — surface that as an amber "stale" dot instead.
  const displayStatus = (agent.liveStatus ?? agent.status) as keyof typeof STATUS_COLOR;
  const statusColor = STATUS_COLOR[displayStatus] ?? 'var(--border-2)';
  const staleTooltip = displayStatus === 'stale'
    ? 'Status unconfirmed — no runner heartbeat in over 45s. The owning process may have crashed.'
    : undefined;

  // Test mode swap — renders only the TestPanel as the main window. The
  // global SlackHive sidebar (from layout-shell.tsx) stays visible; clicking
  // anything in it navigates away and unmounts this page (exiting test mode
  // implicitly). No tab state is touched, so hitting × returns to the same
  // tab the user was on.
  if (mode === 'test') {
    return (
      <div style={{ height: '100vh' }}>
        <TestPanel
          agentId={agent.id}
          agentName={agent.name}
          onClose={() => setMode('normal')}
        />
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh' }} className="fade-up">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '28px 40px 0',
        borderBottom: '1px solid var(--border)',
        paddingBottom: 0,
        flexWrap: 'wrap', gap: 12,
      }}>
        <div>
          {/* Breadcrumb */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, fontSize: 12, color: 'var(--muted)' }}>
            <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none' }}>Agents</Link>
            <span style={{ color: 'var(--subtle)' }}>/</span>
            <span style={{ color: 'var(--text)' }}>{agent.name}</span>
          </div>

          {/* Agent name + status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              background: agent.isBoss
                ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
                : 'linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 700, color: 'var(--accent-fg)',
            }}>
              {agent.name.charAt(0)}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text)' }}>
                  {agent.name}
                </h1>
                {agent.isBoss && (
                  <span style={{
                    fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
                    background: 'rgba(245,158,11,0.15)', color: '#f59e0b',
                    padding: '2px 7px', borderRadius: 5,
                    border: '1px solid rgba(245,158,11,0.25)',
                    textTransform: 'uppercase',
                  }}>Boss</span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} title={staleTooltip}>
                  <div
                    className={displayStatus === 'running' ? 'status-running' : ''}
                    style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor }}
                  />
                  <span style={{ fontSize: 12, color: statusColor, fontWeight: 500, textTransform: 'capitalize' }}>
                    {displayStatus}
                  </span>
                </div>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>
                @{agent.slug} · {agent.model.replace('claude-', '').split('-20')[0]}
              </div>
              {agent.lastError && agent.status !== 'running' && (
                <div style={{
                  fontSize: 12,
                  color: 'var(--red)',
                  marginTop: 6,
                  maxWidth: 520,
                  lineHeight: 1.4,
                  wordBreak: 'break-word',
                }}>
                  {agent.lastError}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 16 }}>
          {actionMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{actionMsg}</span>}

          {!viewOnly && <button
            onClick={() => setMode('test')}
            title="Test this agent — chat with it without connecting to Slack"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px',
              background: 'rgba(99, 102, 241, 0.1)',
              border: '1px solid rgba(99, 102, 241, 0.3)',
              color: 'var(--accent)',
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 500,
              cursor: 'pointer',
              letterSpacing: 0.2,
            }}
          >
            <MessageSquare size={13} />
            Test
          </button>}

          <Link
            href={`/activity?agent=${encodeURIComponent(agent.id)}`}
            title={`View activity for ${agent.name}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 500,
              cursor: 'pointer',
              letterSpacing: 0.2,
              textDecoration: 'none',
            }}
          >
            <ActivityIcon size={13} />
            Activity
          </Link>

          <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />

          {canEdit && agent.status !== 'running' && (
            <Btn color="#22c55e" onClick={() => triggerAction('start')}>Start</Btn>
          )}
          {canEdit && agent.status === 'running' && (
            <Btn color="var(--border-2)" textColor="var(--muted)" onClick={() => triggerAction('reload')}>Reload</Btn>
          )}
          {canEdit && agent.status === 'running' && (
            <Btn color="#ef4444" onClick={() => triggerAction('stop')}>Stop</Btn>
          )}
        </div>
      </div>

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 0, padding: '0 36px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        overflowX: 'auto', WebkitOverflowScrolling: 'touch',
      }}>
        {TABS.filter(t => !viewOnly || (t.id !== 'logs' && t.id !== 'history')).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={tab === t.id ? 'tab-active' : ''}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 14px', fontSize: 13,
              color: tab === t.id ? 'var(--text)' : 'var(--muted)',
              fontWeight: tab === t.id ? 500 : 400,
              transition: 'color 0.15s',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ──────────────────────────────────────────────────── */}
      <div style={{ padding: '28px 36px' }}>
        {tab === 'overview'      && <OverviewTab      agent={agent} onUpdate={setAgent} canEdit={canEdit} allAgents={allAgents} role={role} onOpenCoach={() => setCoachOpen(true)} />}
        {tab === 'instructions'  && <InstructionsTab  agent={agent} canEdit={canEdit} onAgentUpdate={setAgent} onOpenCoach={() => setCoachOpen(true)} />}
        {tab === 'tools'         && <ToolsTab          agentId={agent.id} canEdit={canEdit} canManageMcps={canManageUsers} currentUsername={username} />}
        {tab === 'knowledge'     && <KnowledgeTab      agentId={agent.id} agentSlug={agent.slug} canEdit={canEdit} />}
        {/* Memory is now inside Instructions tab */}
        {tab === 'logs'        && <LogsTab        agentId={agent.id} slug={agent.slug} />}
        {tab === 'history'     && <HistoryTab     agentId={agent.id} canEdit={canEdit} />}
      </div>

      {/* Coach is a slide-over — rendered once at page level so it floats over
          any tab, not just Instructions. */}
      <CoachPanel
        agentId={agent.id}
        agentName={agent.name}
        open={coachOpen}
        onClose={() => setCoachOpen(false)}
        canEdit={canEdit && !agent.isBoss}
      />
    </div>
  );
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({ agent, onUpdate, canEdit, allAgents, role, onOpenCoach }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean; allAgents: Agent[]; role: string | null; onOpenCoach?: () => void }) {
  const [form, setForm] = useState({
    name:               agent.name,
    description:        agent.description ?? '',
    persona:            agent.persona ?? '',
    model:              agent.model,
    slackBotToken:      agent.slackBotToken,
    slackAppToken:      agent.slackAppToken,
    slackSigningSecret: agent.slackSigningSecret,
    isBoss:             agent.isBoss,
    verbose:            agent.verbose ?? true,
    reportsTo:          agent.reportsTo ?? [] as string[],
  });
  const [saving, setSaving]             = useState(false);
  const [msg, setMsg]                   = useState('');
  const [manifest, setManifest]         = useState('');
  const [showManifest, setShowManifest] = useState(false);
  const [deleting, setDeleting]         = useState(false);
  const [slackInfo, setSlackInfo]       = useState<{ displayName: string; handle: string; teamName: string } | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!agent.slackBotToken) return;
    fetch(`/api/agents/${agent.id}/slack-info`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setSlackInfo(d))
      .catch(() => {});
  }, [agent.id, agent.slackBotToken]);

  // Channel restrictions state
  const [allowedChannels, setAllowedChannels] = useState('');

  useEffect(() => {
    fetch(`/api/agents/${agent.id}/restrictions`)
      .then(r => r.json())
      .then((d: Restriction) => setAllowedChannels((d.allowedChannels ?? []).join('\n')));
  }, [agent.id]);

  const save = async () => {
    setSaving(true);
    try {
      const [r] = await Promise.all([
        fetch(`/api/agents/${agent.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name,
            persona: form.persona,
            description: form.description,
            model: form.model,
            isBoss: form.isBoss,
            verbose: form.verbose,
            reportsTo: form.reportsTo,
            ...(form.slackBotToken && {
              platformCredentials: {
                botToken: form.slackBotToken,
                appToken: form.slackAppToken,
                signingSecret: form.slackSigningSecret,
              },
            }),
          }),
        }),
        fetch(`/api/agents/${agent.id}/restrictions`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowedChannels: allowedChannels.split('\n').map(s => s.trim()).filter(Boolean) }),
        }),
      ]);
      const data = await r.json();
      if (r.ok) { onUpdate(data); setMsg('Saved'); } else setMsg(data.error ?? 'Error');
    } finally { setSaving(false); setTimeout(() => setMsg(''), 3000); }
  };

  const loadManifest = async () => {
    const r = await fetch(`/api/agents/${agent.id}/manifest`);
    setManifest(JSON.stringify(await r.json(), null, 2));
    setShowManifest(true);
  };

  const handleDelete = async () => {
    if (!confirm(`Permanently delete agent "${agent.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    const r = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
    if (r.ok) {
      window.dispatchEvent(new Event('slackhive:sidebar-refresh'));
      router.push('/');
    } else {
      const err = await r.json();
      setMsg(err.error ?? 'Delete failed');
      setDeleting(false);
    }
  };

  const isAdmin = role === 'admin' || role === 'superadmin';

  return (
    <div style={{ maxWidth: 640 }} className="fade-up">
      <Section title="Configuration">
        <Grid2>
          <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} readOnly={!canEdit}
            hint="Internal agent name." />
          <Field label="Model" value={form.model} onChange={v => setForm(f => ({ ...f, model: v }))}
            hint={MODELS.map(m => m.value).join(' · ')} readOnly={!canEdit} />
        </Grid2>
        <Field label="Description" value={form.description}
          onChange={v => setForm(f => ({ ...f, description: v }))}
          hint="Short summary — used by boss agents for delegation." readOnly={!canEdit} />
        <TextArea label="Persona" value={form.persona}
          onChange={v => setForm(f => ({ ...f, persona: v }))}
          hint="Who is this agent? This becomes the identity shown in Instructions → Skills." rows={4} readOnly={!canEdit} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>Verbose Responses</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              On: each step is posted as it happens. Off: only the final answer is sent as one message.
            </div>
          </div>
          <button
            disabled={!canEdit}
            onClick={() => setForm(f => ({ ...f, verbose: !f.verbose }))}
            style={{
              width: 44, height: 24, borderRadius: 12, border: 'none',
              background: form.verbose ? '#3b82f6' : 'var(--border-2)',
              cursor: canEdit ? 'pointer' : 'default',
              position: 'relative', transition: 'background 0.2s', flexShrink: 0,
            }}
          >
            <div style={{
              position: 'absolute', top: 3, left: form.verbose ? 23 : 3,
              width: 18, height: 18, borderRadius: '50%', background: 'var(--surface)',
              transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        </div>
      </Section>

      <Section title="Role & Hierarchy">
        {/* Boss toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>Boss Agent</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Boss agents orchestrate other agents and delegate tasks</div>
          </div>
          <button
            disabled={!canEdit}
            onClick={() => setForm(f => ({ ...f, isBoss: !f.isBoss }))}
            style={{
              width: 44, height: 24, borderRadius: 12, border: 'none',
              background: form.isBoss ? '#d97706' : 'var(--border-2)',
              cursor: canEdit ? 'pointer' : 'default',
              position: 'relative', transition: 'background 0.2s', flexShrink: 0,
            }}
          >
            <div style={{
              position: 'absolute', top: 3, left: form.isBoss ? 23 : 3,
              width: 18, height: 18, borderRadius: '50%', background: 'var(--surface)',
              transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        </div>

        {/* Reports To — only show for non-boss agents */}
        {!form.isBoss && (() => {
          const bosses = allAgents.filter(a => a.isBoss && a.id !== agent.id);
          if (bosses.length === 0) return (
            <div style={{ fontSize: 12, color: 'var(--subtle)', fontStyle: 'italic' }}>
              No boss agents available. Create a boss agent first.
            </div>
          );
          return (
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 6 }}>Reports To</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {bosses.map(boss => {
                  const checked = form.reportsTo.includes(boss.id);
                  return (
                    <label key={boss.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px', borderRadius: 8,
                      border: `1px solid ${checked ? 'rgba(217,119,6,0.3)' : 'var(--border)'}`,
                      background: checked ? 'rgba(217,119,6,0.04)' : 'var(--surface)',
                      cursor: canEdit ? 'pointer' : 'default',
                      transition: 'all 0.15s',
                    }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canEdit}
                        onChange={() => setForm(f => ({
                          ...f,
                          reportsTo: checked
                            ? f.reportsTo.filter(id => id !== boss.id)
                            : [...f.reportsTo, boss.id],
                        }))}
                        style={{ accentColor: '#d97706', width: 14, height: 14 }}
                      />
                      <div style={{
                        width: 24, height: 24, borderRadius: 6, background: 'var(--accent)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 600, color: 'var(--accent-fg)', flexShrink: 0,
                      }}>
                        {boss.name.charAt(0).toUpperCase()}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{boss.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>@{boss.slug}</div>
                      </div>
                      {checked && (
                        <span style={{
                          marginLeft: 'auto', fontSize: 10, fontWeight: 600,
                          color: '#d97706', letterSpacing: '0.04em', textTransform: 'uppercase',
                        }}>Reports to</span>
                      )}
                    </label>
                  );
                })}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--subtle)', marginTop: 8 }}>
                An agent can report to multiple bosses.
              </div>
            </div>
          );
        })()}
      </Section>

      <Section title="Slack Credentials">
        <Field label="Bot Token" value={form.slackBotToken ?? ''}
          onChange={v => setForm(f => ({ ...f, slackBotToken: v }))} type="password" readOnly={!canEdit}
          hint={<>api.slack.com/apps → your app → <strong>OAuth &amp; Permissions</strong> → Bot User OAuth Token</>} />
        <Field label="App-Level Token" value={form.slackAppToken ?? ''}
          onChange={v => setForm(f => ({ ...f, slackAppToken: v }))} type="password" readOnly={!canEdit}
          hint={<>Basic Information → <strong>App-Level Tokens</strong> → Generate with scope <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>connections:write</code></>} />
        <Field label="Signing Secret" value={form.slackSigningSecret ?? ''}
          onChange={v => setForm(f => ({ ...f, slackSigningSecret: v }))} type="password" readOnly={!canEdit}
          hint="Basic Information → App Credentials → Signing Secret" />
        {slackInfo && (
          <div style={{
            background: '#f0fdf4', border: '1px solid #bbf7d0',
            borderRadius: 7, padding: '10px 14px', fontSize: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', flexShrink: 0 }} />
              <span style={{ color: '#15803d', fontWeight: 600 }}>Connected to Slack</span>
              <span style={{ color: '#86efac', marginLeft: 'auto', fontSize: 11 }}>{slackInfo.teamName}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px' }}>
              <span style={{ color: '#6b7280' }}>Display name</span>
              <span style={{ color: '#166534', fontWeight: 500 }}>{slackInfo.displayName}</span>
              <span style={{ color: '#6b7280' }}>@handle</span>
              <span style={{ color: '#166534', fontFamily: 'var(--font-mono)' }}>@{slackInfo.handle}</span>
              {agent.slackBotUserId && <>
                <span style={{ color: '#6b7280' }}>Bot User ID</span>
                <span style={{ color: '#166534', fontFamily: 'var(--font-mono)' }}>{agent.slackBotUserId}</span>
              </>}
            </div>
          </div>
        )}
        {!slackInfo && agent.slackBotUserId && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#f0fdf4', border: '1px solid #bbf7d0',
            borderRadius: 7, padding: '8px 12px', fontSize: 12,
          }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', flexShrink: 0 }} />
            <span style={{ color: '#15803d' }}>Connected ·</span>
            <span style={{ color: '#166534', fontFamily: 'var(--font-mono)' }}>Bot User ID: {agent.slackBotUserId}</span>
          </div>
        )}
      </Section>

      <Section title="Allowed Channels">
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          Restrict this bot to specific Slack channels. Enter one Slack channel ID per line (e.g. <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>C01234ABCDE</code>).
          If empty, the bot responds in all channels it's invited to.
          When invited to a non-allowed channel, it will post a notice and leave automatically.
          Bot-initiated messages from scheduled jobs are not affected.
        </p>
        <textarea
          value={allowedChannels}
          onChange={e => setAllowedChannels(e.target.value)}
          rows={4}
          readOnly={!canEdit}
          placeholder={'C01234ABCDE\nC09876ZYXWV'}
          style={{
            width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '10px 12px', color: 'var(--text)',
            fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7,
            outline: 'none', resize: 'vertical', boxSizing: 'border-box',
          }}
          onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
          onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
        />
      </Section>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {canEdit && <PrimaryBtn onClick={save} loading={saving}>Save Changes</PrimaryBtn>}
        <GhostBtn onClick={loadManifest}>View Slack Manifest</GhostBtn>
        {msg && <span style={{ fontSize: 12, color: '#16a34a' }}>{msg}</span>}
      </div>

      {showManifest && (
        <div style={{
          marginTop: 20, background: 'var(--surface-2)',
          border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 16px', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <span style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
              slack-manifest.json
            </span>
            <button
              onClick={() => navigator.clipboard.writeText(manifest)}
              style={{ fontSize: 11.5, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}
            >Copy</button>
          </div>
          <pre style={{
            margin: 0, padding: '16px', fontSize: 11.5, color: 'var(--accent)',
            fontFamily: 'var(--font-mono)', overflow: 'auto', maxHeight: 320,
          }}>{manifest}</pre>
        </div>
      )}

      {/* ── Danger Zone ── */}
      {isAdmin && (
        <div style={{
          marginTop: 40, borderTop: '1px solid var(--red-soft-border)', paddingTop: 28,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 16 }}>
            Danger Zone
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: 'var(--surface-2)', border: '1px solid var(--red-soft-border)', borderRadius: 8, padding: '14px 18px',
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 3 }}>Delete this agent</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Permanently removes the agent, all its skills, memories, and history. This cannot be undone.</div>
            </div>
            <button
              onClick={handleDelete}
              disabled={deleting}
              style={{
                flexShrink: 0, marginLeft: 24,
                padding: '8px 18px', borderRadius: 7, border: '1px solid #dc2626',
                background: deleting ? 'var(--surface-2)' : 'var(--surface)', color: '#dc2626',
                fontSize: 13, fontWeight: 600, cursor: deleting ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
              }}
            >{deleting ? 'Deleting…' : 'Delete Agent'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CLAUDE.md viewer ─────────────────────────────────────────────────────────

function InstructionsTab({ agent, canEdit, onAgentUpdate, onOpenCoach }: { agent: Agent; canEdit: boolean; onAgentUpdate: (a: Agent) => void; onOpenCoach?: () => void }) {
  // ── Export / Import ────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [importPreview, setImportPreview] = useState<AgentExportPayload | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persona library
  const [personaLibOpen, setPersonaLibOpen] = useState(false);
  const [libSearch, setLibSearch] = useState('');
  const [libCategory, setLibCategory] = useState<PersonaCategory | 'all'>('all');
  const [libSelected, setLibSelected] = useState<PersonaTemplate | null>(null);
  const [libSkillSel, setLibSkillSel] = useState<Set<string>>(new Set());
  const [libApplying, setLibApplying] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const [skillsRes, mdRes] = await Promise.all([
        fetch(`/api/agents/${agent.id}/skills`),
        fetch(`/api/agents/${agent.id}/claude-md`),
      ]);
      const skills: Skill[] = await skillsRes.json();
      const claudeMd = await mdRes.text();
      const payload: AgentExportPayload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        persona: agent.persona ?? '',
        description: agent.description ?? '',
        claudeMd,
        skills: skills.map(s => ({ category: s.category, filename: s.filename, content: s.content, sortOrder: s.sortOrder })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${agent.slug}-export.json`; a.click();
      URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImportError('');
    if (!file.name.endsWith('.json')) { setImportError('File must be a .json export'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data || typeof data !== 'object') { setImportError('Invalid file: not a JSON object'); return; }
        if (typeof data.claudeMd !== 'string') { setImportError('Invalid file: missing claudeMd field'); return; }
        if (!Array.isArray(data.skills)) { setImportError('Invalid file: missing skills array'); return; }
        for (let i = 0; i < data.skills.length; i++) {
          const s = data.skills[i];
          if (!s.category || typeof s.category !== 'string') { setImportError(`Invalid skill #${i + 1}: missing category`); return; }
          if (!s.filename || typeof s.filename !== 'string') { setImportError(`Invalid skill #${i + 1}: missing filename`); return; }
          if (typeof s.content !== 'string') { setImportError(`Invalid skill #${i + 1}: missing content`); return; }
        }
        setImportPreview(data);
      } catch { setImportError('Could not parse file — must be valid JSON'); }
    };
    reader.readAsText(file);
  };

  const applyImport = async (payload?: AgentExportPayload) => {
    const data = payload ?? importPreview;
    if (!data) return;
    setImporting(true);
    try {
      if (data.persona !== undefined || data.description !== undefined) {
        await fetch(`/api/agents/${agent.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(data.persona !== undefined && { persona: data.persona }),
            ...(data.description !== undefined && { description: data.description }),
          }),
        });
      }
      await fetch(`/api/agents/${agent.id}/claude-md`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: data.claudeMd,
      });
      await Promise.all(data.skills.map(s =>
        fetch(`/api/agents/${agent.id}/skills?noSnapshot=1`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s),
        })
      ));
      const updated = await fetch(`/api/agents/${agent.id}`).then(r => r.json());
      onAgentUpdate(updated);
      setImportPreview(null);
      window.dispatchEvent(new Event('slackhive:sidebar-refresh'));
    } finally { setImporting(false); }
  };

  return (
    <div className="fade-up">
      <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} />

      {/* ── Import confirmation modal ────────────────────────────────── */}
      {importPreview && (
        <Portal>
          <div style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} onClick={() => setImportPreview(null)}>
            <div style={{
              background: 'var(--surface)', borderRadius: 14, padding: '28px 32px',
              maxWidth: 480, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
            }} onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>
                Import agent config
              </h3>
              <div style={{
                display: 'flex', gap: 10, padding: '12px 14px', marginBottom: 16,
                background: 'var(--surface-2)', border: '1.5px solid var(--red-soft-border)', borderRadius: 8,
              }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#be123c', marginBottom: 2 }}>
                    This will overwrite current CLAUDE.md and skills
                  </div>
                  <div style={{ fontSize: 12, color: '#9f1239' }}>
                    Existing CLAUDE.md will be replaced. Skills with matching category/filename will be overwritten. A snapshot is saved automatically before applying.
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                {importPreview.exportedAt && <InfoRow label="Exported at" value={new Date(importPreview.exportedAt).toLocaleString()} />}
                <InfoRow label="Skills" value={`${importPreview.skills.length} skill${importPreview.skills.length !== 1 ? 's' : ''} will be upserted`} />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <PrimaryBtn onClick={() => applyImport()} loading={importing}>Apply Import</PrimaryBtn>
                <GhostBtn onClick={() => setImportPreview(null)}>Cancel</GhostBtn>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {/* ── Persona Library modal ────────────────────────────────────── */}
      {personaLibOpen && (
        <PersonaLibraryModal
          agentId={agent.id}
          fileInputRef={fileInputRef}
          applying={libApplying}
          search={libSearch}
          onSearchChange={setLibSearch}
          category={libCategory}
          onCategoryChange={setLibCategory}
          selected={libSelected}
          onSelectPersona={(p) => {
            setLibSelected(p);
            setLibSkillSel(new Set(p.skills.map(s => s.filename)));
          }}
          onBack={() => setLibSelected(null)}
          skillSel={libSkillSel}
          onToggleSkill={(fn) => setLibSkillSel(prev => {
            const next = new Set(prev);
            if (next.has(fn)) next.delete(fn); else next.add(fn);
            return next;
          })}
          onImportFull={async (template) => {
            setLibApplying(true);
            try {
              const existing = await fetch(`/api/agents/${agent.id}/skills`).then(r => r.json());
              await Promise.all((existing as { id: string }[]).map(s =>
                fetch(`/api/agents/${agent.id}/skills/${s.id}?noSnapshot=1`, { method: 'DELETE' })
              ));
              await applyImport({
                version: 1,
                persona: template.persona,
                description: template.description,
                claudeMd: template.claudeMd,
                skills: template.skills,
              });
            } finally {
              setLibApplying(false);
              setPersonaLibOpen(false);
              setLibSelected(null);
            }
          }}
          onImportSkills={async (template, selected) => {
            setLibApplying(true);
            try {
              const skills = template.skills.filter(s => selected.has(s.filename));
              await Promise.all(skills.map(s =>
                fetch(`/api/agents/${agent.id}/skills?noSnapshot=1`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s),
                })
              ));
              const updated = await fetch(`/api/agents/${agent.id}`).then(r => r.json());
              onAgentUpdate(updated);
              window.dispatchEvent(new Event('slackhive:sidebar-refresh'));
            } finally {
              setLibApplying(false);
              setPersonaLibOpen(false);
              setLibSelected(null);
            }
          }}
          onClose={() => { setPersonaLibOpen(false); setLibSelected(null); setLibSearch(''); setLibCategory('all'); }}
        />
      )}

      {/* ── System Prompt ───────────────────────────────────────────────── */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            System Prompt
            {importError && <span style={{ fontSize: 11, color: 'var(--danger)', marginLeft: 8, fontWeight: 400, textTransform: 'none' }}>{importError}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {canEdit && <IconBtn title="Export instructions as JSON" onClick={handleExport} loading={exporting}>
              <Download size={14} />
            </IconBtn>}
            {canEdit && (
              <IconBtn title="Import persona" onClick={() => setPersonaLibOpen(true)}>
                <Upload size={14} />
              </IconBtn>
            )}
            {canEdit && !agent.isBoss && (
              <>
                <div style={{ width: 1, height: 16, background: 'var(--border)' }} />
                <button onClick={() => onOpenCoach?.()} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)', borderRadius: 7,
                  padding: '5px 12px', fontSize: 12, fontWeight: 500,
                  cursor: 'pointer', fontFamily: 'var(--font-sans)',
                  color: 'var(--text)',
                }}>
                  <Wand2 size={13} /> Coach
                </button>
              </>
            )}
          </div>
        </div>
        {agent.isBoss ? (
          <>
            <p style={{ fontSize: 12, color: 'var(--subtle)', margin: '0 0 10px' }}>
              Auto-generated from your team roster. Updates automatically when agents are added or removed.
            </p>
            <ClaudeMdSection agentId={agent.id} canEdit={false} />
          </>
        ) : (
          <>
            <p style={{ fontSize: 12, color: 'var(--subtle)', margin: '0 0 10px' }}>
              Define how this agent should behave — its rules, workflows, and response style. This is always in the agent&apos;s context.
            </p>
            <ClaudeMdSection agentId={agent.id} canEdit={canEdit} />
          </>
        )}
      </div>

      {/* ── Skills / Memory sub-tabs ──────────────────────────────────── */}
      <InstructionsSubTabs agentId={agent.id} canEdit={canEdit} agentName={agent.name} agentPersona={agent.persona ?? ''} agentDescription={agent.description ?? ''} />
    </div>
  );
}

function InstructionsSubTabs({ agentId, canEdit, agentName, agentPersona, agentDescription }: { agentId: string; canEdit: boolean; agentName: string; agentPersona: string; agentDescription: string }) {
  const [subTab, setSubTab] = useState<'skills' | 'memory'>('skills');

  return (
    <div>
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
        {(['skills', 'memory'] as const).map(t => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            style={{
              padding: '8px 18px', fontSize: 13, fontWeight: subTab === t ? 600 : 400,
              color: subTab === t ? 'var(--text)' : 'var(--muted)',
              background: 'none', border: 'none', borderBottom: subTab === t ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {t === 'skills' ? 'Skills' : 'Memory'}
          </button>
        ))}
      </div>
      {subTab === 'skills' && (
        <div>
          <p style={{ fontSize: 12, color: 'var(--subtle)', margin: '0 0 10px' }}>
            Specialized knowledge files the agent uses on demand via /commands. Add domain expertise, workflows, or reference docs.
          </p>
          <SkillsTab agentId={agentId} canEdit={canEdit} agentName={agentName} agentPersona={agentPersona} agentDescription={agentDescription} />
        </div>
      )}
      {subTab === 'memory' && (
        <div>
          <p style={{ fontSize: 12, color: 'var(--subtle)', margin: '0 0 10px' }}>
            Learned from conversations — the agent asks before saving. Open Coach to review and clean up.
          </p>
          <MemorySection agentId={agentId} canEdit={canEdit} />
        </div>
      )}
    </div>
  );
}

function ClaudeMdSection({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [dirty, setDirty] = useState(false);

  const refetch = () => {
    setLoading(true);
    fetch(`/api/agents/${agentId}/claude-md`)
      .then(r => r.text())
      .then(t => { setContent(t); setDirty(false); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { refetch(); }, [agentId]);

  // Re-fetch when Coach applies / finishes bootstrapping, but don't clobber
  // a user's in-flight edits.
  useEffect(() => {
    const h = () => { if (!dirty) refetch(); };
    window.addEventListener('slackhive:instructions-refresh', h);
    return () => window.removeEventListener('slackhive:instructions-refresh', h);
  }, [agentId, dirty]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/claude-md`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content,
      });
      if (!res.ok) throw new Error(await res.text());
      setDirty(false);
      setMsg('Saved');
      setTimeout(() => setMsg(''), 3000);
    } catch (e: any) {
      setMsg(`Error: ${e.message}`);
    } finally { setSaving(false); }
  };

  if (loading) return <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading...</p>;

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        value={content}
        onChange={e => { setContent(e.target.value); setDirty(true); }}
        readOnly={!canEdit}
        placeholder="Write the agent's core instructions here — rules, workflows, response style..."
        style={{
          width: '100%', minHeight: 120, maxHeight: '50vh',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '14px 16px', fontSize: 12.5, lineHeight: 1.7,
          color: 'var(--text)', fontFamily: 'var(--font-mono)',
          resize: 'vertical', outline: 'none', boxSizing: 'border-box',
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
      />
      {(dirty || msg) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          {canEdit && dirty && (
            <button onClick={save} disabled={saving} style={{
              background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
              borderRadius: 6, padding: '5px 14px', fontSize: 12, fontWeight: 500,
              cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)',
            }}>{saving ? 'Saving...' : 'Save'}</button>
          )}
          {msg && <span style={{ fontSize: 12, color: msg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{msg}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Skills ───────────────────────────────────────────────────────────────────

function SkillsTab({ agentId, canEdit, agentName, agentPersona, agentDescription }: { agentId: string; canEdit: boolean; agentName: string; agentPersona: string; agentDescription: string }) {
  const [skills, setSkills]     = useState<Skill[]>([]);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [content, setContent]   = useState('');
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState('');
  const [showNew, setShowNew]   = useState(false);
  const [newSkill, setNewSkill] = useState({ category: '', filename: '', content: '' });

  const load = () =>
    fetch(`/api/agents/${agentId}/skills`).then(r => r.json()).then(setSkills);

  useEffect(() => { load(); }, [agentId]);

  // Re-fetch when Coach applies / finishes bootstrapping.
  useEffect(() => {
    const h = () => load();
    window.addEventListener('slackhive:instructions-refresh', h);
    return () => window.removeEventListener('slackhive:instructions-refresh', h);
  }, [agentId]);

  const select = (s: Skill) => { setSelected(s); setContent(s.content); };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    await fetch(`/api/agents/${agentId}/skills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: selected.category, filename: selected.filename, content, sortOrder: selected.sortOrder }),
    });
    setSaving(false); setMsg('Saved'); setTimeout(() => setMsg(''), 2000); load();
  };

  const remove = async (s: Skill) => {
    if (!confirm(`Delete ${s.category}/${s.filename}?`)) return;
    await fetch(`/api/agents/${agentId}/skills/${s.id}`, { method: 'DELETE' });
    if (selected?.id === s.id) { setSelected(null); setContent(''); }
    load();
  };

  const create = async () => {
    if (!newSkill.category || !newSkill.filename) return;
    await fetch(`/api/agents/${agentId}/skills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSkill),
    });
    setShowNew(false); setNewSkill({ category: '', filename: '', content: '' }); load();
  };

  // Virtual identity row — computed from agent fields, not stored in DB
  const identityVirtual: Skill = {
    id: '__identity__',
    agentId,
    category: '00-core',
    filename: 'identity.md',
    sortOrder: -1,
    content: [`# ${agentName}`, agentPersona, agentDescription].filter(Boolean).join('\n\n'),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const grouped = skills.reduce<Record<string, Skill[]>>((acc, s) => {
    (acc[s.category] ??= []).push(s); return acc;
  }, {});

  const isIdentity = selected?.id === '__identity__';

  return (
    <div className="fade-up" style={{ display: 'flex', gap: 14, height: 580 }}>
      {/* File tree */}
      <div style={{
        width: 220, flexShrink: 0,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, overflow: 'auto', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Files
          </span>
          {canEdit && <button onClick={() => setShowNew(true)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 12, color: 'var(--accent)', fontFamily: 'var(--font-sans)',
          }}>+ New</button>}
        </div>
        <div style={{ padding: '6px 6px', flex: 1, overflow: 'auto' }}>
          {/* Virtual identity row — always first */}
          <div>
            <div style={{
              fontSize: 10.5, color: 'var(--subtle)', padding: '6px 6px 2px',
              fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
            }}>00-core/</div>
            <div
              onClick={() => select(identityVirtual)}
              className="skill-row"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                fontSize: 12, fontFamily: 'var(--font-mono)',
                background: selected?.id === '__identity__' ? 'rgba(59,130,246,0.12)' : 'transparent',
                color: selected?.id === '__identity__' ? 'var(--accent)' : 'var(--muted)',
                transition: 'background 0.12s, color 0.12s',
              }}
              onMouseEnter={e => { if (selected?.id !== '__identity__') (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
              onMouseLeave={e => { if (selected?.id !== '__identity__') (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>identity.md</span>
              <span style={{ fontSize: 9, color: 'var(--subtle)', flexShrink: 0 }}>locked</span>
            </div>
          </div>
          {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([cat, catSkills]) => (
            <div key={cat}>
              <div style={{
                fontSize: 10.5, color: 'var(--subtle)', padding: '6px 6px 2px',
                fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
              }}>{cat}/</div>
              {catSkills.map(s => (
                <div
                  key={s.id}
                  onClick={() => select(s)}
                  className="skill-row"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                    fontSize: 12, fontFamily: 'var(--font-mono)',
                    background: selected?.id === s.id ? 'rgba(59,130,246,0.12)' : 'transparent',
                    color: selected?.id === s.id ? 'var(--accent)' : 'var(--muted)',
                    transition: 'background 0.12s, color 0.12s',
                  }}
                  onMouseEnter={e => {
                    if (selected?.id !== s.id) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)';
                    const btn = (e.currentTarget as HTMLElement).querySelector('.delete-btn') as HTMLElement | null;
                    if (btn) btn.style.opacity = '1';
                  }}
                  onMouseLeave={e => {
                    if (selected?.id !== s.id) (e.currentTarget as HTMLElement).style.background = 'transparent';
                    const btn = (e.currentTarget as HTMLElement).querySelector('.delete-btn') as HTMLElement | null;
                    if (btn) btn.style.opacity = '0';
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.filename}</span>
                  {canEdit && <button
                    onClick={e => { e.stopPropagation(); remove(s); }}
                    className="delete-btn"
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: '#ef4444', fontSize: 14, opacity: 0, transition: 'opacity 0.12s',
                      fontFamily: 'var(--font-sans)', lineHeight: 1, padding: '0 2px', flexShrink: 0,
                    }}
                  >×</button>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div style={{
        flex: 1, background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {selected ? (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 16px', borderBottom: '1px solid var(--border)',
              background: 'var(--surface-2)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                  {selected.category}/{selected.filename}
                </span>
                {isIdentity && <span style={{ fontSize: 10, color: 'var(--subtle)', background: 'var(--surface-3)', padding: '1px 6px', borderRadius: 3 }}>read-only · edit in Overview</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {msg && <span style={{ fontSize: 11.5, color: '#16a34a' }}>{msg}</span>}
                {canEdit && !isIdentity && <button
                  onClick={save} disabled={saving}
                  style={{
                    background: saving ? 'var(--border)' : 'var(--accent)',
                    color: 'var(--accent-fg)', border: 'none', borderRadius: 6,
                    padding: '5px 14px', fontSize: 12, fontWeight: 500,
                    cursor: saving ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>}
              </div>
            </div>
            <textarea
              value={isIdentity ? identityVirtual.content : content}
              onChange={e => { if (!isIdentity) setContent(e.target.value); }}
              readOnly={!canEdit || isIdentity}
              style={{
                flex: 1, border: 'none', outline: 'none', resize: 'none',
                background: 'transparent', color: 'var(--text)',
                fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.65,
                padding: '16px', caretColor: 'var(--accent)',
              }}
              spellCheck={false}
            />
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--subtle)', fontSize: 13 }}>
            Select a file to edit
          </div>
        )}
      </div>

      {/* New skill modal */}
      {showNew && (
        <Modal title="New Skill File" onClose={() => setShowNew(false)}>
          <Field label="Category" value={newSkill.category}
            onChange={v => setNewSkill(s => ({ ...s, category: v }))} hint="e.g. 00-core" />
          <Field label="Filename" value={newSkill.filename}
            onChange={v => setNewSkill(s => ({ ...s, filename: v }))} hint="e.g. api-design.md" />
          <TextArea label="Content (optional)" value={newSkill.content}
            onChange={v => setNewSkill(s => ({ ...s, content: v }))} rows={4} />
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <PrimaryBtn onClick={create}>Create</PrimaryBtn>
            <GhostBtn onClick={() => setShowNew(false)}>Cancel</GhostBtn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── MCPs ─────────────────────────────────────────────────────────────────────

function ToolsTab({ agentId, canEdit, canManageMcps, currentUsername }: { agentId: string; canEdit: boolean; canManageMcps: boolean; currentUsername: string }) {
  return (
    <div className="fade-up">
      {/* Section 1: Connected Apps (MCPs) */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 14 }}>
          Connected Apps
        </div>
        <McpsSection agentId={agentId} canEdit={canEdit} canManageMcps={canManageMcps} currentUsername={currentUsername} />
      </div>

      {/* Section 2: Capabilities */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 14 }}>
          Capabilities
        </div>
        <PermissionsTab agentId={agentId} canEdit={canEdit} />
      </div>
    </div>
  );
}

function McpsSection({ agentId, canEdit, canManageMcps, currentUsername }: { agentId: string; canEdit: boolean; canManageMcps: boolean; currentUsername: string }) {
  const [all, setAll]         = useState<McpServer[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState('');

  useEffect(() => {
    Promise.all([
      fetch('/api/mcps').then(r => r.json()),
      fetch(`/api/agents/${agentId}/mcps`).then(r => r.json()),
    ]).then(([a, b]: [McpServer[], McpServer[]]) => {
      setAll(a); setAssigned(new Set(b.map(m => m.id)));
    });
  }, [agentId]);

  const toggle = (id: string) =>
    setAssigned(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const save = async () => {
    setSaving(true);
    await fetch(`/api/agents/${agentId}/mcps`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpIds: [...assigned] }),
    });
    setSaving(false); setMsg('Saved & reload triggered');
    setTimeout(() => setMsg(''), 3000);
  };

  return (
    <div style={{ maxWidth: 560 }} className="fade-up">
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)' }}>
        Select MCP servers from the platform catalog to enable for this agent.
      </p>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
        {all.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No MCP servers yet.{' '}
            <Link href="/settings/mcps" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Add some →</Link>
          </div>
        ) : all.map((mcp, i) => {
          const canAssign = canManageMcps || mcp.createdBy === currentUsername;
          const isDisabled = !mcp.enabled || !canEdit || !canAssign;
          return (
            <label
              key={mcp.id}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                padding: '13px 16px', cursor: isDisabled ? 'not-allowed' : 'pointer',
                borderBottom: i < all.length - 1 ? '1px solid var(--border)' : 'none',
                background: 'transparent', transition: 'background 0.12s',
                opacity: mcp.enabled ? 1 : 0.45,
              }}
              onMouseEnter={e => { if (!isDisabled) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <input
                type="checkbox"
                checked={assigned.has(mcp.id)}
                onChange={() => toggle(mcp.id)}
                disabled={isDisabled}
                style={{ accentColor: 'var(--accent)', width: 14, height: 14, flexShrink: 0, marginTop: 2 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{mcp.name}</span>
                  <span style={{
                    fontSize: 10.5, fontFamily: 'var(--font-mono)',
                    color: 'var(--muted)', background: 'var(--border)',
                    padding: '1px 6px', borderRadius: 4,
                  }}>{mcp.type}</span>
                  {!mcp.enabled && <span style={{ fontSize: 11, color: 'var(--subtle)' }}>disabled</span>}
                </div>
                {mcp.description && <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{mcp.description}</p>}
                {!canAssign && (
                  <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--subtle)' }}>
                    Only the MCP owner or an admin can assign this
                  </p>
                )}
              </div>
            </label>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {canEdit && <PrimaryBtn onClick={save} loading={saving}>Save Assignments</PrimaryBtn>}
        {msg && <span style={{ fontSize: 12, color: '#16a34a' }}>{msg}</span>}
      </div>
    </div>
  );
}

// ─── Permissions ──────────────────────────────────────────────────────────────

const BASE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
const INTERNET_TOOLS = ['WebSearch', 'WebFetch'];
const SHELL_TOOLS = ['Bash'];

function PermissionsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [allowed, setAllowed] = useState<string[]>([]);
  const [denied,  setDenied]  = useState<string[]>([]);
  const [saving,  setSaving]  = useState(false);
  const [msg,     setMsg]     = useState('');

  const internetOn = INTERNET_TOOLS.every(t => allowed.includes(t));
  const shellOn = SHELL_TOOLS.some(t => allowed.includes(t));

  useEffect(() => {
    fetch(`/api/agents/${agentId}/permissions`).then(r => r.json()).then((p: Permission) => {
      setAllowed(p.allowedTools ?? []);
      setDenied(p.deniedTools ?? []);
    });
  }, [agentId]);

  const save = async (newAllowed: string[], newDenied: string[]) => {
    setSaving(true);
    await fetch(`/api/agents/${agentId}/permissions`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowedTools: newAllowed, deniedTools: newDenied }),
    });
    setSaving(false); setMsg('Saved'); setTimeout(() => setMsg(''), 2000);
  };

  const toggleCapability = (tools: string[], enable: boolean) => {
    let next = enable
      ? [...new Set([...allowed, ...tools])]
      : allowed.filter(t => !tools.includes(t));
    for (const t of BASE_TOOLS) { if (!next.includes(t)) next = [t, ...next]; }
    setAllowed(next);
    save(next, denied);
  };

  return (
    <div style={{ maxWidth: 500 }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, overflow: 'hidden',
      }}>
        {/* Internet Access */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>Internet Access</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              Web search and fetch
            </div>
          </div>
          <label style={{ position: 'relative', display: 'inline-block', width: 40, height: 22, flexShrink: 0 }}>
            <input type="checkbox" checked={internetOn} disabled={!canEdit}
              onChange={e => toggleCapability(INTERNET_TOOLS, e.target.checked)}
              style={{ opacity: 0, width: 0, height: 0 }} />
            <span style={{
              position: 'absolute', cursor: canEdit ? 'pointer' : 'default', inset: 0, borderRadius: 11,
              background: internetOn ? 'var(--green)' : 'var(--border-2)', transition: 'background 0.2s',
            }}>
              <span style={{
                position: 'absolute', width: 16, height: 16, borderRadius: '50%', background: '#fff',
                top: 3, left: internetOn ? 21 : 3, transition: 'left 0.2s',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </span>
          </label>
        </div>

        {/* Shell Access */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px',
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>Shell Access</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              Terminal commands (dangerous commands auto-blocked)
            </div>
          </div>
          <label style={{ position: 'relative', display: 'inline-block', width: 40, height: 22, flexShrink: 0 }}>
            <input type="checkbox" checked={shellOn} disabled={!canEdit}
              onChange={e => toggleCapability(SHELL_TOOLS, e.target.checked)}
              style={{ opacity: 0, width: 0, height: 0 }} />
            <span style={{
              position: 'absolute', cursor: canEdit ? 'pointer' : 'default', inset: 0, borderRadius: 11,
              background: shellOn ? 'var(--green)' : 'var(--border-2)', transition: 'background 0.2s',
            }}>
              <span style={{
                position: 'absolute', width: 16, height: 16, borderRadius: '50%', background: '#fff',
                top: 3, left: shellOn ? 21 : 3, transition: 'left 0.2s',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </span>
          </label>
        </div>
      </div>
      {msg && <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 10 }}>{msg}</div>}
    </div>
  );
}

// ─── Memory ───────────────────────────────────────────────────────────────────

const MEM_TYPE_STYLE: Record<string, { bg: string; color: string }> = {
  user:      { bg: '#f3f0ff', color: '#7c3aed' },
  feedback:  { bg: '#eff6ff', color: '#2563eb' },
  project:   { bg: 'var(--amber-soft-bg)', color: '#b45309' },
  reference: { bg: '#f0fdf4', color: '#15803d' },
};

function MemorySection({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = () => fetch(`/api/agents/${agentId}/memories`).then(r => r.json()).then(setMemories);
  useEffect(() => { load(); }, [agentId]);

  const remove = async (id: string) => {
    await fetch(`/api/agents/${agentId}/memories/${id}`, { method: 'DELETE' });
    load();
  };

  const toggle = (id: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const grouped = memories.reduce<Record<string, Memory[]>>((acc, m) => {
    (acc[m.type] ??= []).push(m); return acc;
  }, {});

  if (memories.length === 0) {
    return (
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, padding: '40px 20px',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        color: 'var(--muted)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}><Brain size={32} style={{ color: 'var(--border-2)' }} /></div>
        <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: 'var(--text)', textAlign: 'center' }}>
          No memories yet
        </p>
        <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 300, margin: '0', textAlign: 'center' }}>
          The agent will automatically accumulate memories as it interacts in Slack.
        </p>
      </div>
    );
  }

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '16px 18px',
    }}>
      <div style={{ marginBottom: 14 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {memories.length} memor{memories.length === 1 ? 'y' : 'ies'}
        </span>
      </div>

      {(['feedback', 'user', 'project', 'reference'] as const).map(type => {
        const items = grouped[type];
        if (!items?.length) return null;
        const style = MEM_TYPE_STYLE[type] ?? { bg: 'var(--border)', color: 'var(--muted)' };
        return (
          <div key={type} style={{ marginBottom: 20 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
            }}>
              <span style={{
                fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em',
                textTransform: 'uppercase',
                background: style.bg, color: style.color,
                padding: '2px 8px', borderRadius: 5,
              }}>{type}</span>
              <span style={{ fontSize: 11.5, color: 'var(--subtle)' }}>{items.length}</span>
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              {items.map((m, i) => (
                <div key={m.id} style={{ borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 14px', cursor: 'pointer',
                  }} onClick={() => toggle(m.id)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ fontSize: 11, color: 'var(--subtle)' }}>
                        {expanded.has(m.id) ? '▼' : '▶'}
                      </span>
                      <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
                        {m.name}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 11, color: 'var(--subtle)' }}>
                        {new Date(m.updatedAt).toLocaleDateString()}
                      </span>
                      {canEdit && <button
                        onClick={e => { e.stopPropagation(); remove(m.id); }}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: '#ef4444', fontSize: 13, opacity: 0.5, transition: 'opacity 0.12s',
                          fontFamily: 'var(--font-sans)',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                        onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
                      >Delete</button>}
                    </div>
                  </div>
                  {expanded.has(m.id) && (
                    <pre style={{
                      margin: 0, padding: '12px 14px',
                      background: 'var(--surface-2)',
                      borderTop: '1px solid var(--border)',
                      fontFamily: 'var(--font-mono)', fontSize: 11.5,
                      color: 'var(--muted)', whiteSpace: 'pre-wrap', lineHeight: 1.6,
                    }}>{m.content}</pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Wiki Tree ──────────────────────────────────────────────────────────────

type WikiArticle = { path: string; title: string; size: number };
type TreeNode = { name: string; path?: string; title?: string; size?: number; children: TreeNode[] };

function buildTree(articles: WikiArticle[]): TreeNode[] {
  const root: TreeNode = { name: '', children: [] };
  for (const article of articles) {
    const parts = article.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      let child = node.children.find(c => c.name === part);
      if (!child) {
        child = isFile
          ? { name: part, path: article.path, title: article.title, size: article.size, children: [] }
          : { name: part, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  // Sort: folders first, then files, alphabetical within each
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const aIsFolder = a.children.length > 0 && !a.path;
      const bIsFolder = b.children.length > 0 && !b.path;
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(root.children);
  return root.children;
}

const FOLDER_LABELS: Record<string, string> = {
  concepts: 'Concepts',
  entities: 'Entities',
  flows: 'Flows',
  modules: 'Modules',
};

function WikiTreeNode({ node, depth, onSelect, selected }: { node: TreeNode; depth: number; onSelect: (path: string) => void; selected: string | null }) {
  const [open, setOpen] = useState(true);
  const isFolder = !node.path && node.children.length > 0;
  const label = isFolder ? (FOLDER_LABELS[node.name] || node.name) : (node.title || node.name.replace('.md', ''));
  const isActive = node.path === selected;

  if (isFolder) {
    return (
      <div>
        <div onClick={() => setOpen(!open)} style={{
          display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
          padding: `6px 6px 2px ${6 + depth * 12}px`,
          fontSize: 10.5, color: 'var(--subtle)', fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
        }}>
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {label}/
        </div>
        {open && node.children.map(child => (
          <WikiTreeNode key={child.path || child.name} node={child} depth={depth + 1} onSelect={onSelect} selected={selected} />
        ))}
      </div>
    );
  }

  return (
    <div
      onClick={() => node.path && onSelect(node.path)}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: `4px 8px 4px ${8 + depth * 12}px`, borderRadius: 6, cursor: 'pointer',
        fontSize: 12, fontFamily: 'var(--font-mono)',
        background: isActive ? 'rgba(59,130,246,0.12)' : 'transparent',
        color: isActive ? 'var(--accent)' : 'var(--muted)',
        transition: 'background 0.12s, color 0.12s',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
      onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <FileText size={12} style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name.replace('.md', '')}</span>
    </div>
  );
}

function WikiTree({ articles, onSelect, selected }: { articles: WikiArticle[]; onSelect: (path: string) => void; selected: string | null }) {
  const tree = buildTree(articles);
  return (
    <div style={{ padding: '6px 6px', flex: 1, overflow: 'auto' }}>
      {tree.map(node => (
        <WikiTreeNode key={node.path || node.name} node={node} depth={0} onSelect={onSelect} selected={selected} />
      ))}
    </div>
  );
}

// ─── Knowledge ──────────────────────────────────────────────────────────────

function KnowledgeTab({ agentId, agentSlug, canEdit }: { agentId: string; agentSlug: string; canEdit: boolean }) {
  const [sources, setSources] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState<'url' | 'file' | 'repo'>('url');
  const [addName, setAddName] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addBranch, setAddBranch] = useState('main');
  const [addPat, setAddPat] = useState('');
  const [addContent, setAddContent] = useState('');
  const [addFile, setAddFile] = useState<File | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [envVarKeys, setEnvVarKeys] = useState<string[]>([]);
  const [editingSource, setEditingSource] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  // When editing a repo/url source, we reuse the Add form prefilled with the source's fields
  const [editingMetaId, setEditingMetaId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildStep, setBuildStep] = useState('');
  const [buildResult, setBuildResult] = useState<any>(null);
  const [buildError, setBuildError] = useState('');
  const [wikiData, setWikiData] = useState<{ articles: { path: string; title: string; size: number }[]; totalWords: number; lastBuilt: string | null } | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<string | null>(null);
  const [articleContent, setArticleContent] = useState('');
  const [loadingArticle, setLoadingArticle] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const wikiUploadRef = useRef<HTMLInputElement>(null);

  const loadSources = () => {
    fetch(`/api/agents/${agentId}/knowledge`).then(r => r.json()).then(setSources).catch(() => {});
  };
  const loadWiki = () => {
    fetch(`/api/agents/${agentId}/knowledge/wiki`).then(r => r.json()).then(data => {
      if (data.articles?.length > 0) setWikiData(data);
      else setWikiData(null);
    }).catch(() => {});
  };
  const load = () => { loadSources(); loadWiki(); };

  // Poll for an active build by requestId
  const pollBuild = async (reqId: string) => {
    setBuilding(true); setBuildError(''); setBuildStep('');
    for (let i = 0; i < 120; i++) {
      await new Promise(res => setTimeout(res, 2000));
      try {
        const poll = await fetch(`/api/agents/${agentId}/knowledge/build?requestId=${reqId}`);
        const data = await poll.json();
        if (data.step) setBuildStep(data.step);
        if (data.status === 'done') { setBuildResult(data); setBuilding(false); setBuildStep(''); load(); return; }
        if (data.status === 'error') { setBuildError(data.error); setBuilding(false); setBuildStep(''); return; }
      } catch { /* retry */ }
    }
    setBuildError('Build timed out.');
    setBuilding(false); setBuildStep('');
  };

  useEffect(() => {
    load();
    // Check if there's an active build in progress
    fetch(`/api/agents/${agentId}/knowledge/build`).then(r => r.json()).then(data => {
      if (data.status === 'pending' || data.status === 'building') {
        pollBuild(data.requestId);
      } else if (data.status === 'done') {
        setBuildResult(data);
      }
    }).catch(() => {});
  }, [agentId]);

  const viewArticle = async (articlePath: string) => {
    setSelectedArticle(articlePath);
    setLoadingArticle(true);
    try {
      const r = await fetch(`/api/agents/${agentId}/knowledge/wiki?path=${encodeURIComponent(articlePath)}`);
      const data = await r.json();
      setArticleContent(data.content ?? '');
    } catch { setArticleContent('Failed to load article.'); }
    finally { setLoadingArticle(false); }
  };

  const addSource = async () => {
    setSaving(true);
    setUploadError('');
    try {
      let res: Response;
      // File sources with a picked File: multipart upload so the server can
      // extract PDF/text content rather than trusting browser-side readAsText.
      if (!editingMetaId && addType === 'file' && addFile) {
        const fd = new FormData();
        fd.append('name', addName);
        fd.append('file', addFile);
        res = await fetch(`/api/agents/${agentId}/knowledge`, { method: 'POST', body: fd });
      } else {
        const body: any = { name: addName };
        if (addType === 'url') body.url = addUrl;
        if (addType === 'file') body.content = addContent;
        if (addType === 'repo') {
          body.repoUrl = addUrl;
          body.branch = addBranch;
          body.patEnvRef = addPat || null;
        }
        if (editingMetaId) {
          res = await fetch(`/api/agents/${agentId}/knowledge/${editingMetaId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
        } else {
          body.type = addType;
          res = await fetch(`/api/agents/${agentId}/knowledge`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
        }
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setUploadError(d.error ?? `Add failed (HTTP ${res.status})`);
        setSaving(false);
        return;
      }
    } catch (err) {
      setUploadError(`Add failed — ${(err as Error).message}`);
      setSaving(false);
      return;
    }
    setSaving(false);
    setShowAdd(false);
    setEditingMetaId(null);
    setAddName(''); setAddUrl(''); setAddContent(''); setAddBranch('main'); setAddPat(''); setAddFile(null);
    load();
  };

  const startEditMeta = (src: any) => {
    setEditingMetaId(src.id);
    setAddType(src.type);
    setAddName(src.name ?? '');
    setAddUrl(src.type === 'repo' ? (src.repoUrl ?? '') : (src.url ?? ''));
    setAddContent(src.content ?? '');
    setAddBranch(src.branch ?? 'main');
    setAddPat(src.patEnvRef ?? '');
    setAddFile(null);
    setShowAdd(true);
    // Populate the PAT dropdown — otherwise the "Auth" field has no env vars to choose from.
    fetch('/api/env-vars').then(r => r.json()).then((vars: any[]) => setEnvVarKeys(vars.map(v => v.key))).catch(() => {});
  };

  const deleteSource = async (id: string) => {
    await fetch(`/api/agents/${agentId}/knowledge/${id}`, { method: 'DELETE' });
    load();
  };

  const startEditSource = (src: any) => {
    setEditingSource(src.id);
    setEditContent(src.content || '');
  };

  const saveEditSource = async () => {
    if (!editingSource) return;
    await fetch(`/api/agents/${agentId}/knowledge/${editingSource}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editContent }),
    });
    setEditingSource(null);
    setEditContent('');
    load();
  };

  const buildWiki = async () => {
    if (building || syncing) { setBuildError('A build is already running.'); return; }
    setBuildResult(null); setBuildError('');
    try {
      const r = await fetch(`/api/agents/${agentId}/knowledge/build`, { method: 'POST' });
      const { requestId } = await r.json();
      await pollBuild(requestId);
    } catch (err) { setBuildError((err as Error).message); setBuilding(false); }
  };

  const syncSource = async (sourceId: string) => {
    if (building || syncing) { setBuildError('A build is already running.'); return; }
    setSyncing(sourceId); setBuildResult(null); setBuildError('');
    try {
      const r = await fetch(`/api/agents/${agentId}/knowledge/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId }),
      });
      const { requestId } = await r.json();
      await pollBuild(requestId);
    } catch (err) { setBuildError((err as Error).message); }
    finally { setSyncing(null); }
  };

  const TypeIcon = ({ type }: { type: string }) => {
    const style = { color: 'var(--muted)', flexShrink: 0 } as const;
    if (type === 'url') return <Link2 size={16} style={style} />;
    if (type === 'repo') return <GitBranch size={16} style={style} />;
    return <FileText size={16} style={style} />;
  };

  return (
    <div className="fade-up">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            Add documents, URLs, or repos — Claude compiles them into a wiki your agent references.
            {' '}<a href="https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 12 }}>Inspired by Karpathy's LLM Wiki</a>
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canEdit && sources.length > 0 && (
            <button onClick={buildWiki} disabled={building} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: building ? 'var(--surface-2)' : 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 7,
              padding: '6px 14px', fontSize: 12, fontWeight: 500,
              cursor: building ? 'wait' : 'pointer', fontFamily: 'var(--font-sans)',
              color: building ? 'var(--muted)' : 'var(--text)',
            }}>
              {building ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Building...</> : <><Wand2 size={13} /> Build Wiki</>}
            </button>
          )}
          {canEdit && (
            <button onClick={() => { setShowAdd(true); fetch('/api/env-vars').then(r => r.json()).then(vars => setEnvVarKeys(vars.map((v: any) => v.key))).catch(() => {}); }} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: 'var(--accent)', color: 'var(--accent-fg)',
              border: 'none', borderRadius: 7, padding: '6px 14px',
              fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>+ Add Source</button>
          )}
        </div>
      </div>

      {/* Upload error */}
      {uploadError && (
        <div style={{ background: 'var(--red-soft-bg)', border: '1px solid var(--red-soft-border)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, color: 'var(--red)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {uploadError}
          <button onClick={() => setUploadError('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
        </div>
      )}

      {/* Build progress */}
      {building && buildStep && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', marginBottom: 14,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
        }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{buildStep}</span>
        </div>
      )}

      {/* Build result */}
      {buildError && (
        <div style={{ background: 'var(--red-soft-bg)', border: '1px solid var(--red-soft-border)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, color: 'var(--red)' }}>
          {buildError}
        </div>
      )}
      {buildResult && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>Wiki built: </span>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>{buildResult.articles} articles · {buildResult.words?.toLocaleString()} words</span>
          {buildResult.summary && <p style={{ fontSize: 12, color: 'var(--subtle)', margin: '4px 0 0' }}>{buildResult.summary}</p>}
        </div>
      )}

      {/* Add / Edit source form */}
      {showAdd && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', marginBottom: 16 }}>
          {editingMetaId && (
            <div style={{ fontSize: 11.5, color: 'var(--subtle)', marginBottom: 10, fontWeight: 500, letterSpacing: 0.3, textTransform: 'uppercase' }}>
              Editing source
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {(['url', 'file', 'repo'] as const).map(t => (
              <button key={t} onClick={() => !editingMetaId && setAddType(t)} disabled={!!editingMetaId && addType !== t} style={{
                padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                background: addType === t ? 'var(--accent)' : 'var(--surface-2)',
                color: addType === t ? 'var(--accent-fg)' : 'var(--muted)',
                border: `1px solid ${addType === t ? 'var(--accent)' : 'var(--border)'}`,
                cursor: editingMetaId ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)',
                opacity: editingMetaId && addType !== t ? 0.4 : 1,
              }}><TypeIcon type={t} /> {t === 'url' ? 'URL' : t === 'file' ? 'File' : 'Git Repo'}</button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input value={addName} onChange={e => setAddName(e.target.value)} placeholder="Source name"
              style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-sans)' }} />

            {addType === 'url' && (
              <input value={addUrl} onChange={e => setAddUrl(e.target.value)} placeholder="https://docs.example.com/api"
                style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)' }} />
            )}

            {addType === 'file' && (
              <>
                <div style={{
                  border: `2px dashed ${addFile ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 8, padding: '20px 16px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  cursor: 'pointer', background: addFile ? 'var(--surface)' : 'var(--surface-2)',
                  transition: 'border-color 0.15s, background 0.15s',
                }} onClick={() => document.getElementById('knowledge-file-input')?.click()}
                   onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--accent)'; }}
                   onDragLeave={e => { e.currentTarget.style.borderColor = addFile ? 'var(--accent)' : 'var(--border)'; }}
                   onDrop={e => {
                     e.preventDefault();
                     e.currentTarget.style.borderColor = 'var(--accent)';
                     const file = e.dataTransfer.files[0];
                     if (file) {
                       setAddFile(file);
                       setAddContent('');
                       if (!addName) setAddName(file.name.replace(/\.[^.]+$/, ''));
                     }
                   }}>
                  {addFile ? (
                    <FileText size={20} style={{ color: 'var(--accent)' }} />
                  ) : (
                    <Upload size={20} style={{ color: 'var(--muted)' }} />
                  )}
                  <p style={{ margin: 0, fontSize: 12, fontWeight: addFile ? 600 : 400, color: addFile ? 'var(--text)' : 'var(--muted)' }}>
                    {addFile ? addFile.name : 'Click to upload or drag and drop'}
                  </p>
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--subtle)' }}>
                    {addFile ? `${(addFile.size / 1024).toFixed(1)} KB — ready to upload. Click to replace.` : '.txt, .md, .csv, .json, .yaml, .xml, .html, .rst, .pdf'}
                  </p>
                  <input id="knowledge-file-input" type="file" accept=".txt,.md,.csv,.json,.pdf,.rst,.yaml,.yml,.xml,.html"
                    style={{ display: 'none' }} onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setAddFile(file);
                        setAddContent('');
                        if (!addName) setAddName(file.name.replace(/\.[^.]+$/, ''));
                      }
                    }} />
                </div>
                {addFile && (
                  <div style={{ fontSize: 11, color: 'var(--subtle)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                    <button onClick={() => setAddFile(null)} style={{
                      background: 'none', border: 'none', color: 'var(--red)', fontSize: 11,
                      cursor: 'pointer', fontFamily: 'var(--font-sans)', opacity: 0.7,
                    }}>Clear</button>
                  </div>
                )}
                <textarea value={addContent} onChange={e => { setAddContent(e.target.value); if (e.target.value) setAddFile(null); }} placeholder="Or paste content here..."
                  rows={addContent ? 8 : 4} style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font-mono)', resize: 'vertical', lineHeight: 1.5 }} />
              </>
            )}

            {addType === 'repo' && (
              <>
                <input value={addUrl} onChange={e => setAddUrl(e.target.value)} placeholder="https://github.com/org/repo"
                  style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)' }} />
                <input value={addBranch} onChange={e => setAddBranch(e.target.value)} placeholder="Branch (default: main)"
                  style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)' }} />
                <select value={addPat} onChange={e => setAddPat(e.target.value)}
                  style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12, color: addPat ? 'var(--text)' : 'var(--subtle)', fontFamily: 'var(--font-sans)' }}>
                  <option value="">No auth (public repo)</option>
                  {envVarKeys.map(k => <option key={k} value={k}>{k}</option>)}
                  {envVarKeys.length === 0 && <option disabled>No env vars — add in Settings</option>}
                </select>
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={addSource} disabled={saving || !addName || (addType === 'file' && !editingMetaId && !addFile && !addContent.trim())} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 7,
              padding: '7px 16px', fontSize: 12, fontWeight: 500, cursor: saving ? 'wait' : 'pointer', fontFamily: 'var(--font-sans)',
              opacity: saving ? 0.8 : 1,
            }}>
              {saving && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />}
              {saving
                ? (editingMetaId ? 'Saving...' : (addType === 'file' && addFile ? 'Uploading & extracting...' : 'Adding...'))
                : (editingMetaId ? 'Save Changes' : 'Add Source')}
            </button>
            <button onClick={() => {
              setShowAdd(false);
              setEditingMetaId(null);
              setAddName(''); setAddUrl(''); setAddContent(''); setAddBranch('main'); setAddPat(''); setAddFile(null);
            }} style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7,
              padding: '7px 16px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-sans)', color: 'var(--text)',
            }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Sources list */}
      {sources.length === 0 && !showAdd ? (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '40px 20px', textAlign: 'center',
        }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}><Brain size={28} style={{ color: 'var(--border-2)' }} /></div>
          <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 500, color: 'var(--muted)' }}>No knowledge sources yet</p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--subtle)' }}>Add URLs, files, or git repos to build a knowledge wiki.</p>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {sources.map((src, i) => (
            <React.Fragment key={src.id}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
              borderBottom: i < sources.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <TypeIcon type={src.type} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{src.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {src.type} · {src.url || src.repoUrl || `${src.wordCount} words`}
                  {src.branch && src.type === 'repo' && ` · ${src.branch}`}
                </div>
              </div>
              {(syncing === src.id || (building && buildStep.toLowerCase().includes(src.name.toLowerCase()))) ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: 'rgba(59,130,246,0.1)', color: 'var(--accent)' }}>
                  <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} /> {syncing === src.id ? 'syncing' : 'building'}
                </span>
              ) : (
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
                  background: src.status === 'compiled' ? 'rgba(16,185,129,0.1)' : src.status === 'error' ? 'var(--red-soft-bg)' : 'var(--surface-2)',
                  color: src.status === 'compiled' ? 'var(--green)' : src.status === 'error' ? 'var(--red)' : 'var(--subtle)',
                }}>{src.status}</span>
              )}
              {canEdit && (
                <button onClick={() => src.type === 'file' ? startEditSource(src) : startEditMeta(src)} style={{
                  background: 'none', border: 'none', fontSize: 12, cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', opacity: 0.6, color: 'var(--text)',
                }}>Edit</button>
              )}
              {canEdit && src.status === 'compiled' && (
                <button onClick={() => syncSource(src.id)} disabled={!!syncing || building} style={{
                  background: 'none', border: 'none', fontSize: 12, cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', opacity: syncing === src.id ? 1 : 0.6,
                  color: syncing === src.id ? 'var(--accent)' : 'var(--text)',
                }}>{syncing === src.id ? 'Syncing...' : 'Sync'}</button>
              )}
              {canEdit && (
                <button onClick={() => deleteSource(src.id)} style={{
                  background: 'none', border: 'none', color: 'var(--red)', fontSize: 12,
                  cursor: 'pointer', opacity: 0.6, fontFamily: 'var(--font-sans)',
                }}>Delete</button>
              )}
            </div>
            {editingSource === src.id && (
              <div style={{ padding: '12px 16px', borderBottom: i < sources.length - 1 ? '1px solid var(--border)' : 'none', background: 'var(--surface-2)' }}>
                <textarea value={editContent} onChange={e => setEditContent(e.target.value)}
                  rows={10} style={{ width: '100%', padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font-mono)', resize: 'vertical', lineHeight: 1.5 }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--subtle)' }}>{editContent.split(/\s+/).length.toLocaleString()} words</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setEditingSource(null)} style={{
                      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6,
                      padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-sans)', color: 'var(--text)',
                    }}>Cancel</button>
                    <button onClick={saveEditSource} style={{
                      background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 6,
                      padding: '5px 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
                    }}>Save</button>
                  </div>
                </div>
              </div>
            )}
          </React.Fragment>
          ))}
        </div>
      )}

      {/* Wiki — two-panel file browser */}
      {wikiData && wikiData.articles.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <BookOpen size={14} style={{ color: 'var(--muted)' }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Wiki</span>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>
                {wikiData.articles.length} articles · {wikiData.totalWords.toLocaleString()} words
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {wikiData.lastBuilt && (
                <span style={{ fontSize: 11, color: 'var(--subtle)' }}>
                  Built {new Date(wikiData.lastBuilt).toLocaleDateString()} {new Date(wikiData.lastBuilt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              {canEdit && <button
                onClick={async () => {
                  setDownloading(true);
                  try {
                    const r = await fetch(`/api/agents/${agentId}/knowledge/download`);
                    if (!r.ok) { const d = await r.json(); setUploadError(d.error ?? 'Download failed'); return; }
                    const blob = await r.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `${agentSlug}-wiki.tar.gz`; a.click();
                    URL.revokeObjectURL(url);
                  } catch { setUploadError('Download failed — check your connection'); }
                  finally { setDownloading(false); }
                }}
                disabled={downloading}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7,
                  padding: '5px 12px', fontSize: 12, fontWeight: 500,
                  cursor: downloading ? 'wait' : 'pointer', fontFamily: 'var(--font-sans)',
                  color: downloading ? 'var(--muted)' : 'var(--text)',
                }}
              >
                {downloading ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Downloading...</> : <><Download size={13} /> Download</>}
              </button>}
              {canEdit && (
                <>
                  <button
                    onClick={() => wikiUploadRef.current?.click()}
                    disabled={uploading}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7,
                      padding: '5px 12px', fontSize: 12, fontWeight: 500,
                      cursor: uploading ? 'wait' : 'pointer', fontFamily: 'var(--font-sans)',
                      color: uploading ? 'var(--muted)' : 'var(--text)',
                    }}
                  >
                    {uploading ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Uploading...</> : <><Upload size={13} /> Restore</>}
                  </button>
                  <input
                    ref={wikiUploadRef}
                    type="file"
                    accept=".tar.gz,.tgz"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      e.target.value = '';
                      setUploadError('');
                      if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz')) {
                        setUploadError('File must be a .tar.gz archive');
                        return;
                      }
                      setUploading(true);
                      try {
                        const fd = new FormData();
                        fd.append('file', file);
                        const r = await fetch(`/api/agents/${agentId}/knowledge/upload`, { method: 'POST', body: fd });
                        if (r.ok) { loadWiki(); }
                        else { const d = await r.json(); setUploadError(d.error ?? 'Upload failed'); }
                      } catch { setUploadError('Upload failed — check your connection'); }
                      finally { setUploading(false); }
                    }}
                  />
                </>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 14, height: 480 }}>
            {/* Sidebar — file tree */}
            <div style={{
              width: 220, flexShrink: 0,
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 10, overflow: 'auto', display: 'flex', flexDirection: 'column',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', borderBottom: '1px solid var(--border)',
              }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Articles
                </span>
                <span style={{ fontSize: 10, color: 'var(--subtle)' }}>{wikiData.articles.length}</span>
              </div>
              <WikiTree articles={wikiData.articles} onSelect={viewArticle} selected={selectedArticle} />
            </div>

            {/* Main — article content */}
            <div style={{
              flex: 1, background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
              {selectedArticle ? (
                <>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                    borderBottom: '1px solid var(--border)', flexShrink: 0,
                  }}>
                    <FileText size={13} style={{ color: 'var(--muted)' }} />
                    <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>{selectedArticle}</span>
                  </div>
                  <div style={{ flex: 1, padding: '16px 18px', overflow: 'auto' }}>
                    {loadingArticle ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 12 }}>
                        <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Loading...
                      </div>
                    ) : (
                      <pre style={{
                        margin: 0, fontSize: 12.5, lineHeight: 1.7, color: 'var(--text)',
                        fontFamily: 'var(--font-sans)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>{articleContent}</pre>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
                  <BookOpen size={28} style={{ color: 'var(--border-2)' }} />
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Select an article to view</p>
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--subtle)' }}>Browse the folder tree on the left</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

type LogLevel = 'all' | 'debug' | 'info' | 'warn' | 'error';

interface ParsedLog {
  raw: string;
  level: LogLevel;
  time: string;
  message: string;
  fields: Record<string, string>;
}

function parseLine(raw: string): ParsedLog {
  const stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
  try {
    const obj = JSON.parse(stripped);
    const level: LogLevel =
      obj.level === 'error' || obj.level === 50 ? 'error' :
      obj.level === 'warn'  || obj.level === 40 ? 'warn'  :
      obj.level === 'debug' || obj.level === 20 ? 'debug' : 'info';
    const ts = obj.timestamp ? new Date(obj.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const rawMsg = obj.message ?? obj.msg ?? '';
    const msg = rawMsg.replace(/^(error|warn|info|debug|trace):\s*/i, '');
    const skip = new Set(['level', 'message', 'msg', 'timestamp', 'agent', 'service']);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!skip.has(k)) fields[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return { raw: stripped, level, time: ts, message: msg, fields };
  } catch {
    const lo = stripped.toLowerCase();
    const level: LogLevel =
      lo.includes('"level":"error"') || lo.includes('"level":50') || lo.includes('error:') ? 'error' :
      lo.includes('"level":"warn"')  || lo.includes('"level":40') || lo.includes('warn:')  ? 'warn'  :
      lo.includes('"level":"debug"') || lo.includes('"level":20') || lo.includes('debug:') ? 'debug' : 'info';
    const plainMsg = stripped.replace(/^(error|warn|info|debug|trace):\s*/i, '');
    const tsMatch = stripped.match(/"timestamp":"([^"]+)"/);
    const plainTime = tsMatch ? new Date(tsMatch[1]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    return { raw: stripped, level, time: plainTime, message: plainMsg, fields: {} };
  }
}

const LOG_META: Record<LogLevel, { label: string; color: string; bg: string; border: string; rowBg: string }> = {
  all:   { label: 'ALL',   color: 'var(--muted)',  bg: 'var(--surface-2)', border: 'var(--border)',             rowBg: 'transparent' },
  info:  { label: 'INFO',  color: 'var(--blue)',   bg: 'var(--surface-2)', border: 'var(--blue)',               rowBg: 'transparent' },
  debug: { label: 'DEBUG', color: 'var(--subtle)',  bg: 'var(--surface-2)', border: 'var(--border)',             rowBg: 'transparent' },
  warn:  { label: 'WARN',  color: 'var(--amber)',  bg: 'var(--amber-soft-bg)', border: 'var(--amber-soft-border)', rowBg: 'var(--amber-soft-bg)' },
  error: { label: 'ERR',   color: 'var(--red)',    bg: 'var(--red-soft-bg)',   border: 'var(--red-soft-border)',   rowBg: 'var(--red-soft-bg)' },
};

function CopyLogsBtn({ lines }: { lines: ParsedLog[] }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = lines.map(l => {
      const fields = Object.entries(l.fields).map(([k, v]) => `${k}=${v}`).join(' ');
      return `${l.time} [${l.level.toUpperCase()}] ${l.message}${fields ? ' ' + fields : ''}`;
    }).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button onClick={copy} disabled={lines.length === 0} style={{
      background: 'none', border: 'none', cursor: lines.length ? 'pointer' : 'default',
      fontSize: 11, color: copied ? '#16a34a' : 'var(--subtle)', fontFamily: 'var(--font-sans)',
      opacity: lines.length ? 1 : 0.4,
    }}>{copied ? 'Copied!' : 'Copy'}</button>
  );
}

function LogRow({ log }: { log: ParsedLog }) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered]   = useState(false);
  const m = LOG_META[log.level];
  const hasFields = Object.keys(log.fields).length > 0;
  const msgColor = log.level === 'error' ? 'var(--red)' : log.level === 'warn' ? 'var(--amber)' : log.level === 'debug' ? 'var(--subtle)' : 'var(--text)';

  return (
    <div
      onClick={() => setExpanded(e => !e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        cursor: 'pointer',
        background: hovered ? 'var(--surface-2)' : (expanded ? 'var(--surface-2)' : m.rowBg),
        borderLeft: `3px solid ${expanded ? m.border : 'transparent'}`,
        borderBottom: '1px solid var(--border)',
        transition: 'background 0.1s',
      }}
    >
      {/* Compact single row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 10px', minHeight: 28 }}>
        <span style={{ color: 'var(--subtle)', flexShrink: 0, fontSize: 10.5, fontVariantNumeric: 'tabular-nums', minWidth: 68 }}>
          {log.time}
        </span>
        <span style={{
          flexShrink: 0, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em',
          padding: '1px 6px', borderRadius: 3, border: `1px solid ${m.border}`,
          background: m.bg, color: m.color, minWidth: 34, textAlign: 'center',
        }}>{m.label}</span>
        <span style={{ flex: 1, color: msgColor, fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {log.message}
        </span>
        {!expanded && hasFields && (
          <span style={{ flexShrink: 0, display: 'flex', gap: 3 }}>
            {Object.keys(log.fields).slice(0, 3).map(k => (
              <span key={k} style={{ fontSize: 9.5, color: 'var(--muted)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px' }}>{k}</span>
            ))}
            {Object.keys(log.fields).length > 3 && <span style={{ fontSize: 9.5, color: 'var(--subtle)' }}>+{Object.keys(log.fields).length - 3}</span>}
          </span>
        )}
        <span style={{ flexShrink: 0, color: 'var(--subtle)', fontSize: 9, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '8px 14px 12px 92px', borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          {log.message.includes('\n') && (
            <pre style={{ margin: '0 0 10px', color: 'var(--text)', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{log.message}</pre>
          )}
          {hasFields && (
            <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', marginBottom: 8 }}>
              {Object.entries(log.fields).map(([k, v]) => (
                <>
                  <span key={`k-${k}`} style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 500 }}>{k}</span>
                  <span key={`v-${k}`} style={{ color: 'var(--muted)', fontSize: 11, wordBreak: 'break-all' }}>{v}</span>
                </>
              ))}
            </div>
          )}
          {log.raw && (
            <>
              <div style={{ fontSize: 10, color: 'var(--subtle)', marginTop: 8, marginBottom: 4 }}>Raw</div>
              <pre style={{
                margin: 0, padding: '8px 10px', background: 'var(--surface-2)',
                border: '1px solid var(--border)', borderRadius: 4,
                fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 180, overflow: 'auto',
              }}>{log.raw}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LogsTab({ agentId, slug }: { agentId: string; slug: string }) {
  const [lines, setLines]             = useState<ParsedLog[]>([]);
  const [connected, setConnected]     = useState(false);
  const [levelFilter, setLevelFilter] = useState<LogLevel>('all');
  const [search, setSearch]           = useState('');
  const [autoScroll, setAutoScroll]   = useState(true);
  const bottomRef    = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/agents/${agentId}/logs`);
    setConnected(true);
    es.onmessage = e => {
      const raw = JSON.parse(e.data) as string;
      setLines(prev => [...prev.slice(-1000), parseLine(raw)]);
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [agentId]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, autoScroll]);

  const LEVEL_ORDER: LogLevel[] = ['error', 'warn', 'info', 'debug'];

  const counts = lines.reduce<Record<LogLevel, number>>((acc, l) => {
    acc[l.level] = (acc[l.level] ?? 0) + 1; return acc;
  }, { all: lines.length, error: 0, warn: 0, info: 0, debug: 0 });

  const visibleLines = lines.filter(l => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return l.message.toLowerCase().includes(q) ||
        Object.values(l.fields).some(v => v.toLowerCase().includes(q));
    }
    return true;
  });

  return (
    <div className="fade-up">
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div className={connected ? 'status-running' : ''}
            style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? '#16a34a' : 'var(--border-2)' }} />
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{connected ? 'Live' : 'Disconnected'}</span>
        </div>
        <div style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 2px' }} />
        {/* Level filters with counts */}
        {(['all', ...LEVEL_ORDER] as LogLevel[]).map(lvl => {
          const m = LOG_META[lvl];
          const active = levelFilter === lvl;
          return (
            <button key={lvl} onClick={() => setLevelFilter(lvl)} style={{
              padding: '2px 8px', borderRadius: 4,
              border: `1px solid ${active ? m.border : 'var(--border)'}`,
              fontSize: 10.5, fontFamily: 'var(--font-sans)', cursor: 'pointer',
              background: active ? m.bg : 'transparent',
              color: active ? m.color : 'var(--muted)',
              fontWeight: active ? 700 : 400,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              {m.label}
              {counts[lvl] > 0 && <span style={{ fontSize: 9.5, opacity: 0.75 }}>{counts[lvl]}</span>}
            </button>
          );
        })}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter logs…"
          style={{
            padding: '3px 10px', borderRadius: 4, border: '1px solid var(--border)',
            fontSize: 11, fontFamily: 'var(--font-mono)', background: 'transparent',
            color: 'var(--text)', outline: 'none', width: 180,
          }} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <CopyLogsBtn lines={visibleLines} />
          <button onClick={() => setLines([])} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 11, color: 'var(--subtle)', fontFamily: 'var(--font-sans)',
          }}>Clear</button>
        </div>
      </div>

      {/* Log pane */}
      <div ref={containerRef} onScroll={e => {
        const el = e.currentTarget;
        setAutoScroll(el.scrollTop + el.clientHeight >= el.scrollHeight - 40);
      }} style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
        height: 520, overflow: 'auto', fontFamily: 'var(--font-mono)',
      }}>
        {visibleLines.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--subtle)', fontSize: 12 }}>
            {lines.length === 0 ? 'Waiting for log lines…' : 'No matching lines.'}
          </div>
        ) : (
          visibleLines.map((log, i) => <LogRow key={i} log={log} />)
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, padding: '0 2px' }}>
        <span style={{ fontSize: 10.5, color: 'var(--subtle)' }}>
          {visibleLines.length}{visibleLines.length !== lines.length ? ` / ${lines.length}` : ''} line{visibleLines.length !== 1 ? 's' : ''}
        </span>
        {!autoScroll && (
          <button onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
            style={{ fontSize: 10.5, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
            ↓ Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 32, paddingBottom: 28,
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em',
        textTransform: 'uppercase', marginBottom: 16 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    </div>
  );
}

function Grid2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{children}</div>;
}

function Field({ label, value, onChange, hint, type = 'text', readOnly }: {
  label: string; value: string; onChange: (v: string) => void;
  hint?: React.ReactNode; type?: string; readOnly?: boolean;
}) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>
        {label}
      </label>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)} readOnly={readOnly}
        style={{
          width: '100%', background: 'var(--surface)', border: '1.5px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '10px 14px', color: 'var(--text)',
          fontSize: 14, fontFamily: 'var(--font-sans)', outline: 'none',
          transition: 'border-color 0.15s',
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
      />
      {hint && <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--subtle)' }}>{hint}</p>}
    </div>
  );
}

function TextArea({ label, value, onChange, hint, rows = 3, readOnly }: {
  label: string; value: string; onChange: (v: string) => void;
  hint?: string; rows?: number; readOnly?: boolean;
}) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>
        {label}
      </label>
      <textarea
        value={value} onChange={e => onChange(e.target.value)} rows={rows} readOnly={readOnly}
        style={{
          width: '100%', background: 'var(--surface)', border: '1.5px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '10px 14px', color: 'var(--text)',
          fontSize: 14, fontFamily: 'var(--font-sans)', outline: 'none', resize: 'vertical',
          transition: 'border-color 0.15s',
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
      />
      {hint && <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--subtle)' }}>{hint}</p>}
    </div>
  );
}

function PrimaryBtn({ children, onClick, loading }: {
  children: React.ReactNode; onClick?: () => void; loading?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      background: loading ? 'var(--border)' : 'var(--accent)',
      color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--radius)',
      padding: '10px 22px', fontSize: 14, fontWeight: 600,
      letterSpacing: '-0.01em',
      cursor: loading ? 'not-allowed' : 'pointer',
      fontFamily: 'var(--font-sans)',
      boxShadow: loading ? 'none' : 'var(--shadow-sm)',
      transition: 'opacity 0.15s, transform 0.15s, box-shadow 0.15s',
    }}
      onMouseEnter={e => { if (!loading) { (e.currentTarget as HTMLElement).style.opacity = '0.88'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-hover)'; }}}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'; }}
    >{loading ? 'Saving…' : children}</button>
  );
}

function GhostBtn({ children, onClick, loading }: { children: React.ReactNode; onClick?: () => void; loading?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      background: 'transparent', color: 'var(--muted)',
      border: '1.5px solid var(--border-2)', borderRadius: 'var(--radius)',
      padding: '10px 20px', fontSize: 14, fontWeight: 500, fontFamily: 'var(--font-sans)',
      cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
      transition: 'border-color 0.15s, color 0.15s',
    }}
      onMouseEnter={e => { if (!loading) { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; }}
    >{loading ? '…' : children}</button>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ color: 'var(--text)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function IconBtn({ children, onClick, title, loading }: { children: React.ReactNode; onClick?: () => void; title?: string; loading?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={loading}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)',
        background: 'var(--surface)', color: 'var(--muted)',
        cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1,
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => { if (!loading) { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--border-2)'; el.style.color = 'var(--text)'; el.style.background = 'var(--surface-2)'; }}}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--border)'; el.style.color = 'var(--muted)'; el.style.background = 'var(--surface)'; }}
    >
      {loading ? <span style={{ fontSize: 11 }}>…</span> : children}
    </button>
  );
}

function Btn({ children, onClick, color, textColor }: {
  children: React.ReactNode; onClick?: () => void;
  color?: string; textColor?: string;
}) {
  return (
    <button onClick={onClick} style={{
      background: color ?? 'var(--border)', color: textColor ?? '#fff',
      border: 'none', borderRadius: 'var(--radius)', padding: '8px 18px',
      fontSize: 13, fontWeight: 600, cursor: 'pointer',
      fontFamily: 'var(--font-sans)', transition: 'opacity 0.15s, transform 0.15s',
    }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.85'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
    >{children}</button>
  );
}

function Modal({ title, children, onClose }: {
  title: string; children: React.ReactNode; onClose: () => void;
}) {
  return (
    <Portal>
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', padding: '28px', width: 440,
        boxShadow: 'var(--shadow-modal)',
        display: 'flex', flexDirection: 'column', gap: 16,
        maxHeight: '90vh', overflow: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{title}</h3>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--muted)', fontSize: 18, lineHeight: 1, fontFamily: 'var(--font-sans)',
          }}>×</button>
        </div>
        {children}
      </div>
    </div>
    </Portal>
  );
}

function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--muted)', fontSize: 13 }}>
      Loading…
    </div>
  );
}

function NotFound({ slug }: { slug: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 12 }}>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>Agent not found: <code style={{ fontFamily: 'var(--font-mono)' }}>{slug}</code></p>
      <Link href="/" style={{ color: 'var(--accent)', fontSize: 13, textDecoration: 'none' }}>← Back to dashboard</Link>
    </div>
  );
}

// ─── Persona Library Modal ────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  engineering: 'var(--accent)',
  data: '#9333ea',
  product: '#16a34a',
  business: '#d97706',
  generic: 'var(--muted)',
};

const CATEGORY_LABELS: Record<string, string> = {
  all: 'All',
  engineering: 'Engineering',
  data: 'Data',
  product: 'Product',
  business: 'Business',
  generic: 'Generic',
};

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  all: <Library size={14} />,
  engineering: <Code2 size={14} />,
  data: <Database size={14} />,
  product: <Layers size={14} />,
  business: <Briefcase size={14} />,
  generic: <Sparkles size={14} />,
};

function PersonaLibraryModal({
  agentId,
  fileInputRef,
  applying,
  search,
  onSearchChange,
  category,
  onCategoryChange,
  selected,
  onSelectPersona,
  onBack,
  skillSel,
  onToggleSkill,
  onImportFull,
  onImportSkills,
  onClose,
}: {
  agentId: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  applying: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  category: PersonaCategory | 'all';
  onCategoryChange: (v: PersonaCategory | 'all') => void;
  selected: PersonaTemplate | null;
  onSelectPersona: (p: PersonaTemplate) => void;
  onBack: () => void;
  skillSel: Set<string>;
  onToggleSkill: (filename: string) => void;
  onImportFull: (t: PersonaTemplate) => Promise<void>;
  onImportSkills: (t: PersonaTemplate, sel: Set<string>) => Promise<void>;
  onClose: () => void;
}) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const filteredPersonas = useMemo(() => {
    let list = search.trim() ? searchPersonas(search) : PERSONA_CATALOG;
    if (category !== 'all') list = list.filter(p => p.category === category);
    return list;
  }, [search, category]);

  return (
    <Portal>
      <div style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)' }}
          onClick={onClose} />
        <div style={{
          position: 'relative', background: 'var(--bg)', borderRadius: 12,
          width: '100%', maxWidth: 800, maxHeight: 560,
          display: 'flex', flexDirection: 'column',
          border: '1px solid var(--border)',
          boxShadow: 'rgba(50,50,93,0.25) 0px 30px 60px -12px, rgba(0,0,0,0.3) 0px 18px 36px -18px',
        }}>

          {/* ── Header ───────────────────────────────────────────────────── */}
          <div style={{
            padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.3px' }}>
                Persona Library
              </h2>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                {PERSONA_CATALOG.length} pre-built personas — click to preview and import
              </p>
            </div>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', padding: 4, marginTop: -2,
            }}><X size={18} /></button>
          </div>

          {/* ── Search bar ───────────────────────────────────────────────── */}
          <div style={{
            padding: '12px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0,
            display: 'flex', gap: 8, alignItems: 'center',
          }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={14} style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--muted)', pointerEvents: 'none',
              }} />
              <input
                type="text"
                placeholder="Search personas..."
                value={search}
                onChange={e => onSearchChange(e.target.value)}
                autoFocus={!selected}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '7px 10px 7px 32px', fontSize: 13,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--text)', fontFamily: 'var(--font-sans)',
                  outline: 'none',
                }}
              />
            </div>
            <button onClick={() => { onClose(); fileInputRef.current?.click(); }} style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 6,
              cursor: 'pointer', color: 'var(--muted)', fontSize: 12,
              padding: '6px 12px', fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; }}
            >Import JSON</button>
          </div>

          {/* ── Body: sidebar + main ─────────────────────────────────────── */}
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

            {/* Left sidebar */}
            <div style={{
              width: 160, borderRight: '1px solid var(--border)', flexShrink: 0,
              padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 2,
              overflowY: 'auto',
            }}>
              <span style={{
                fontSize: 10, fontWeight: 700, color: 'var(--subtle)', letterSpacing: '0.08em',
                textTransform: 'uppercase', padding: '0 10px', marginBottom: 4,
              }}>Browse</span>
              {Object.entries(CATEGORY_LABELS).map(([val, label]) => {
                const isActive = category === val;
                const count = val === 'all'
                  ? PERSONA_CATALOG.length
                  : PERSONA_CATALOG.filter(p => p.category === val).length;
                const iconColor = isActive
                  ? (CATEGORY_COLORS[val] ?? 'var(--accent)')
                  : 'var(--subtle)';
                return (
                  <button key={val}
                    onClick={() => { onCategoryChange(val as PersonaCategory | 'all'); if (selected) onBack(); }}
                    style={{
                      position: 'relative',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '7px 10px', borderRadius: 6, border: 'none',
                      background: isActive ? 'var(--surface-2)' : 'transparent',
                      color: isActive ? 'var(--text)' : 'var(--muted)',
                      fontFamily: 'var(--font-sans)', fontSize: 13,
                      fontWeight: isActive ? 600 : 400,
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'background 0.12s, color 0.12s',
                    }}
                    onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
                    onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    {isActive && (
                      <span style={{
                        position: 'absolute', left: 0, top: '20%', bottom: '20%',
                        width: 3, borderRadius: 2,
                        background: CATEGORY_COLORS[val] ?? 'var(--accent)',
                      }} />
                    )}
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: iconColor }}>
                      {CATEGORY_ICONS[val]}
                      <span style={{ color: isActive ? 'var(--text)' : 'var(--muted)' }}>{label}</span>
                    </span>
                    <span style={{
                      fontSize: 11, fontWeight: 500,
                      color: isActive ? 'var(--accent)' : 'var(--subtle)',
                    }}>{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Right: card grid or detail */}
            {selected ? (
              // ── Detail view ───────────────────────────────────────────────
              <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                <div style={{
                  padding: '12px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <button onClick={onBack} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--muted)', display: 'flex', alignItems: 'center',
                    gap: 5, fontSize: 13, padding: 0, fontFamily: 'var(--font-sans)',
                  }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--muted)')}
                  >
                    <ArrowLeft size={14} /> Back
                  </button>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {selected.skills.length > 0 && (
                      <button
                        disabled={applying || skillSel.size === 0}
                        onClick={() => onImportSkills(selected, skillSel)}
                        style={{
                          background: 'transparent', color: 'var(--text)',
                          border: '1px solid var(--border-2)', borderRadius: 6,
                          padding: '7px 14px', fontSize: 13, fontWeight: 500,
                          cursor: (applying || skillSel.size === 0) ? 'not-allowed' : 'pointer',
                          fontFamily: 'var(--font-sans)',
                          opacity: (applying || skillSel.size === 0) ? 0.4 : 1,
                        }}
                        onMouseEnter={e => { if (!applying && skillSel.size > 0) (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; }}
                      >
                        Add {skillSel.size} skill{skillSel.size !== 1 ? 's' : ''}
                      </button>
                    )}
                    <button
                      disabled={applying}
                      onClick={() => onImportFull(selected)}
                      style={{
                        background: 'var(--accent)', color: 'var(--accent-fg)',
                        border: 'none', borderRadius: 6, padding: '7px 16px',
                        fontSize: 13, fontWeight: 600,
                        cursor: applying ? 'not-allowed' : 'pointer',
                        fontFamily: 'var(--font-sans)', opacity: applying ? 0.7 : 1,
                        transition: 'opacity 0.15s',
                      }}
                      onMouseEnter={e => { if (!applying) (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                    >
                      {applying ? 'Importing…' : 'Import persona'}
                    </button>
                  </div>
                </div>

                <div style={{ padding: '16px 20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
                      {selected.name}
                    </h3>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
                      {selected.cardDescription}
                    </p>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                      textTransform: 'uppercase', padding: '2px 7px', borderRadius: 4,
                      background: `${CATEGORY_COLORS[selected.category]}1a`,
                      color: CATEGORY_COLORS[selected.category] ?? 'var(--muted)',
                    }}>{selected.category}</span>
                    {selected.tags.map(tag => (
                      <span key={tag} style={{
                        fontSize: 11, padding: '2px 7px', borderRadius: 4,
                        background: 'var(--surface-2)', color: 'var(--muted)',
                        border: '1px solid var(--border)',
                      }}>{tag}</span>
                    ))}
                  </div>
                  {/* System prompt preview */}
                  {selected.claudeMd && (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
                      <button onClick={() => setPromptExpanded(v => !v)} style={{
                        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '8px 12px', background: 'var(--surface-2)', border: 'none',
                        cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      }}>
                        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
                          System Prompt
                        </span>
                        <ChevronDown size={13} style={{
                          color: 'var(--muted)',
                          transform: promptExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                          transition: 'transform 0.15s',
                        }} />
                      </button>
                      {promptExpanded && (
                        <pre style={{
                          margin: 0, padding: '10px 12px', fontSize: 11.5,
                          fontFamily: 'var(--font-mono)', color: 'var(--muted)',
                          whiteSpace: 'pre-wrap', lineHeight: 1.5, maxHeight: 200,
                          overflow: 'auto', background: 'var(--bg)',
                        }}>
                          {selected.claudeMd.trim()}
                        </pre>
                      )}
                    </div>
                  )}

                  {selected.skills.length > 0 && (
                    <div>
                      <p style={{
                        margin: '0 0 8px', fontSize: 11, fontWeight: 600,
                        textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)',
                      }}>Skills · select to cherry-pick</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {selected.skills.map(skill => {
                          const isExpanded = expandedSkill === skill.filename;
                          return (
                            <div key={skill.filename} style={{
                              borderRadius: 6, border: '1px solid',
                              borderColor: skillSel.has(skill.filename) ? 'var(--border-2)' : 'var(--border)',
                              background: skillSel.has(skill.filename) ? 'var(--surface-2)' : 'transparent',
                              overflow: 'hidden', transition: 'all 0.1s',
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
                                <input type="checkbox"
                                  checked={skillSel.has(skill.filename)}
                                  onChange={() => onToggleSkill(skill.filename)}
                                  style={{ accentColor: 'var(--accent)', width: 13, height: 13, cursor: 'pointer', flexShrink: 0 }}
                                />
                                <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{skill.category}/</span>
                                <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font-mono)', flex: 1 }}>{skill.filename}</span>
                                <button
                                  onClick={() => setExpandedSkill(isExpanded ? null : skill.filename)}
                                  style={{
                                    background: 'none', border: 'none', cursor: 'pointer',
                                    color: isExpanded ? 'var(--text)' : 'var(--muted)',
                                    display: 'flex', alignItems: 'center', padding: '2px 4px',
                                    flexShrink: 0,
                                  }}
                                  title={isExpanded ? 'Hide content' : 'Preview content'}
                                >
                                  <ChevronDown size={12} style={{
                                    transform: isExpanded ? 'rotate(180deg)' : 'none',
                                    transition: 'transform 0.15s',
                                  }} />
                                </button>
                              </div>
                              {isExpanded && (
                                <pre style={{
                                  margin: 0, padding: '8px 12px 10px',
                                  fontSize: 11, fontFamily: 'var(--font-mono)',
                                  color: 'var(--muted)', whiteSpace: 'pre-wrap',
                                  lineHeight: 1.5, maxHeight: 200, overflow: 'auto',
                                  borderTop: '1px solid var(--border)',
                                  background: 'var(--bg)',
                                }}>
                                  {skill.content}
                                </pre>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--subtle)' }}>
                    "Import persona" replaces your current system prompt, description, and all existing skills.
                  </p>
                  <button onClick={() => { onClose(); fileInputRef.current?.click(); }} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--muted)', fontSize: 12, padding: 0, alignSelf: 'flex-start',
                    fontFamily: 'var(--font-sans)', textDecoration: 'underline', textUnderlineOffset: 3,
                  }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--muted)')}
                  >Import from JSON file instead</button>
                </div>
              </div>
            ) : (
              // ── Card grid ─────────────────────────────────────────────────
              <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px 20px' }}>
                {filteredPersonas.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--muted)', fontSize: 13 }}>
                    No personas match your search.
                  </div>
                ) : (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                    gap: 10,
                  }}>
                    {filteredPersonas.map(p => (
                      <button key={p.id} onClick={() => onSelectPersona(p)}
                        style={{
                          display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                          gap: 7, padding: '12px 12px',
                          background: 'var(--surface)', border: '1px solid var(--border)',
                          borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                          fontFamily: 'var(--font-sans)', minWidth: 0,
                          boxShadow: 'rgba(50,50,93,0.06) 0px 2px 5px -1px, rgba(0,0,0,0.04) 0px 1px 3px -1px',
                          transition: 'border-color 0.15s, box-shadow 0.15s',
                        }}
                        onMouseEnter={e => {
                          const el = e.currentTarget as HTMLElement;
                          el.style.borderColor = 'var(--accent)';
                          el.style.boxShadow = 'rgba(50,50,93,0.2) 0px 6px 12px -2px, rgba(0,0,0,0.08) 0px 3px 7px -3px';
                        }}
                        onMouseLeave={e => {
                          const el = e.currentTarget as HTMLElement;
                          el.style.borderColor = 'var(--border)';
                          el.style.boxShadow = 'rgba(50,50,93,0.06) 0px 2px 5px -1px, rgba(0,0,0,0.04) 0px 1px 3px -1px';
                        }}
                      >
                        <span style={{
                          fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
                          textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4,
                          background: `${CATEGORY_COLORS[p.category]}1a`,
                          color: CATEGORY_COLORS[p.category] ?? 'var(--muted)',
                          flexShrink: 0,
                        }}>{p.category}</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.2 }}>
                          {p.name}
                        </span>
                        <p style={{
                          margin: 0, fontSize: 11, color: 'var(--muted)', lineHeight: 1.4,
                          display: '-webkit-box', WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical' as const, overflow: 'hidden',
                        }}>{p.cardDescription}</p>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 4, minWidth: 0 }}>
                          <span style={{
                            fontSize: 10, padding: '1px 6px', borderRadius: 4,
                            background: 'var(--surface-2)', color: 'var(--muted)',
                            border: '1px solid var(--border)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            minWidth: 0, flexShrink: 1,
                          }}>{p.tags[0]}</span>
                          {p.skills.length > 0 && (
                            <span style={{ fontSize: 10, color: 'var(--subtle)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                              {p.skills.length} skills
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

// ─── History ──────────────────────────────────────────────────────────────────

// ── Diff panel ───────────────────────────────────────────────────────────────

/**
 * Build the file-diff entries for a **restore preview**: "if I restore this
 * snapshot on top of the current state, what will change?"
 *
 * That means current is the OLD side (what you have now) and the snapshot is
 * the NEW side (what you'd get). So:
 *   - present in snapshot, missing in current → `added` (will be added by restore)
 *   - present in current, missing in snapshot → `removed` (will be removed by restore)
 *   - different                               → `modified` (will change)
 *
 * CLAUDE.md comes first, then every differing skill alphabetically.
 */
function buildDiffFiles(snapshot: AgentSnapshot, current: AgentSnapshot): FileChange[] {
  const files: FileChange[] = [];

  // CLAUDE.md. Skip unless both sides captured content — old snapshots
  // without `compiledMd` would otherwise render as a misleading all-green
  // "will be removed" diff.
  const currMd = current.compiledMd?.trim() ?? '';
  const snapMd = snapshot.compiledMd?.trim() ?? '';
  if (currMd && snapMd && currMd !== snapMd) {
    files.push({ path: 'CLAUDE.md', status: 'modified', oldText: currMd, newText: snapMd });
  }

  const snapMap = new Map(snapshot.skillsJson.map(s => [`${s.category}/${s.filename}`, s.content]));
  const currMap = new Map(current.skillsJson.map(s => [`${s.category}/${s.filename}`, s.content]));
  const keys = new Set([...snapMap.keys(), ...currMap.keys()]);
  for (const key of Array.from(keys).sort()) {
    const inSnap = snapMap.get(key);
    const inCurr = currMap.get(key);
    if (inCurr === undefined && inSnap !== undefined) {
      // Restore would add this file back.
      files.push({ path: key, status: 'added', oldText: '', newText: inSnap });
    } else if (inSnap === undefined && inCurr !== undefined) {
      // Restore would delete this file from current.
      files.push({ path: key, status: 'removed', oldText: inCurr, newText: '' });
    } else if (inSnap !== inCurr && inSnap !== undefined && inCurr !== undefined) {
      files.push({ path: key, status: 'modified', oldText: inCurr, newText: inSnap });
    }
  }

  return files;
}

// Each of these diffs is framed as **restore preview**:
//   will-add  = in snapshot, not in current  (restore grants / reconnects / re-restricts to)
//   will-drop = in current, not in snapshot  (restore revokes / disconnects / un-restricts)

function PermsDiff({ snapshot, current }: { snapshot: AgentSnapshot; current: AgentSnapshot | null }) {
  const currAllowed = new Set(current ? current.allowedTools : []);
  const currDenied  = new Set(current ? current.deniedTools  : []);
  const snapAllowed = new Set(snapshot.allowedTools);
  const snapDenied  = new Set(snapshot.deniedTools);

  const willAddAllowed  = [...snapAllowed].filter(t => !currAllowed.has(t));
  const willDropAllowed = [...currAllowed].filter(t => !snapAllowed.has(t));
  const willAddDenied   = [...snapDenied].filter(t => !currDenied.has(t));
  const willDropDenied  = [...currDenied].filter(t => !snapDenied.has(t));

  if (!willAddAllowed.length && !willDropAllowed.length && !willAddDenied.length && !willDropDenied.length) {
    return <p style={{ fontSize: 13, color: 'var(--subtle)', margin: 0 }}>No permission changes.</p>;
  }
  const row = (label: string, items: string[], color: string) => items.length > 0 && (
    <div key={label}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map(t => (
          <span key={t} style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', padding: '2px 8px', borderRadius: 4, background: `${color}22`, color }}>{t}</span>
        ))}
      </div>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {row('Tools that will be allowed',      willAddAllowed,  'var(--green)')}
      {row('Tools that will no longer be allowed', willDropAllowed, 'var(--red)')}
      {row('Tools that will be denied',       willAddDenied,   'var(--red)')}
      {row('Tools that will no longer be denied',  willDropDenied,  'var(--green)')}
    </div>
  );
}

function McpsDiff({ snapshot, current, allMcps }: { snapshot: AgentSnapshot; current: AgentSnapshot | null; allMcps: McpServer[] }) {
  const nameFor = (id: string) => allMcps.find(m => m.id === id)?.name ?? id;
  const currIds = new Set(current ? current.mcpIds : []);
  const snapIds = new Set(snapshot.mcpIds);
  const willConnect    = [...snapIds].filter(id => !currIds.has(id));
  const willDisconnect = [...currIds].filter(id => !snapIds.has(id));
  if (!willConnect.length && !willDisconnect.length) return <p style={{ fontSize: 13, color: 'var(--subtle)', margin: 0 }}>No MCP changes.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {willConnect.length > 0 && <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--green)', marginBottom: 4 }}>Will be connected</div>
        {willConnect.map(id => <div key={id} style={{ fontSize: 12.5, color: 'var(--green)' }}>+ {nameFor(id)}</div>)}
      </div>}
      {willDisconnect.length > 0 && <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--red)', marginBottom: 4 }}>Will be disconnected</div>
        {willDisconnect.map(id => <div key={id} style={{ fontSize: 12.5, color: 'var(--red)' }}>− {nameFor(id)}</div>)}
      </div>}
    </div>
  );
}

function ChannelsDiff({ snapshot, current }: { snapshot: AgentSnapshot; current: AgentSnapshot | null }) {
  const currChannels = new Set(current?.allowedChannels ?? []);
  const snapChannels = new Set(snapshot.allowedChannels ?? []);
  const willAdd  = [...snapChannels].filter(ch => !currChannels.has(ch));
  const willDrop = [...currChannels].filter(ch => !snapChannels.has(ch));
  if (!willAdd.length && !willDrop.length) return <p style={{ fontSize: 13, color: 'var(--subtle)', margin: 0 }}>No channel restriction changes.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {willAdd.length > 0 && <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--green)', marginBottom: 4 }}>Channels that will be restored</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {willAdd.map(ch => (
            <span key={ch} style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', padding: '2px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.12)', color: 'var(--green)' }}>{ch}</span>
          ))}
        </div>
      </div>}
      {willDrop.length > 0 && <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--red)', marginBottom: 4 }}>Channels that will be dropped</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {willDrop.map(ch => (
            <span key={ch} style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', padding: '2px 8px', borderRadius: 4, background: 'var(--red-soft-bg)', color: 'var(--red)' }}>{ch}</span>
          ))}
        </div>
      </div>}
    </div>
  );
}

// ── Trigger badge ─────────────────────────────────────────────────────────────

const TRIGGER_COLORS: Record<string, { bg: string; color: string }> = {
  skills:      { bg: 'rgba(59,130,246,0.12)',  color: '#3b82f6' },
  permissions: { bg: 'rgba(234,179,8,0.12)',   color: '#ca8a04' },
  mcps:        { bg: 'rgba(168,85,247,0.12)',  color: '#a855f7' },
  'claude-md': { bg: 'rgba(236,72,153,0.12)',  color: '#ec4899' },
  manual:      { bg: 'rgba(22,163,74,0.12)',   color: '#16a34a' },
};

function TriggerBadge({ trigger }: { trigger: string }) {
  const c = TRIGGER_COLORS[trigger] ?? { bg: 'var(--surface-2)', color: 'var(--muted)' };
  const label: Record<string, string> = {
    skills: 'Skills', permissions: 'Capabilities', mcps: 'Connected Apps',
    'claude-md': 'System Prompt', manual: 'Manual', restrictions: 'Channels',
  };
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
      background: c.bg, color: c.color, letterSpacing: '0.03em',
    }}>{label[trigger] ?? trigger}</span>
  );
}

// ── Main HistoryTab component ─────────────────────────────────────────────────

function HistoryTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [snapshots, setSnapshots] = useState<AgentSnapshot[]>([]);
  const [loading, setLoading]     = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fullSnapshot, setFullSnapshot] = useState<AgentSnapshot | null>(null);
  // Live current state — the restore-preview target. Always the compare side.
  const [liveSnapshot, setLiveSnapshot] = useState<AgentSnapshot | null>(null);
  const [allMcps, setAllMcps]     = useState<McpServer[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [msg, setMsg]             = useState('');

  // Load snapshot list + MCP catalog (fast path — no live state on mount)
  useEffect(() => {
    Promise.all([
      fetch(`/api/agents/${agentId}/snapshots`).then(r => r.json()),
      fetch('/api/mcps').then(r => r.json()),
    ]).then(([snaps, mcps]) => {
      setSnapshots(Array.isArray(snaps) ? snaps : []);
      setAllMcps(mcps);
      setLoading(false);
    });
  }, [agentId]);

  // Lazy-load live state once — it's the fixed compare target for every snapshot.
  useEffect(() => {
    if (liveSnapshot) return;
    Promise.all([
      fetch(`/api/agents/${agentId}/skills`).then(r => r.json()),
      fetch(`/api/agents/${agentId}/permissions`).then(r => r.json()),
      fetch(`/api/agents/${agentId}/mcps`).then(r => r.json()),
      fetch(`/api/agents/${agentId}/claude-md`).then(r => r.text()),
    ]).then(([skills, perms, agentMcps, claudeMd]) => {
      setLiveSnapshot({
        id: '__current__',
        agentId,
        trigger: 'manual',
        createdBy: 'current',
        skillsJson: skills.map((s: Skill) => ({
          category: s.category,
          filename: s.filename,
          content: s.content,
          sort_order: s.sortOrder,
        })),
        allowedTools: perms?.allowedTools ?? [],
        deniedTools:  perms?.deniedTools  ?? [],
        mcpIds: (agentMcps as McpServer[]).map(m => m.id),
        compiledMd: claudeMd ?? '',
        allowedChannels: [],
        createdAt: new Date(),
      });
    });
  }, [agentId, liveSnapshot]);

  // Load full snapshot when selected
  useEffect(() => {
    if (!selectedId) { setFullSnapshot(null); return; }
    setFullSnapshot(null);
    setLoadingDetail(true);
    fetch(`/api/agents/${agentId}/snapshots/${selectedId}`)
      .then(r => r.json())
      .then(snap => { setFullSnapshot(snap); setLoadingDetail(false); })
      .catch(() => setLoadingDetail(false));
  }, [agentId, selectedId]);

  const handleCreateManual = async () => {
    const label = window.prompt('Snapshot label (optional):') ?? '';
    const r = await fetch(`/api/agents/${agentId}/snapshots`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label || null }),
    });
    if (r.ok) {
      const snap = await r.json();
      setSnapshots(prev => [snap, ...prev]);
      setMsg('Snapshot created.');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this snapshot?')) return;
    await fetch(`/api/agents/${agentId}/snapshots/${id}`, { method: 'DELETE' });
    setSnapshots(prev => prev.filter(s => s.id !== id));
    if (selectedId === id) { setSelectedId(null); setFullSnapshot(null); }
    setMsg('Snapshot deleted.');
  };

  const handleRestore = async (snap: AgentSnapshot) => {
    if (!window.confirm(`Restore to snapshot from ${new Date(snap.createdAt).toLocaleString()}?\n\nThis will replace current skills, permissions, and MCPs.`)) return;
    setRestoring(true);
    const r = await fetch(`/api/agents/${agentId}/snapshots/${snap.id}/restore`, { method: 'POST' });
    setRestoring(false);
    if (r.ok) {
      setMsg('Restored. Agent is reloading.');
    } else {
      const err = await r.json();
      setMsg(`Restore failed: ${err.error}`);
    }
  };

  const fmt = (d: Date | string) => {
    const dt = new Date(d);
    return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  // Compare target is always live current state — restore preview is current-only.
  const currentAsSnapshot: AgentSnapshot | null = liveSnapshot;

  if (loading) return (
    <div style={{ display: 'flex', gap: 20, minHeight: 500 }}>
      <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ width: 70, height: 13, borderRadius: 5, background: 'var(--surface-2)' }} />
          <div style={{ width: 110, height: 30, borderRadius: 8, background: 'var(--surface-2)' }} />
        </div>
        {[1, 2, 3, 4].map(i => (
          <div key={i} style={{
            background: 'var(--surface)', borderRadius: 'var(--radius)', padding: '14px 16px',
            boxShadow: 'var(--shadow-card)', opacity: 1 - (i - 1) * 0.2,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ width: 70, height: 18, borderRadius: 6, background: 'var(--surface-2)' }} />
              <div style={{ width: 50, height: 11, borderRadius: 4, background: 'var(--surface-2)' }} />
            </div>
            <div style={{ width: '55%', height: 11, borderRadius: 4, background: 'var(--surface-2)' }} />
          </div>
        ))}
      </div>
      <div style={{ flex: 1, background: 'var(--surface)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-card)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--subtle)' }}>Loading history…</div>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', gap: 20, minHeight: 500, alignItems: 'flex-start' }}>

      {/* ── Left: snapshot list ────────────────────────────────────────────── */}
      <div style={{ width: 280, flexShrink: 0 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
            color: 'var(--subtle)', textTransform: 'uppercase',
          }}>
            {snapshots.length} snapshot{snapshots.length !== 1 ? 's' : ''}
          </span>
          {canEdit && (
            <button onClick={handleCreateManual} style={{
              background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
              borderRadius: 'var(--radius-sm)', padding: '7px 13px',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'var(--font-sans)', letterSpacing: '-0.01em',
              boxShadow: 'var(--shadow-sm)', transition: 'opacity 0.15s',
            }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >+ Snapshot</button>
          )}
        </div>

        {msg && (
          <div style={{
            fontSize: 12, color: '#16a34a', background: '#f0fdf4',
            border: '1px solid #bbf7d0', borderRadius: 8,
            padding: '8px 12px', marginBottom: 10,
          }}>{msg}</div>
        )}

        {snapshots.length === 0 ? (
          <div style={{
            background: 'var(--surface)', borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-card)', padding: '28px 20px',
            textAlign: 'center',
          }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}><Camera size={22} style={{ color: 'var(--border-2)' }} /></div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>No snapshots yet</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
              Snapshots are saved automatically when you change skills, MCPs, or permissions.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {snapshots.map(snap => {
              const isSelected = snap.id === selectedId;
              return (
                <div
                  key={snap.id}
                  onClick={() => { setSelectedId(isSelected ? null : snap.id); }}
                  style={{
                    background: 'var(--surface)',
                    borderRadius: 'var(--radius)',
                    boxShadow: isSelected ? '0 0 0 2px var(--accent), var(--shadow-card)' : 'var(--shadow-card)',
                    padding: '13px 15px', cursor: 'pointer',
                    transition: 'box-shadow 0.15s',
                  }}
                  onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-hover)'; }}
                  onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-card)'; }}
                >
                  {/* Top row: badge + author */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                    <TriggerBadge trigger={snap.trigger} />
                    <span style={{ fontSize: 11, color: 'var(--subtle)', fontFamily: 'var(--font-mono)' }}>{snap.createdBy}</span>
                  </div>

                  {/* Timestamp */}
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)', marginBottom: snap.label ? 4 : 0 }}>
                    {fmt(snap.createdAt)}
                  </div>

                  {/* Optional label */}
                  {snap.label && (
                    <div style={{
                      fontSize: 11.5, color: 'var(--muted)', fontStyle: 'italic',
                      marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{snap.label}</div>
                  )}

                  {/* Actions — only when selected. Restore moves to the diff pane header; sidebar keeps Delete only. */}
                  {isSelected && canEdit && (
                    <div style={{ display: 'flex', gap: 7, marginTop: 11, paddingTop: 11, borderTop: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => handleDelete(snap.id)}
                        style={{
                          flex: 1, fontSize: 12, padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
                          background: 'transparent', color: 'var(--red)',
                          border: '1.5px solid rgba(220,38,38,0.25)',
                          fontFamily: 'var(--font-sans)', fontWeight: 500, transition: 'all 0.15s',
                        }}
                        onMouseEnter={e => { (e.currentTarget.style.background = 'var(--red)'); (e.currentTarget.style.color = 'var(--accent-fg)'); (e.currentTarget.style.borderColor = 'var(--red)'); }}
                        onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--red)'); (e.currentTarget.style.borderColor = 'rgba(220,38,38,0.25)'); }}
                      >Delete</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Right: diff panel ─────────────────────────────────────────────── */}
      {loadingDetail ? (
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Compare bar skeleton */}
          <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-card)', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 90, height: 14, borderRadius: 4, background: 'var(--surface-2)' }} />
            <div style={{ flex: 1, height: 34, borderRadius: 8, background: 'var(--surface-2)' }} />
          </div>
          {/* Section skeletons */}
          {[120, 80, 60, 200].map((h, i) => (
            <div key={i} style={{ background: 'var(--surface)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-card)', overflow: 'hidden', opacity: 1 - i * 0.15 }}>
              <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ width: 70, height: 11, borderRadius: 4, background: 'var(--surface-2)' }} />
              </div>
              <div style={{ padding: '16px 18px' }}>
                <div style={{ height: h, borderRadius: 6, background: 'var(--surface-2)' }} />
              </div>
            </div>
          ))}
        </div>
      ) : fullSnapshot ? (
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Restore preview header — the diff below shows what restoring this
              snapshot would do to the current state. Green = will be added,
              red = will be removed. Primary action lives here (not in sidebar). */}
          <div style={{
            background: 'var(--surface)', borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-card)', padding: '14px 18px',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em',
                color: 'var(--muted)', textTransform: 'uppercase',
              }}>Restore preview</span>
              <span style={{
                fontSize: 12.5, padding: '5px 10px', borderRadius: 6,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                color: 'var(--text)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
              }}>
                {fmt(fullSnapshot.createdAt)}
              </span>
              <TriggerBadge trigger={fullSnapshot.trigger} />
              {fullSnapshot.label && (
                <span style={{
                  fontSize: 12, color: 'var(--muted)', fontStyle: 'italic',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{fullSnapshot.label}</span>
              )}
              {canEdit && (
                <button
                  onClick={() => handleRestore(fullSnapshot)}
                  disabled={restoring}
                  style={{
                    marginLeft: 'auto', fontSize: 12.5, padding: '7px 16px', borderRadius: 8,
                    cursor: restoring ? 'not-allowed' : 'pointer',
                    background: 'var(--green)', color: 'var(--accent-fg)', border: 'none',
                    fontFamily: 'var(--font-sans)', fontWeight: 600, transition: 'opacity 0.15s',
                  }}
                  onMouseEnter={e => { if (!restoring) (e.currentTarget.style.opacity = '0.85'); }}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                >{restoring ? 'Restoring…' : 'Restore'}</button>
              )}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--subtle)', lineHeight: 1.5 }}>
              If you restore this snapshot, the changes below will apply to your current state.{' '}
              <span style={{ color: 'var(--green)', fontWeight: 600 }}>Green</span> = will be added to current.{' '}
              <span style={{ color: 'var(--red)', fontWeight: 600 }}>Red</span> = will be removed from current.
            </span>
          </div>

          {/* Diff sections — wait for compare target to load */}
          {!currentAsSnapshot ? (
            <div style={{
              background: 'var(--surface)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-card)',
              padding: '24px 18px', textAlign: 'center', color: 'var(--subtle)', fontSize: 13,
            }}>
              Loading comparison…
            </div>
          ) : (() => {
            // Restore-preview frame: current is the OLD side, snapshot is the NEW side.
            // Green = snapshot has, current doesn't = will be added on restore.
            // Red   = current has, snapshot doesn't = will be removed on restore.
            const files = buildDiffFiles(fullSnapshot, currentAsSnapshot);

            // Cheap pre-checks so we can hide the "Other changes" card entirely
            // when nothing on that axis has moved. Mirrors the "no changes"
            // early-returns in PermsDiff / McpsDiff / ChannelsDiff below.
            const currAllowed = new Set(currentAsSnapshot.allowedTools);
            const currDenied  = new Set(currentAsSnapshot.deniedTools);
            const snapAllowed = new Set(fullSnapshot.allowedTools);
            const snapDenied  = new Set(fullSnapshot.deniedTools);
            const hasPermChanges =
              [...currAllowed].some(t => !snapAllowed.has(t)) ||
              [...snapAllowed].some(t => !currAllowed.has(t)) ||
              [...currDenied].some(t => !snapDenied.has(t)) ||
              [...snapDenied].some(t => !currDenied.has(t));

            const currMcps = new Set(currentAsSnapshot.mcpIds);
            const snapMcps = new Set(fullSnapshot.mcpIds);
            const hasMcpChanges =
              [...currMcps].some(id => !snapMcps.has(id)) ||
              [...snapMcps].some(id => !currMcps.has(id));

            const currChs = new Set(currentAsSnapshot.allowedChannels ?? []);
            const snapChs = new Set(fullSnapshot.allowedChannels ?? []);
            const hasChannelChanges =
              [...currChs].some(ch => !snapChs.has(ch)) ||
              [...snapChs].some(ch => !currChs.has(ch));

            const hasOther = hasPermChanges || hasMcpChanges || hasChannelChanges;

            if (files.length === 0 && !hasOther) {
              return (
                <div style={{
                  background: 'var(--surface)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-card)',
                  padding: '24px 18px', textAlign: 'center', color: 'var(--subtle)', fontSize: 13,
                }}>
                  No differences
                </div>
              );
            }

            return (
              <>
                {files.length > 0 && <FilesChanged files={files} />}
                {hasOther && (
                  <div style={{
                    background: 'var(--surface)', borderRadius: 'var(--radius)',
                    boxShadow: 'var(--shadow-card)', overflow: 'hidden',
                  }}>
                    <div style={{
                      padding: '12px 18px', borderBottom: '1px solid var(--border)',
                      fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
                      color: 'var(--muted)', textTransform: 'uppercase',
                    }}>Other changes</div>
                    <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {hasPermChanges    && <PermsDiff    snapshot={fullSnapshot} current={currentAsSnapshot} />}
                      {hasMcpChanges     && <McpsDiff     snapshot={fullSnapshot} current={currentAsSnapshot} allMcps={allMcps} />}
                      {hasChannelChanges && <ChannelsDiff snapshot={fullSnapshot} current={currentAsSnapshot} />}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      ) : (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface)', borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-card)', gap: 10, padding: 40,
        }}>
          <History size={32} style={{ color: 'var(--border-2)' }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Select a snapshot</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', maxWidth: 260, lineHeight: 1.6 }}>
            Click any snapshot on the left to view what changed at that point in time.
          </div>
        </div>
      )}
    </div>
  );
}
