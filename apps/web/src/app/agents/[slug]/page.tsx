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
import { AudiencesPanel } from './audiences-panel';

type Tab = 'overview' | 'instructions' | 'tools' | 'knowledge' | 'audiences' | 'settings';
type SettingsSection = 'general' | 'slack' | 'logs' | 'history' | 'danger';

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
  { id: 'knowledge',     label: 'Wiki'          },
  { id: 'audiences',     label: 'Audiences'     },
  { id: 'settings',      label: 'Settings'      },
];

const STATUS_COLOR = {
  running: '#16a34a',
  stopped: 'var(--border-2)',
  error: '#ef4444',
  stale: '#f59e0b',
} as const;

// ─── Page ─────────────────────────────────────────────────────────────────────

// Minimalist deterministic avatar palette — soft pastel bg + darker fg letter.
// Mirrors the palette used on the dashboard (apps/web/src/app/page.tsx).
const AVATAR_PALETTES: { bg: string; fg: string }[] = [
  { bg: '#fef3c7', fg: '#92400e' }, { bg: '#fce7f3', fg: '#9d174d' },
  { bg: '#ede9fe', fg: '#5b21b6' }, { bg: '#dbeafe', fg: '#1e40af' },
  { bg: '#cffafe', fg: '#155e75' }, { bg: '#dcfce7', fg: '#166534' },
  { bg: '#ecfccb', fg: '#3f6212' }, { bg: '#fee2e2', fg: '#991b1b' },
  { bg: '#ffedd5', fg: '#9a3412' }, { bg: '#f3f4f6', fg: '#1f2937' },
];
function avatarPalette(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTES[Math.abs(h) % AVATAR_PALETTES.length];
}

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
  const [avatarImgFailed, setAvatarImgFailed] = useState(false);
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
          setAgent(found);
          // Admins/superadmins can see Slack tokens — fetch detail endpoint
          fetch(`/api/agents/${found.id}`)
            .then(r => r.json())
            .then((detail: Agent) => setAgent(detail))
            .catch(() => {});
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
              if (writable) {
                // Editors with write access can also see tokens — update in background
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
            {(() => {
              const palette = avatarPalette(agent.name);
              const showSlackImage = !!agent.slackBotImageUrl && !avatarImgFailed;
              return (
                <div style={{
                  width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                  background: showSlackImage ? 'var(--surface-2)' : palette.bg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, fontWeight: 700, color: palette.fg,
                  overflow: 'hidden',
                }}>
                  {showSlackImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={agent.slackBotImageUrl}
                      alt={agent.name}
                      width={36}
                      height={36}
                      onError={() => setAvatarImgFailed(true)}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    agent.name.charAt(0).toUpperCase()
                  )}
                </div>
              );
            })()}
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
                {agent.slackBotHandle ? `@${agent.slackBotHandle} · ` : ''}{agent.model.replace('claude-', '').split('-20')[0]}
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
        {TABS.map(t => (
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
        {tab === 'overview'      && <OverviewTab      agent={agent} onUpdate={setAgent} canEdit={canEdit} allAgents={allAgents} />}
        {tab === 'instructions'  && <InstructionsTab  agent={agent} canEdit={canEdit} onAgentUpdate={setAgent} onOpenCoach={() => setCoachOpen(true)} />}
        {tab === 'tools'         && <ToolsTab          agentId={agent.id} canEdit={canEdit} canManageMcps={canManageUsers} currentUsername={username} />}
        {tab === 'knowledge'     && <KnowledgeTab      agentId={agent.id} agentSlug={agent.slug} canEdit={canEdit} />}
        {tab === 'audiences'     && <AudiencesPanel    agentId={agent.id} canEdit={canEdit} />}
        {tab === 'settings'      && <AgentSettingsTab  agent={agent} onUpdate={setAgent} canEdit={canEdit} viewOnly={viewOnly} allAgents={allAgents} role={role} username={username} />}
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

/** Read-at-a-glance stat tile (icon + value + label) for the Overview summary. */
function StatCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: string }) {
  return (
    <div style={{
      flex: '1 1 140px', minWidth: 130,
      border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px',
      background: 'var(--surface)', boxShadow: 'var(--shadow-sm)',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 9, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: accent ? `${accent}14` : 'var(--surface-2)', color: accent ?? 'var(--muted)',
      }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', lineHeight: 1.1, textTransform: 'capitalize' }}>{value}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{label}</div>
      </div>
    </div>
  );
}

/** Card wrapper used across the Overview for a cohesive SaaS look. */
function Card({ title, action, children }: { title?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 14, background: 'var(--surface)', boxShadow: 'var(--shadow-sm)', padding: '20px 22px' }}>
      {(title || action) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          {title && <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{title}</div>}
          {action}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    </div>
  );
}

/**
 * Overview — slimmed to the agent's identity + an at-a-glance summary. Operational
 * config (Slack, verbose, hierarchy), logs, history and delete now live under the
 * Settings tab. Identity edits PATCH only their own fields (updateAgent merges).
 */
function OverviewTab({ agent, onUpdate, canEdit, allAgents }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean; allAgents: Agent[] }) {
  const [form, setForm] = useState({
    name:        agent.name,
    description: agent.description ?? '',
    persona:     agent.persona ?? '',
    model:       agent.model,
    tags:        agent.tags ?? [] as string[],
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string; sub?: string }[]>([...MODELS]);
  const [counts, setCounts] = useState<{ skills: number; memories: number; tools: number } | null>(null);

  useEffect(() => {
    fetch('/api/system/models').then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.models?.length) setModelOptions(d.models); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!modelOptions.length) return;
    setForm(f => modelOptions.some(m => m.value === f.model) ? f : { ...f, model: modelOptions[0].value });
  }, [modelOptions]);

  useEffect(() => {
    let cancelled = false;
    const len = (x: any, key: string) => Array.isArray(x) ? x.length : (Array.isArray(x?.[key]) ? x[key].length : 0);
    Promise.all([
      fetch(`/api/agents/${agent.id}/skills`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/agents/${agent.id}/memories`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/agents/${agent.id}/mcps`).then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([s, m, t]) => {
      if (!cancelled) setCounts({ skills: len(s, 'skills'), memories: len(m, 'memories'), tools: len(t, 'mcps') });
    });
    return () => { cancelled = true; };
  }, [agent.id]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/agents/${agent.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, persona: form.persona, description: form.description, model: form.model, tags: form.tags }),
      });
      const data = await r.json();
      if (r.ok) { onUpdate(data); setMsg('Saved'); } else setMsg(data.error ?? 'Error');
    } finally { setSaving(false); setTimeout(() => setMsg(''), 3000); }
  };

  const statusAccent = agent.status === 'running' ? '#16a34a' : agent.status === 'error' ? '#ef4444' : 'var(--muted)';
  const num = (n: number | undefined) => counts ? String(n ?? 0) : '—';

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 20 }} className="fade-up">
      {/* Summary stats */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatCard icon={<ActivityIcon size={17} />} label="Status"   value={agent.status} accent={statusAccent} />
        <StatCard icon={<BookOpen size={17} />}     label="Skills"   value={num(counts?.skills)}   accent="#2563eb" />
        <StatCard icon={<Brain size={17} />}        label="Memories" value={num(counts?.memories)} accent="#7c3aed" />
        <StatCard icon={<Database size={17} />}     label="Tools"    value={num(counts?.tools)}    accent="#059669" />
      </div>

      {/* Identity */}
      <Card title="Identity" action={canEdit ? <PrimaryBtn onClick={save} loading={saving}>{msg || 'Save'}</PrimaryBtn> : undefined}>
        <Grid2>
          <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} readOnly={!canEdit}
            hint="Internal agent name." />
          <SelectField label="Model" value={form.model} options={modelOptions}
            onChange={v => setForm(f => ({ ...f, model: v }))}
            hint="Model this agent runs on (options follow the active backend)." readOnly={!canEdit} />
        </Grid2>
        <Field label="Description" value={form.description}
          onChange={v => setForm(f => ({ ...f, description: v }))}
          hint="Short summary — used by boss agents for delegation." readOnly={!canEdit} />
        <TagInput tags={form.tags} onChange={tags => setForm(f => ({ ...f, tags }))}
          allTags={allAgents.flatMap(a => a.tags ?? [])} readOnly={!canEdit} />
        <TextArea label="Persona" value={form.persona}
          onChange={v => setForm(f => ({ ...f, persona: v }))}
          hint="Who is this agent? This becomes the identity shown in Instructions → Skills." rows={4} readOnly={!canEdit} />
      </Card>
    </div>
  );
}

// ─── Agent Settings (side-nav: General · Slack · Logs · History · Danger) ──────

function AgentSettingsTab({ agent, onUpdate, canEdit, viewOnly, allAgents, role, username }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean; viewOnly: boolean; allAgents: Agent[]; role: string | null; username: string }) {
  const isAdmin = role === 'admin' || role === 'superadmin';
  const canDelete = isAdmin || agent.createdBy === username;
  const sections: { id: SettingsSection; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'slack', label: 'Slack' },
  ];
  if (!viewOnly) sections.push({ id: 'logs', label: 'Logs' }, { id: 'history', label: 'History' });
  if (canDelete) sections.push({ id: 'danger', label: 'Danger Zone' });
  const [section, setSection] = useState<SettingsSection>('general');

  return (
    <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }} className="fade-up">
      <div style={{ width: 170, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{
            textAlign: 'left', padding: '8px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
            fontSize: 13, fontFamily: 'var(--font-sans)',
            background: section === s.id ? 'var(--surface-2)' : 'transparent',
            color: section === s.id ? (s.id === 'danger' ? '#dc2626' : 'var(--text)') : 'var(--muted)',
            fontWeight: section === s.id ? 500 : 400,
          }}>{s.label}</button>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 320 }}>
        {section === 'general' && <GeneralSettingsSection agent={agent} onUpdate={onUpdate} canEdit={canEdit} allAgents={allAgents} />}
        {section === 'slack'   && <SlackSettingsSection   agent={agent} onUpdate={onUpdate} canEdit={canEdit} />}
        {section === 'logs'    && <LogsTab    agentId={agent.id} slug={agent.slug} />}
        {section === 'history' && <HistoryTab agentId={agent.id} canEdit={canEdit} />}
        {section === 'danger'  && <DangerSection agent={agent} canDelete={canDelete} />}
      </div>
    </div>
  );
}

function GeneralSettingsSection({ agent, onUpdate, canEdit, allAgents }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean; allAgents: Agent[] }) {
  const [form, setForm] = useState({ isBoss: agent.isBoss, verbose: agent.verbose ?? true, reportsTo: agent.reportsTo ?? [] as string[] });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/agents/${agent.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isBoss: form.isBoss, verbose: form.verbose, reportsTo: form.reportsTo }),
      });
      const data = await r.json();
      if (r.ok) { onUpdate(data); setMsg('Saved'); } else setMsg(data.error ?? 'Error');
    } finally { setSaving(false); setTimeout(() => setMsg(''), 3000); }
  };
  return (
    <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card title="Behavior">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>Verbose Responses</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>On: each step is posted as it happens. Off: only the final answer is sent as one message.</div>
          </div>
          <button disabled={!canEdit} onClick={() => setForm(f => ({ ...f, verbose: !f.verbose }))} style={{
            width: 44, height: 24, borderRadius: 12, border: 'none', background: form.verbose ? '#3b82f6' : 'var(--border-2)',
            cursor: canEdit ? 'pointer' : 'default', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
          }}>
            <div style={{ position: 'absolute', top: 3, left: form.verbose ? 23 : 3, width: 18, height: 18, borderRadius: '50%', background: 'var(--surface)', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
          </button>
        </div>
      </Card>

      <Card title="Role & Hierarchy">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>Boss Agent</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Boss agents orchestrate other agents and delegate tasks</div>
          </div>
          <button disabled={!canEdit} onClick={() => setForm(f => ({ ...f, isBoss: !f.isBoss }))} style={{
            width: 44, height: 24, borderRadius: 12, border: 'none', background: form.isBoss ? '#d97706' : 'var(--border-2)',
            cursor: canEdit ? 'pointer' : 'default', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
          }}>
            <div style={{ position: 'absolute', top: 3, left: form.isBoss ? 23 : 3, width: 18, height: 18, borderRadius: '50%', background: 'var(--surface)', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
          </button>
        </div>
        {!form.isBoss && (() => {
          const bosses = allAgents.filter(a => a.isBoss && a.id !== agent.id);
          if (bosses.length === 0) return (
            <div style={{ fontSize: 12, color: 'var(--subtle)', fontStyle: 'italic' }}>No boss agents available. Create a boss agent first.</div>
          );
          return (
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 6 }}>Reports To</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {bosses.map(boss => {
                  const checked = form.reportsTo.includes(boss.id);
                  return (
                    <label key={boss.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8,
                      border: `1px solid ${checked ? 'rgba(217,119,6,0.3)' : 'var(--border)'}`,
                      background: checked ? 'rgba(217,119,6,0.04)' : 'var(--surface)',
                      cursor: canEdit ? 'pointer' : 'default', transition: 'all 0.15s',
                    }}>
                      <input type="checkbox" checked={checked} disabled={!canEdit}
                        onChange={() => setForm(f => ({ ...f, reportsTo: checked ? f.reportsTo.filter(id => id !== boss.id) : [...f.reportsTo, boss.id] }))}
                        style={{ accentColor: '#d97706', width: 14, height: 14 }} />
                      <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: 'var(--accent-fg)', flexShrink: 0 }}>{boss.name.charAt(0).toUpperCase()}</div>
                      <div style={{ minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{boss.name}</div></div>
                      {checked && <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, color: '#d97706', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Reports to</span>}
                    </label>
                  );
                })}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--subtle)', marginTop: 8 }}>An agent can report to multiple bosses.</div>
            </div>
          );
        })()}
      </Card>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {canEdit && <PrimaryBtn onClick={save} loading={saving}>Save Changes</PrimaryBtn>}
        {msg && <span style={{ fontSize: 12, color: '#16a34a' }}>{msg}</span>}
      </div>
    </div>
  );
}

function SlackSettingsSection({ agent, onUpdate, canEdit }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean }) {
  const [form, setForm] = useState({ slackBotToken: agent.slackBotToken, slackAppToken: agent.slackAppToken, slackSigningSecret: agent.slackSigningSecret });
  const [allowedChannels, setAllowedChannels] = useState('');
  const [slackInfo, setSlackInfo] = useState<{ displayName: string; handle: string; teamName: string } | null>(null);
  const [manifest, setManifest] = useState('');
  const [showManifest, setShowManifest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!agent.slackBotToken) return;
    fetch(`/api/agents/${agent.id}/slack-info`).then(r => r.ok ? r.json() : null).then(d => d && setSlackInfo(d)).catch(() => {});
  }, [agent.id, agent.slackBotToken]);
  useEffect(() => {
    fetch(`/api/agents/${agent.id}/restrictions`).then(r => r.json()).then((d: Restriction) => setAllowedChannels((d.allowedChannels ?? []).join('\n'))).catch(() => {});
  }, [agent.id]);

  const save = async () => {
    setSaving(true);
    try {
      const [r] = await Promise.all([
        fetch(`/api/agents/${agent.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form.slackBotToken ? { platformCredentials: { botToken: form.slackBotToken, appToken: form.slackAppToken, signingSecret: form.slackSigningSecret } } : {}),
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

  return (
    <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card title="Slack Credentials">
        <Field label="Bot Token" value={form.slackBotToken ?? ''} onChange={v => setForm(f => ({ ...f, slackBotToken: v }))} type="password" readOnly={!canEdit}
          hint={<>api.slack.com/apps → your app → <strong>OAuth &amp; Permissions</strong> → Bot User OAuth Token</>} />
        <Field label="App-Level Token" value={form.slackAppToken ?? ''} onChange={v => setForm(f => ({ ...f, slackAppToken: v }))} type="password" readOnly={!canEdit}
          hint={<>Basic Information → <strong>App-Level Tokens</strong> → Generate with scope <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>connections:write</code></>} />
        <Field label="Signing Secret" value={form.slackSigningSecret ?? ''} onChange={v => setForm(f => ({ ...f, slackSigningSecret: v }))} type="password" readOnly={!canEdit}
          hint="Basic Information → App Credentials → Signing Secret" />
        {slackInfo && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 7, padding: '10px 14px', fontSize: 12 }}>
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
      </Card>

      <Card title="Allowed Channels">
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          Restrict this bot to specific Slack channels. One Slack channel ID per line (e.g. <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>C01234ABCDE</code>).
          If empty, the bot responds in all channels it's invited to.
        </p>
        <textarea value={allowedChannels} onChange={e => setAllowedChannels(e.target.value)} rows={4} readOnly={!canEdit} placeholder={'C01234ABCDE\nC09876ZYXWV'}
          style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }}
          onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')} onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
      </Card>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {canEdit && <PrimaryBtn onClick={save} loading={saving}>Save Changes</PrimaryBtn>}
        <GhostBtn onClick={loadManifest}>View Slack Manifest</GhostBtn>
        {msg && <span style={{ fontSize: 12, color: '#16a34a' }}>{msg}</span>}
      </div>

      {showManifest && (
        <div style={{ marginTop: 20, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
            <span style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>slack-manifest.json</span>
            <button onClick={() => navigator.clipboard.writeText(manifest)} style={{ fontSize: 11.5, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>Copy</button>
          </div>
          <pre style={{ margin: 0, padding: '16px', fontSize: 11.5, color: 'var(--accent)', fontFamily: 'var(--font-mono)', overflow: 'auto', maxHeight: 320 }}>{manifest}</pre>
        </div>
      )}
    </div>
  );
}

function DangerSection({ agent, canDelete }: { agent: Agent; canDelete: boolean }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState('');
  const handleDelete = async () => {
    if (!confirm(`Permanently delete agent "${agent.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    const r = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
    if (r.ok) { window.dispatchEvent(new Event('slackhive:sidebar-refresh')); router.push('/'); }
    else { const err = await r.json(); setMsg(err.error ?? 'Delete failed'); setDeleting(false); }
  };
  if (!canDelete) return <div style={{ fontSize: 13, color: 'var(--muted)' }}>You don&apos;t have permission to delete this agent.</div>;
  return (
    <div style={{ maxWidth: 620 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 16 }}>Danger Zone</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--surface-2)', border: '1px solid var(--red-soft-border)', borderRadius: 8, padding: '14px 18px' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 3 }}>Delete this agent</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Permanently removes the agent, all its skills, memories, and history. This cannot be undone.</div>
        </div>
        <button onClick={handleDelete} disabled={deleting} style={{
          flexShrink: 0, marginLeft: 24, padding: '8px 18px', borderRadius: 7, border: '1px solid #dc2626',
          background: deleting ? 'var(--surface-2)' : 'var(--surface)', color: '#dc2626', fontSize: 13, fontWeight: 600,
          cursor: deleting ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
        }}>{deleting ? 'Deleting…' : 'Delete Agent'}</button>
      </div>
      {msg && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 10 }}>{msg}</div>}
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
  // Which surface is shown — System Prompt, Skills, or Memory (was: System Prompt
  // always-on + a separate Skills/Memory sub-tab bar). One segmented control reads
  // cleaner and gives each surface the full width.
  const [section, setSection] = useState<'system' | 'skills' | 'memory'>('system');

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
                    This will overwrite current AGENTS.md and skills
                  </div>
                  <div style={{ fontSize: 12, color: '#9f1239' }}>
                    Existing AGENTS.md will be replaced. Skills with matching category/filename will be overwritten. A snapshot is saved automatically before applying.
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

      {/* ── Toolbar: segmented switcher + labeled actions ───────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <SegmentedControl
          value={section}
          onChange={setSection}
          options={[
            { id: 'system', label: 'System Prompt' },
            { id: 'skills', label: 'Skills' },
            { id: 'memory', label: 'Memory' },
          ]}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {importError && <span style={{ fontSize: 11.5, color: 'var(--red)' }}>{importError}</span>}
          {canEdit && <ActionBtn icon={<Download size={13} />} label="Export" onClick={handleExport} loading={exporting} />}
          {canEdit && <ActionBtn icon={<Upload size={13} />} label="Persona Library" onClick={() => setPersonaLibOpen(true)} />}
          {canEdit && !agent.isBoss && <ActionBtn icon={<Wand2 size={13} />} label="Coach" onClick={() => onOpenCoach?.()} primary />}
        </div>
      </div>

      {/* ── Active surface ──────────────────────────────────────────────── */}
      {section === 'system' && (
        <div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
            {agent.isBoss
              ? 'Auto-generated from your team roster. Updates automatically when agents are added or removed.'
              : "Define how this agent should behave — its rules, workflows, and response style. Always in the agent's context."}
          </p>
          <ClaudeMdSection agentId={agent.id} canEdit={canEdit && !agent.isBoss} />
        </div>
      )}
      {section === 'skills' && (
        <div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
            Specialized knowledge files the agent uses on demand via /commands. Add domain expertise, workflows, or reference docs.
          </p>
          <SkillsTab agentId={agent.id} canEdit={canEdit} agentName={agent.name} agentPersona={agent.persona ?? ''} agentDescription={agent.description ?? ''} />
        </div>
      )}
      {section === 'memory' && (
        <div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
            Learned from conversations — the agent asks before saving. Open Coach to review and clean up.
          </p>
          <MemorySection agentId={agent.id} canEdit={canEdit} />
        </div>
      )}
    </div>
  );
}

/** Pill-style segmented switcher (System Prompt · Skills · Memory). */
function SegmentedControl<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div style={{ display: 'inline-flex', gap: 2, padding: 3, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
      {options.map(o => (
        <button key={o.id} onClick={() => onChange(o.id)} style={{
          padding: '6px 16px', fontSize: 13, borderRadius: 7, border: 'none',
          cursor: 'pointer', fontFamily: 'var(--font-sans)',
          background: value === o.id ? 'var(--surface)' : 'transparent',
          color: value === o.id ? 'var(--text)' : 'var(--muted)',
          fontWeight: value === o.id ? 600 : 400,
          boxShadow: value === o.id ? 'var(--shadow-sm)' : 'none',
          transition: 'all 0.15s',
        }}>{o.label}</button>
      ))}
    </div>
  );
}

/** Labeled action button (icon + text) — used for the Instructions toolbar so
 *  Coach / Export / Persona Library aren't hidden behind bare icons. */
function ActionBtn({ icon, label, onClick, loading, primary }: { icon: React.ReactNode; label: string; onClick?: () => void; loading?: boolean; primary?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px',
      fontSize: 12.5, fontWeight: 500, borderRadius: 8, fontFamily: 'var(--font-sans)',
      cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
      border: primary ? '1px solid transparent' : '1px solid var(--border)',
      background: primary ? 'var(--accent)' : 'var(--surface)',
      color: primary ? 'var(--accent-fg)' : 'var(--text)',
      transition: 'all 0.15s',
    }}>
      {loading ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> : icon}
      {label}
    </button>
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
  const [skills, setSkills]         = useState<Skill[]>([]);
  const [selected, setSelected]     = useState<Skill | null>(null);
  const [content, setContent]       = useState('');
  const [description, setDescription] = useState('');
  const [descModal, setDescModal]   = useState(false);
  const [descDraft, setDescDraft]   = useState('');
  // Description value at the moment Regenerate was clicked. We only end the
  // loader when polling brings in a description that differs from this — the
  // old code ended on any truthy description, so the spinner flickered off
  // before the runner had even started summarizing.
  const [regenBaseline, setRegenBaseline] = useState<string | null>(null);
  const [saving, setSaving]         = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [msg, setMsg]               = useState('');
  const [showNew, setShowNew]       = useState(false);
  const [newSkill, setNewSkill]     = useState({ category: '', filename: '', content: '' });

  const load = () =>
    fetch(`/api/agents/${agentId}/skills`).then(r => r.json()).then((next: Skill[]) => {
      setSkills(next);
      // Keep the selected skill's description in sync if the runner just
      // filled it in via summarize. Without this, the input shows the stale
      // value from the moment the user clicked into the file.
      setSelected(prev => {
        if (!prev || prev.id === '__identity__') return prev;
        const fresh = next.find(s => s.id === prev.id);
        if (fresh && fresh.description !== prev.description) {
          setDescription(fresh.description ?? '');
          return fresh;
        }
        return prev;
      });
    });

  useEffect(() => { load(); }, [agentId]);

  // Re-fetch when Coach applies / finishes bootstrapping.
  useEffect(() => {
    const h = () => load();
    window.addEventListener('slackhive:instructions-refresh', h);
    return () => window.removeEventListener('slackhive:instructions-refresh', h);
  }, [agentId]);

  // Light polling so a freshly-saved or regenerating skill picks up the
  // description the runner just summarized. Polls while the selected skill
  // has no description OR a regenerate is in flight; stops once filled.
  useEffect(() => {
    if (!selected || selected.id === '__identity__') return;
    if (selected.description && !regenerating) return;
    const t = setInterval(load, 1_500);
    return () => clearInterval(t);
  }, [selected?.id, selected?.description, regenerating]);

  // When polling brings in a fresh description that's actually new (not the
  // pre-click value), end the regenerating state and seed the modal draft.
  useEffect(() => {
    if (!regenerating) return;
    if (!selected?.description) return;
    if (selected.description === regenBaseline) return; // still old value
    setRegenerating(false);
    setRegenBaseline(null);
    if (descModal) setDescDraft(selected.description);
  }, [selected?.description, regenerating, regenBaseline, descModal]);

  const select = (s: Skill) => {
    setSelected(s);
    setContent(s.content);
    setDescription(s.description ?? '');
    setDescModal(false);
  };

  const openDescModal = () => {
    setDescDraft(description);
    setDescModal(true);
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    // Content-only save. Description has its own PATCH path so a content edit
    // never wipes a description the runner just summarized.
    await fetch(`/api/agents/${agentId}/skills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: selected.category, filename: selected.filename,
        content, sortOrder: selected.sortOrder,
      }),
    });
    setSaving(false); setMsg('Saved'); setTimeout(() => setMsg(''), 2000); load();
  };

  const regenerate = async () => {
    if (!selected || selected.id === '__identity__') return;
    // Snapshot the current description so the polling effect can tell when
    // the runner has actually written a NEW value (vs just seeing the old
    // one on the next poll tick).
    setRegenBaseline(selected.description ?? '');
    setRegenerating(true);
    // Modal stays OPEN so the user has somewhere to watch the spinner and
    // can review the new draft before saving it. The second effect below
    // populates descDraft once the runner writes back.
    await fetch(`/api/agents/${agentId}/skills/${selected.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate: true }),
    });
    // Polling keeps `regenerating` true until the new description arrives.
  };

  const saveDescription = async () => {
    if (!selected || selected.id === '__identity__') return;
    const trimmed = descDraft.trim();
    await fetch(`/api/agents/${agentId}/skills/${selected.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: trimmed === '' ? null : trimmed }),
    });
    setDescription(trimmed);
    setDescModal(false);
    setMsg('Saved'); setTimeout(() => setMsg(''), 1500);
    load();
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
    description: null,
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
              background: 'var(--surface-2)', gap: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                  {selected.category}/{selected.filename}
                </span>
                {isIdentity && <span style={{ fontSize: 10, color: 'var(--subtle)', background: 'var(--surface-3)', padding: '1px 6px', borderRadius: 3 }}>read-only · edit in Overview</span>}
                {!isIdentity && (
                  <button
                    onClick={openDescModal}
                    disabled={!canEdit && !description}
                    title={
                      regenerating ? 'Regenerating with AI…'
                        : description ? description
                        : (canEdit ? 'Add a "when to use" description' : 'No description')
                    }
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 10, fontWeight: 500, letterSpacing: '0.04em',
                      textTransform: 'uppercase', fontFamily: 'var(--font-sans)',
                      background: 'var(--surface-3)', color: 'var(--muted)',
                      border: 'none', borderRadius: 3,
                      padding: '2px 8px', cursor: canEdit ? 'pointer' : 'default',
                      flexShrink: 0,
                    }}
                    onMouseEnter={e => { if (canEdit) (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
                    onMouseLeave={e => { if (canEdit) (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; }}
                  >
                    {regenerating && (
                      <span
                        aria-label="Regenerating"
                        style={{
                          width: 8, height: 8, flexShrink: 0,
                          border: '1.5px solid var(--border-2)',
                          borderTopColor: 'var(--text)',
                          borderRadius: '50%',
                          animation: 'spin 0.8s linear infinite',
                        }}
                      />
                    )}
                    desc
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
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

      {/* Edit description modal */}
      {descModal && selected && (
        <Modal title={`Edit description — ${selected.filename}`} onClose={() => setDescModal(false)}>
          <div style={{ position: 'relative' }}>
            <TextArea
              label="Description"
              value={descDraft}
              onChange={setDescDraft}
              rows={3}
              hint='Frame as a "when to use" trigger so the agent picks the right /command. e.g. "Use when filing a Notion bug ticket from a Slack investigation".'
            />
            {regenerating && (
              <div style={{
                position: 'absolute', inset: '24px 0 32px 0',
                background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(2px)',
                borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                color: 'var(--text)', fontSize: 13, fontWeight: 500,
                pointerEvents: 'none',
              }}>
                <span
                  aria-label="Regenerating"
                  style={{
                    width: 14, height: 14, flexShrink: 0,
                    border: '2px solid var(--border-2)',
                    borderTopColor: 'var(--text)',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
                Regenerating with AI…
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <PrimaryBtn onClick={saveDescription}>Save</PrimaryBtn>
              <GhostBtn onClick={() => setDescModal(false)}>Cancel</GhostBtn>
            </div>
            <GhostBtn onClick={regenerate}>{regenerating ? 'Regenerating…' : 'Regenerate with AI'}</GhostBtn>
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
  // Tracks the initial fetch so the empty-state ("No MCP servers yet")
  // doesn't flash before the data arrives. Without this, /api/mcps round-trip
  // latency reads as "the feature is broken".
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      fetch('/api/mcps').then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
      fetch(`/api/agents/${agentId}/mcps`).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
    ]).then(([a, b]: [McpServer[], McpServer[]]) => {
      if (cancelled) return;
      setAll(a); setAssigned(new Set(b.map(m => m.id)));
    }).catch(err => {
      if (cancelled) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
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
        {loading ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading apps…
          </div>
        ) : loadError ? (
          <div style={{ padding: '16px 20px', color: 'var(--red)', fontSize: 13, background: 'var(--red-soft-bg)' }}>
            Couldn't load MCP servers: {loadError}
          </div>
        ) : all.length === 0 ? (
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
                {canEdit && !canAssign && (
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
  // Without a loading flag, the toggles render in their "off" state during
  // the round-trip and then flip on once data arrives — looks like the
  // setting is being changed under the user's feet.
  const [loading, setLoading] = useState(true);

  const internetOn = INTERNET_TOOLS.every(t => allowed.includes(t));
  const shellOn = SHELL_TOOLS.some(t => allowed.includes(t));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/agents/${agentId}/permissions`).then(r => r.json()).then((p: Permission) => {
      if (cancelled) return;
      setAllowed(p.allowedTools ?? []);
      setDenied(p.deniedTools ?? []);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
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

  if (loading) {
    return (
      <div style={{
        maxWidth: 500, padding: '20px 22px',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
        display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 13,
      }}>
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading capabilities…
      </div>
    );
  }

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
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    return fetch(`/api/agents/${agentId}/memories`)
      .then(r => r.json())
      .then(setMemories)
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [agentId]);

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete memory "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/agents/${agentId}/memories/${id}`, { method: 'DELETE' });
    load();
  };

  const toggle = (id: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const grouped = memories.reduce<Record<string, Memory[]>>((acc, m) => {
    (acc[m.type] ??= []).push(m); return acc;
  }, {});

  if (loading) {
    return (
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, padding: '24px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        color: 'var(--muted)', fontSize: 13,
      }}>
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading memories…
      </div>
    );
  }

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
                        onClick={e => { e.stopPropagation(); remove(m.id, m.name); }}
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

// ─── Knowledge (Wiki Folder Assignment) ─────────────────────────────────────

interface WikiFolder { id: string; name: string; description?: string; createdBy: string; createdAt: string; updatedAt: string; }
interface WikiSource  { id: string; status: string; wordCount: number; type: string; }

function KnowledgeTab({ agentId, canEdit }: { agentId: string; agentSlug: string; canEdit: boolean }) {
  const [allFolders, setAllFolders]   = useState<(WikiFolder & { assigned: boolean })[]>([]);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/wiki-folders').then(r => r.json()) as Promise<WikiFolder[]>,
      fetch(`/api/agents/${agentId}/wiki-folders`).then(r => r.json()) as Promise<WikiFolder[]>,
    ]).then(([all, assigned]) => {
      const assignedIds = new Set(assigned.map((f: WikiFolder) => f.id));
      setAllFolders(all.map(f => ({ ...f, assigned: assignedIds.has(f.id) })));
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [agentId]);

  async function toggle(folderId: string, currentlyAssigned: boolean) {
    setSaving(true);
    const updated = allFolders.map(f => f.id === folderId ? { ...f, assigned: !currentlyAssigned } : f);
    setAllFolders(updated);
    const newIds = updated.filter(f => f.assigned).map(f => f.id);
    const r = await fetch(`/api/agents/${agentId}/wiki-folders`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderIds: newIds }),
    });
    if (!r.ok) {
      // Roll back optimistic update
      setAllFolders(allFolders);
      const err = await r.json().catch(() => ({}));
      alert(err.error ?? 'Failed to update wiki folder assignment');
    }
    setSaving(false);
  }

  return (
    <div style={{ maxWidth: 700 }}>
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>Wiki Folders</h3>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          Assign shared knowledge folders to this agent. The agent reads these wikis at compile time.
          Manage folder contents in the <a href="/knowledge" style={{ color: 'var(--accent)' }}>Knowledge Library</a>.
        </p>
      </div>

      {loading ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : allFolders.length === 0 ? (
        <div style={{
          border: '1px dashed var(--border)', borderRadius: 10, padding: '32px',
          textAlign: 'center', color: 'var(--muted)', fontSize: 13,
        }}>
          No wiki folders exist yet. <a href="/knowledge" style={{ color: 'var(--accent)' }}>Create one in the Knowledge Library.</a>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {allFolders.map(f => (
            <div key={f.id} style={{
              background: 'var(--surface)', border: `1px solid ${f.assigned ? 'var(--accent-border, rgba(99,102,241,0.35))' : 'var(--border)'}`,
              borderRadius: 10, padding: '14px 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              transition: 'border-color 0.15s',
            }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)', marginBottom: 3 }}>{f.name}</div>
                {f.description && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{f.description}</div>}
                <div style={{ fontSize: 11.5, color: 'var(--subtle)', marginTop: 3 }}>Created by {f.createdBy}</div>
              </div>
              {canEdit ? (
                <button
                  onClick={() => toggle(f.id, f.assigned)}
                  disabled={saving}
                  style={{
                    padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 500,
                    cursor: saving ? 'default' : 'pointer', border: 'none',
                    background: f.assigned ? 'var(--accent)' : 'var(--surface-2)',
                    color: f.assigned ? 'var(--accent-fg)' : 'var(--text)',
                    opacity: saving ? 0.6 : 1, transition: 'background 0.15s, color 0.15s',
                    flexShrink: 0,
                  }}
                >
                  {f.assigned ? 'Assigned' : 'Assign'}
                </button>
              ) : (
                <span style={{ fontSize: 12, color: f.assigned ? '#059669' : 'var(--subtle)', fontWeight: 500 }}>
                  {f.assigned ? 'Assigned' : 'Not assigned'}
                </span>
              )}
            </div>
          ))}
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

const SUGGESTED_TAGS = ['Engineering', 'Product', 'Infra', 'Security', 'Customer Success', 'Data', 'Marketing', 'Operations'];

function TagInput({ tags, onChange, allTags, readOnly }: { tags: string[]; onChange: (t: string[]) => void; allTags: string[]; readOnly?: boolean }) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const suggestions = [...new Set([...SUGGESTED_TAGS, ...allTags])].filter(
    t => t.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t)
  );
  const add = (tag: string) => {
    const t = tag.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setInput('');
  };
  const remove = (tag: string) => onChange(tags.filter(t => t !== tag));
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && input.trim()) { e.preventDefault(); add(input); }
    if (e.key === 'Backspace' && !input && tags.length) remove(tags[tags.length - 1]);
  };
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>Tags</div>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
        border: '1px solid var(--border-2)', borderRadius: 8, padding: '6px 10px',
        background: readOnly ? 'var(--surface-2)' : 'var(--surface)',
        minHeight: 38,
      }}>
        {tags.map(tag => (
          <span key={tag} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'var(--accent-soft, rgba(59,130,246,0.12))', color: 'var(--accent, #3b82f6)',
            borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 500,
          }}>
            {tag}
            {!readOnly && (
              <button onClick={() => remove(tag)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: 'inherit', opacity: 0.7 }}>×</button>
            )}
          </span>
        ))}
        {!readOnly && (
          <div style={{ position: 'relative', flex: 1, minWidth: 80 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKey}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              placeholder={tags.length === 0 ? 'Add tags...' : ''}
              style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: 'var(--text)', width: '100%', padding: 0 }}
            />
            {focused && (input || suggestions.length > 0) && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 50, marginTop: 4,
                background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 8,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 180, maxHeight: 200, overflowY: 'auto',
              }}>
                {suggestions.map(s => (
                  <div key={s} onMouseDown={() => add(s)} style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--text)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    {s}
                  </div>
                ))}
                {input.trim() && !tags.includes(input.trim()) && !suggestions.includes(input.trim()) && (
                  <div onMouseDown={() => add(input)} style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--accent, #3b82f6)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    Add &ldquo;{input.trim()}&rdquo;
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Press Enter or comma to add. Used for filtering on the dashboard.</div>
    </div>
  );
}

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

function SelectField({ label, value, options, onChange, hint, readOnly }: {
  label: string; value: string; options: { value: string; label: string; sub?: string }[];
  onChange: (v: string) => void; hint?: React.ReactNode; readOnly?: boolean;
}) {
  const known = options.some(o => o.value === value);
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>
        {label}
      </label>
      <select
        value={value} onChange={e => onChange(e.target.value)} disabled={readOnly}
        style={{
          width: '100%', background: 'var(--surface)', border: '1.5px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '10px 14px', color: 'var(--text)',
          fontSize: 14, fontFamily: 'var(--font-sans)', outline: 'none',
          cursor: readOnly ? 'default' : 'pointer',
        }}
      >
        {options.map((o, i) => (
          <option key={o.value} value={o.value}>{o.label}{o.sub ? ` — ${o.sub}` : ''}{i === 0 ? ' (default)' : ''}</option>
        ))}
        {!known && value && <option value={value}>{value}</option>}
      </select>
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
    files.push({ path: 'AGENTS.md', status: 'modified', oldText: currMd, newText: snapMd });
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
