'use client';

/**
 * @fileoverview Agent detail page — tabbed control panel.
 *
 * Tabs: Overview · Skills · MCPs · Permissions · Memory · Logs
 *
 * Route: /agents/[slug]
 * @module web/app/agents/[slug]
 */

import React, { useEffect, useState, useRef, use } from 'react';
import { Brain, Camera, Clock, History, Upload, Download, Wand2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Agent, Skill, McpServer, Memory, Permission, Restriction, AgentSnapshot } from '@slackhive/shared';
import { Portal } from '@/lib/portal';
import { useAuth } from '@/lib/auth-context';
import { lineDiff, type DiffLine } from '@/lib/diff';

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
  { id: 'knowledge',     label: 'Knowledge'     },
  { id: 'logs',          label: 'Logs'          },
  { id: 'history',       label: 'History'       },
];

const STATUS_COLOR = { running: '#16a34a', stopped: 'var(--border-2)', error: '#ef4444' } as const;

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Agent detail page — loads the agent by slug then renders the tabbed UI.
 *
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export default function AgentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { role, canManageUsers } = useAuth();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importPreview, setImportPreview] = useState<AgentExportPayload | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then((agents: Agent[]) => {
        setAllAgents(agents);
        const found = agents.find(a => a.slug === slug) ?? null;
        setAgent(found);
        if (found) {
          if (role === 'admin' || role === 'superadmin') {
            setCanEdit(true);
          } else if (role === 'editor' || role === 'viewer') {
            fetch(`/api/agents/${found.id}/access`)
              .then(r => r.json())
              .then(data => setCanEdit(role === 'editor' && (data.canWrite ?? false)));
          }
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

  const handleExport = async () => {
    if (!agent) return;
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
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);

        // Validate required fields
        if (!data || typeof data !== 'object') { setImportError('Invalid file: not a JSON object'); return; }
        if (typeof data.claudeMd !== 'string') { setImportError('Invalid file: missing claudeMd field'); return; }
        if (!Array.isArray(data.skills)) { setImportError('Invalid file: missing skills array'); return; }

        // Validate each skill
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

  const applyImport = async () => {
    if (!agent || !importPreview) return;
    setImporting(true);
    try {
      // Update persona/description if present in the export
      if (importPreview.persona !== undefined || importPreview.description !== undefined) {
        await fetch(`/api/agents/${agent.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(importPreview.persona !== undefined && { persona: importPreview.persona }),
            ...(importPreview.description !== undefined && { description: importPreview.description }),
          }),
        });
      }

      // Update system prompt
      await fetch(`/api/agents/${agent.id}/claude-md`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' },
        body: importPreview.claudeMd,
      });

      // Upsert skills
      await Promise.all(importPreview.skills.map(s =>
        fetch(`/api/agents/${agent.id}/skills?noSnapshot=1`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(s),
        })
      ));

      const updated = await fetch(`/api/agents/${agent.id}`).then(r => r.json());
      setAgent(updated);
      setImportPreview(null);
      window.dispatchEvent(new Event('slackhive:sidebar-refresh'));
    } finally { setImporting(false); }
  };

  if (loading) return <PageLoader />;
  if (!agent)  return <NotFound slug={slug} />;

  const statusColor = STATUS_COLOR[agent.status] ?? 'var(--border-2)';

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
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div
                    className={agent.status === 'running' ? 'status-running' : ''}
                    style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor }}
                  />
                  <span style={{ fontSize: 12, color: statusColor, fontWeight: 500, textTransform: 'capitalize' }}>
                    {agent.status}
                  </span>
                </div>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>
                @{agent.slug} · {agent.model.replace('claude-', '').split('-20')[0]}
              </div>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 16 }}>
          {actionMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{actionMsg}</span>}
          {importError && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{importError}</span>}

          {/* Export / Import icon buttons */}
          <IconBtn title="Export config" onClick={handleExport} loading={exporting}>
            <Download size={15} />
          </IconBtn>
          {canEdit && (
            <IconBtn title="Import config" onClick={() => fileInputRef.current?.click()}>
              <Upload size={15} />
            </IconBtn>
          )}
          <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} />

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

      {/* Import confirmation modal */}
      {importPreview && (
        <Portal>
          <div style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} onClick={() => setImportPreview(null)}>
            <div style={{
              background: 'var(--surface)', borderRadius: 14, padding: '28px 32px',
              maxWidth: 480, width: '90%',
              boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
            }} onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>
                Import agent config
              </h3>

              {/* Danger warning — shown first */}
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
                <PrimaryBtn onClick={applyImport} loading={importing}>Apply Import</PrimaryBtn>
                <GhostBtn onClick={() => setImportPreview(null)}>Cancel</GhostBtn>
              </div>
            </div>
          </div>
        </Portal>
      )}

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
        {tab === 'overview'      && <OverviewTab      agent={agent} onUpdate={setAgent} canEdit={canEdit} allAgents={allAgents} role={role} />}
        {tab === 'instructions'  && <InstructionsTab  agent={agent} canEdit={canEdit} />}
        {tab === 'tools'         && <ToolsTab          agentId={agent.id} canEdit={canEdit} />}
        {tab === 'knowledge'     && <KnowledgeTab      agentId={agent.id} canEdit={canEdit} />}
        {/* Memory is now inside Instructions tab */}
        {tab === 'logs'        && <LogsTab        agentId={agent.id} slug={agent.slug} />}
        {tab === 'history'     && <HistoryTab     agentId={agent.id} canEdit={canEdit} />}
      </div>
    </div>
  );
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({ agent, onUpdate, canEdit, allAgents, role }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean; allAgents: Agent[]; role: string | null }) {
  const [form, setForm] = useState({
    name:               agent.name,
    description:        agent.description ?? '',
    persona:            agent.persona ?? '',
    model:              agent.model,
    slackBotToken:      agent.slackBotToken,
    slackAppToken:      agent.slackAppToken,
    slackSigningSecret: agent.slackSigningSecret,
    isBoss:             agent.isBoss,
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
          body: JSON.stringify(form),
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
            hint="claude-opus-4-6 · claude-sonnet-4-6 · claude-haiku-4-5-20251001" readOnly={!canEdit} />
        </Grid2>
        <Field label="Description" value={form.description}
          onChange={v => setForm(f => ({ ...f, description: v }))}
          hint="Short summary — used by boss agents for delegation." readOnly={!canEdit} />
        <TextArea label="Persona" value={form.persona}
          onChange={v => setForm(f => ({ ...f, persona: v }))}
          hint="Who is this agent? This becomes the identity shown in Instructions → Skills." rows={4} readOnly={!canEdit} />
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
        <Field label="Bot Token" value={form.slackBotToken}
          onChange={v => setForm(f => ({ ...f, slackBotToken: v }))} type="password" readOnly={!canEdit}
          hint={<>api.slack.com/apps → your app → <strong>OAuth &amp; Permissions</strong> → Bot User OAuth Token</>} />
        <Field label="App-Level Token" value={form.slackAppToken}
          onChange={v => setForm(f => ({ ...f, slackAppToken: v }))} type="password" readOnly={!canEdit}
          hint={<>Basic Information → <strong>App-Level Tokens</strong> → Generate with scope <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>connections:write</code></>} />
        <Field label="Signing Secret" value={form.slackSigningSecret}
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

function InstructionsTab({ agent, canEdit }: { agent: Agent; canEdit: boolean }) {
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState<any>(null);
  const [optimizeError, setOptimizeError] = useState('');

  const runOptimize = async () => {
    setOptimizing(true);
    setOptimizeResult(null);
    setOptimizeError('');
    try {
      const r = await fetch(`/api/agents/${agent.id}/optimize`, { method: 'POST' });
      if (!r.ok) {
        const err = await r.json();
        setOptimizeError(err.error || 'Failed to start optimization');
        setOptimizing(false);
        return;
      }
      const { requestId } = await r.json();

      // Poll for result
      for (let i = 0; i < 60; i++) {
        await new Promise(res => setTimeout(res, 2000));
        const poll = await fetch(`/api/agents/${agent.id}/optimize?requestId=${requestId}`);
        const data = await poll.json();
        if (data.status === 'done') {
          setOptimizeResult(data);
          setOptimizing(false);
          return;
        }
        if (data.status === 'error') {
          setOptimizeError(data.error || 'Optimization failed');
          setOptimizing(false);
          return;
        }
      }
      setOptimizeError('Optimization timed out. Try again.');
    } catch (err) {
      setOptimizeError((err as Error).message);
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <div className="fade-up">
      {/* ── Optimize error ───────────────────────────────────────────── */}
      {optimizeError && (
        <div style={{
          background: 'var(--red-soft-bg)', border: '1px solid var(--red-soft-border)',
          borderRadius: 8, padding: '10px 14px', marginBottom: 16,
          fontSize: 12.5, color: 'var(--red)',
        }}>
          {optimizeError}
        </div>
      )}

      {/* ── Optimize results ─────────────────────────────────────────── */}
      {optimizeResult && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '18px 20px', marginBottom: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Wand2 size={15} style={{ color: 'var(--muted)' }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Optimization Suggestions</span>
            </div>
            <div style={{
              fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 12,
              background: optimizeResult.score >= 70 ? 'rgba(16,185,129,0.1)' : optimizeResult.score >= 40 ? 'var(--amber-soft-bg)' : 'var(--red-soft-bg)',
              color: optimizeResult.score >= 70 ? 'var(--green)' : optimizeResult.score >= 40 ? 'var(--amber)' : 'var(--red)',
            }}>
              Score: {optimizeResult.score}/100
            </div>
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>{optimizeResult.summary}</p>

          {/* System prompt suggestion */}
          {optimizeResult.systemPrompt?.suggestion && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>System Prompt</div>
              {optimizeResult.systemPrompt.issues?.length > 0 && (
                <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12, color: 'var(--amber)' }}>
                  {optimizeResult.systemPrompt.issues.map((issue: string, i: number) => <li key={i}>{issue}</li>)}
                </ul>
              )}
              <pre style={{
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '10px 12px', fontSize: 11.5, color: 'var(--text)',
                whiteSpace: 'pre-wrap', lineHeight: 1.5, maxHeight: 200, overflow: 'auto',
                fontFamily: 'var(--font-mono)',
              }}>{optimizeResult.systemPrompt.suggestion}</pre>
              <p style={{ fontSize: 11, color: 'var(--subtle)', margin: '4px 0 6px' }}>{optimizeResult.systemPrompt.explanation}</p>
              <button onClick={async () => {
                await fetch(`/api/agents/${agent.id}/claude-md`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: optimizeResult.systemPrompt.suggestion });
                setOptimizeResult((prev: any) => ({ ...prev, systemPrompt: { ...prev.systemPrompt, applied: true } }));
              }} disabled={optimizeResult.systemPrompt.applied} style={{
                fontSize: 11.5, fontWeight: 500, padding: '5px 12px', borderRadius: 6,
                background: optimizeResult.systemPrompt.applied ? 'var(--green)' : 'var(--accent)',
                color: optimizeResult.systemPrompt.applied ? '#fff' : 'var(--accent-fg)', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}>{optimizeResult.systemPrompt.applied ? 'Applied' : 'Apply System Prompt'}</button>
            </div>
          )}

          {/* Skill suggestions */}
          {optimizeResult.skills?.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Skills</div>
              {optimizeResult.skills.map((s: any, i: number) => (
                <div key={i} style={{
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '10px 12px', marginBottom: 8,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 3,
                      background: s.action === 'create' ? 'rgba(16,185,129,0.1)' : s.action === 'delete' ? 'var(--red-soft-bg)' : 'var(--amber-soft-bg)',
                      color: s.action === 'create' ? 'var(--green)' : s.action === 'delete' ? 'var(--red)' : 'var(--amber)',
                    }}>{s.action.toUpperCase()}</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{s.category}/{s.filename}</span>
                  </div>
                  <p style={{ fontSize: 11.5, color: 'var(--subtle)', margin: '2px 0 6px' }}>{s.explanation}</p>
                  {s.suggestion && s.action !== 'delete' && s.filename !== 'identity.md' && (
                    <button onClick={async () => {
                      await fetch(`/api/agents/${agent.id}/skills`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ category: s.category, filename: s.filename, content: s.suggestion }),
                      });
                      setOptimizeResult((prev: any) => ({
                        ...prev,
                        skills: prev.skills.map((sk: any) => sk.filename === s.filename ? { ...sk, applied: true } : sk),
                      }));
                    }} disabled={s.applied} style={{
                      fontSize: 11, fontWeight: 500, padding: '4px 10px', borderRadius: 5,
                      background: s.applied ? 'var(--green)' : 'var(--surface)',
                      border: `1px solid ${s.applied ? 'var(--green)' : 'var(--border)'}`, cursor: 'pointer',
                      fontFamily: 'var(--font-sans)', color: s.applied ? '#fff' : 'var(--text)',
                    }}>{s.applied ? 'Applied' : 'Apply'}</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Tips */}
          {optimizeResult.tips?.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Tips</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
                {optimizeResult.tips.map((tip: string, i: number) => <li key={i}>{tip}</li>)}
              </ul>
            </div>
          )}

          <button onClick={() => setOptimizeResult(null)} style={{
            marginTop: 12, fontSize: 11, color: 'var(--subtle)', background: 'none', border: 'none',
            cursor: 'pointer', fontFamily: 'var(--font-sans)',
          }}>Dismiss</button>
        </div>
      )}

      {/* ── System Prompt ───────────────────────────────────────────────── */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            System Prompt
          </div>
          {canEdit && !agent.isBoss && (
            <button onClick={runOptimize} disabled={optimizing} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: optimizing ? 'var(--surface-2)' : 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 7,
              padding: '5px 12px', fontSize: 12, fontWeight: 500,
              cursor: optimizing ? 'wait' : 'pointer', fontFamily: 'var(--font-sans)',
              color: optimizing ? 'var(--muted)' : 'var(--text)',
            }}>
              {optimizing ? (
                <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Analyzing...</>
              ) : (
                <><Wand2 size={13} /> Optimize</>
              )}
            </button>
          )}
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
      <InstructionsSubTabs agentId={agent.id} canEdit={canEdit} />
    </div>
  );
}

function InstructionsSubTabs({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
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
          <SkillsTab agentId={agentId} canEdit={canEdit} />
        </div>
      )}
      {subTab === 'memory' && (
        <div>
          <p style={{ fontSize: 12, color: 'var(--subtle)', margin: '0 0 10px' }}>
            Learned from conversations — the agent asks before saving. Use Analyze to suggest improvements.
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

  useEffect(() => {
    setLoading(true);
    fetch(`/api/agents/${agentId}/claude-md`)
      .then(r => r.text())
      .then(t => { setContent(t); setDirty(false); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentId]);

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

function SkillsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
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

  const grouped = skills.reduce<Record<string, Skill[]>>((acc, s) => {
    (acc[s.category] ??= []).push(s); return acc;
  }, {});

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
                  {s.filename === 'identity.md' && <span style={{ fontSize: 9, color: 'var(--subtle)', flexShrink: 0 }}>locked</span>}
                  {canEdit && s.filename !== 'identity.md' && <button
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
        {selected ? (() => {
          const isIdentity = selected.filename === 'identity.md';
          return <>
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
              value={content}
              onChange={e => setContent(e.target.value)}
              readOnly={!canEdit || isIdentity}
              style={{
                flex: 1, border: 'none', outline: 'none', resize: 'none',
                background: 'transparent', color: 'var(--text)',
                fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.65,
                padding: '16px', caretColor: 'var(--accent)',
              }}
              spellCheck={false}
            />
          </>;
        })() : (
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
            onChange={v => setNewSkill(s => ({ ...s, filename: v }))} hint="e.g. identity.md" />
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

function ToolsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  return (
    <div className="fade-up">
      {/* Section 1: Connected Apps (MCPs) */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 14 }}>
          Connected Apps
        </div>
        <McpsSection agentId={agentId} canEdit={canEdit} />
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

function McpsSection({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
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
        ) : all.map((mcp, i) => (
          <label
            key={mcp.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '13px 16px', cursor: mcp.enabled ? 'pointer' : 'not-allowed',
              borderBottom: i < all.length - 1 ? '1px solid var(--border)' : 'none',
              background: 'transparent', transition: 'background 0.12s',
              opacity: mcp.enabled ? 1 : 0.45,
            }}
            onMouseEnter={e => { if (mcp.enabled) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <input
              type="checkbox"
              checked={assigned.has(mcp.id)}
              onChange={() => toggle(mcp.id)}
              disabled={!mcp.enabled || !canEdit}
              style={{ accentColor: 'var(--accent)', width: 14, height: 14, flexShrink: 0 }}
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
            </div>
          </label>
        ))}
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
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState<any>(null);
  const [analyzeError, setAnalyzeError] = useState('');

  const load = () => fetch(`/api/agents/${agentId}/memories`).then(r => r.json()).then(setMemories);
  useEffect(() => { load(); }, [agentId]);

  const runAnalyze = async () => {
    setAnalyzing(true); setAnalyzeResult(null); setAnalyzeError('');
    try {
      const r = await fetch(`/api/agents/${agentId}/analyze-memories`, { method: 'POST' });
      const { requestId } = await r.json();
      for (let i = 0; i < 60; i++) {
        await new Promise(res => setTimeout(res, 2000));
        const poll = await fetch(`/api/agents/${agentId}/analyze-memories?requestId=${requestId}`);
        const data = await poll.json();
        if (data.status === 'done') { setAnalyzeResult(data); setAnalyzing(false); return; }
        if (data.status === 'error') { setAnalyzeError(data.error); setAnalyzing(false); return; }
      }
      setAnalyzeError('Analysis timed out.');
    } catch (err) { setAnalyzeError((err as Error).message); }
    finally { setAnalyzing(false); }
  };

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

  const ACTION_LABELS: Record<string, { label: string; color: string; bg: string }> = {
    move_to_skill: { label: 'Move to Skill', color: 'var(--blue)', bg: 'rgba(59,130,246,0.1)' },
    update_prompt: { label: 'Update Prompt', color: 'var(--green)', bg: 'rgba(16,185,129,0.1)' },
    merge: { label: 'Merge', color: 'var(--amber)', bg: 'var(--amber-soft-bg)' },
    delete: { label: 'Delete', color: 'var(--red)', bg: 'var(--red-soft-bg)' },
  };

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '16px 18px',
    }}>
      {/* Header with Analyze */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {memories.length} memor{memories.length === 1 ? 'y' : 'ies'}
        </span>
        {canEdit && memories.length > 0 && (
          <button onClick={runAnalyze} disabled={analyzing} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            background: analyzing ? 'var(--surface-2)' : 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: 7,
            padding: '5px 12px', fontSize: 12, fontWeight: 500,
            cursor: analyzing ? 'wait' : 'pointer', fontFamily: 'var(--font-sans)',
            color: analyzing ? 'var(--muted)' : 'var(--text)',
          }}>
            {analyzing ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Analyzing...</> : <><Wand2 size={13} /> Analyze</>}
          </button>
        )}
      </div>

      {/* Analyze error */}
      {analyzeError && (
        <div style={{ background: 'var(--red-soft-bg)', border: '1px solid var(--red-soft-border)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, color: 'var(--red)' }}>
          {analyzeError}
        </div>
      )}

      {/* Analyze results */}
      {analyzeResult?.suggestions?.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Wand2 size={14} style={{ color: 'var(--muted)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Suggestions</span>
          </div>
          {analyzeResult.summary && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>{analyzeResult.summary}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {analyzeResult.suggestions.map((s: any, i: number) => {
              const style = ACTION_LABELS[s.action] ?? ACTION_LABELS.delete;
              return (
                <div key={i} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 3, background: style.bg, color: style.color }}>{style.label}</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{s.memoryName}</span>
                  </div>
                  <p style={{ fontSize: 11.5, color: 'var(--subtle)', margin: '2px 0 6px' }}>{s.reason}</p>
                  {s.action === 'move_to_skill' && s.content && (
                    <button onClick={async () => {
                      await fetch(`/api/agents/${agentId}/skills`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: '01-knowledge', filename: `${s.memoryName.replace(/[^a-z0-9_-]/gi, '_')}.md`, content: s.content }) });
                      setAnalyzeResult((prev: any) => ({ ...prev, suggestions: prev.suggestions.map((x: any, j: number) => j === i ? { ...x, applied: true } : x) }));
                    }} disabled={s.applied} style={{ fontSize: 11, fontWeight: 500, padding: '4px 10px', borderRadius: 5, background: s.applied ? 'var(--green)' : 'var(--surface)', border: `1px solid ${s.applied ? 'var(--green)' : 'var(--border)'}`, cursor: 'pointer', fontFamily: 'var(--font-sans)', color: s.applied ? '#fff' : 'var(--text)' }}>{s.applied ? 'Applied' : 'Create Skill'}</button>
                  )}
                  {s.action === 'update_prompt' && s.content && (
                    <button onClick={async () => {
                      const current = await fetch(`/api/agents/${agentId}/claude-md`).then(r => r.text());
                      await fetch(`/api/agents/${agentId}/claude-md`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: current + '\n\n' + s.content });
                      setAnalyzeResult((prev: any) => ({ ...prev, suggestions: prev.suggestions.map((x: any, j: number) => j === i ? { ...x, applied: true } : x) }));
                    }} disabled={s.applied} style={{ fontSize: 11, fontWeight: 500, padding: '4px 10px', borderRadius: 5, background: s.applied ? 'var(--green)' : 'var(--surface)', border: `1px solid ${s.applied ? 'var(--green)' : 'var(--border)'}`, cursor: 'pointer', fontFamily: 'var(--font-sans)', color: s.applied ? '#fff' : 'var(--text)' }}>{s.applied ? 'Applied' : 'Add to Prompt'}</button>
                  )}
                  {s.action === 'delete' && (
                    <button onClick={async () => {
                      const mem = memories.find(m => m.name === s.memoryName);
                      if (mem) { await fetch(`/api/agents/${agentId}/memories/${mem.id}`, { method: 'DELETE' }); load(); }
                      setAnalyzeResult((prev: any) => ({ ...prev, suggestions: prev.suggestions.map((x: any, j: number) => j === i ? { ...x, applied: true } : x) }));
                    }} disabled={s.applied} style={{ fontSize: 11, fontWeight: 500, padding: '4px 10px', borderRadius: 5, background: s.applied ? 'var(--red)' : 'var(--surface)', border: `1px solid ${s.applied ? 'var(--red)' : 'var(--border)'}`, cursor: 'pointer', fontFamily: 'var(--font-sans)', color: s.applied ? '#fff' : 'var(--red)' }}>{s.applied ? 'Deleted' : 'Delete Memory'}</button>
                  )}
                </div>
              );
            })}
          </div>
          <button onClick={() => setAnalyzeResult(null)} style={{ marginTop: 10, fontSize: 11, color: 'var(--subtle)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>Dismiss</button>
        </div>
      )}
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

// ─── Knowledge ──────────────────────────────────────────────────────────────

function KnowledgeTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [sources, setSources] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState<'url' | 'file' | 'repo'>('url');
  const [addName, setAddName] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addBranch, setAddBranch] = useState('main');
  const [addPat, setAddPat] = useState('');
  const [addContent, setAddContent] = useState('');
  const [addSync, setAddSync] = useState('daily');
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<any>(null);
  const [buildError, setBuildError] = useState('');
  const [wikiArticles, setWikiArticles] = useState<string[]>([]);

  const load = () => {
    fetch(`/api/agents/${agentId}/knowledge`).then(r => r.json()).then(setSources).catch(() => {});
    // Load wiki article list from a known endpoint or just count
  };
  useEffect(() => { load(); }, [agentId]);

  const addSource = async () => {
    setSaving(true);
    const body: any = { type: addType, name: addName };
    if (addType === 'url') body.url = addUrl;
    if (addType === 'file') body.content = addContent;
    if (addType === 'repo') {
      body.repoUrl = addUrl;
      body.branch = addBranch;
      if (addPat) body.patEnvRef = addPat;
      body.syncCron = addSync === 'daily' ? '0 0 * * *' : '0 0 * * 0';
    }
    await fetch(`/api/agents/${agentId}/knowledge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    setSaving(false);
    setShowAdd(false);
    setAddName(''); setAddUrl(''); setAddContent(''); setAddBranch('main'); setAddPat('');
    load();
  };

  const deleteSource = async (id: string) => {
    await fetch(`/api/agents/${agentId}/knowledge/${id}`, { method: 'DELETE' });
    load();
  };

  const buildWiki = async () => {
    setBuilding(true); setBuildResult(null); setBuildError('');
    try {
      const r = await fetch(`/api/agents/${agentId}/knowledge/build`, { method: 'POST' });
      const { requestId } = await r.json();
      for (let i = 0; i < 120; i++) {
        await new Promise(res => setTimeout(res, 3000));
        const poll = await fetch(`/api/agents/${agentId}/knowledge/build?requestId=${requestId}`);
        const data = await poll.json();
        if (data.status === 'done') { setBuildResult(data); setBuilding(false); load(); return; }
        if (data.status === 'error') { setBuildError(data.error); setBuilding(false); return; }
      }
      setBuildError('Build timed out.');
    } catch (err) { setBuildError((err as Error).message); }
    finally { setBuilding(false); }
  };

  const TYPE_ICON: Record<string, string> = { url: '🔗', file: '📄', repo: '📦' };

  return (
    <div className="fade-up">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            Add documents, URLs, or repos — Claude compiles them into a wiki your agent references.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
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
            <button onClick={() => setShowAdd(true)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: 'var(--accent)', color: 'var(--accent-fg)',
              border: 'none', borderRadius: 7, padding: '6px 14px',
              fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>+ Add Source</button>
          )}
        </div>
      </div>

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

      {/* Add source form */}
      {showAdd && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {(['url', 'file', 'repo'] as const).map(t => (
              <button key={t} onClick={() => setAddType(t)} style={{
                padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                background: addType === t ? 'var(--accent)' : 'var(--surface-2)',
                color: addType === t ? 'var(--accent-fg)' : 'var(--muted)',
                border: `1px solid ${addType === t ? 'var(--accent)' : 'var(--border)'}`,
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}>{TYPE_ICON[t]} {t === 'url' ? 'URL' : t === 'file' ? 'File' : 'Git Repo'}</button>
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
              <textarea value={addContent} onChange={e => setAddContent(e.target.value)} placeholder="Paste document content here..."
                rows={6} style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
            )}

            {addType === 'repo' && (
              <>
                <input value={addUrl} onChange={e => setAddUrl(e.target.value)} placeholder="https://github.com/org/repo"
                  style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)' }} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={addBranch} onChange={e => setAddBranch(e.target.value)} placeholder="Branch (default: main)"
                    style={{ flex: 1, padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)' }} />
                  <select value={addSync} onChange={e => setAddSync(e.target.value)}
                    style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12, fontFamily: 'var(--font-sans)', color: 'var(--text)' }}>
                    <option value="daily">Sync daily</option>
                    <option value="weekly">Sync weekly</option>
                  </select>
                </div>
                <input value={addPat} onChange={e => setAddPat(e.target.value)} placeholder="PAT env var key (optional, for private repos)"
                  style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)' }} />
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={addSource} disabled={saving || !addName} style={{
              background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 7,
              padding: '7px 16px', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>{saving ? 'Adding...' : 'Add Source'}</button>
            <button onClick={() => setShowAdd(false)} style={{
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
            <div key={src.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
              borderBottom: i < sources.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>{TYPE_ICON[src.type] ?? '📄'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{src.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {src.type} · {src.url || src.repoUrl || `${src.wordCount} words`}
                  {src.branch && src.type === 'repo' && ` · ${src.branch}`}
                </div>
              </div>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
                background: src.status === 'compiled' ? 'rgba(16,185,129,0.1)' : src.status === 'error' ? 'var(--red-soft-bg)' : 'var(--surface-2)',
                color: src.status === 'compiled' ? 'var(--green)' : src.status === 'error' ? 'var(--red)' : 'var(--subtle)',
              }}>{src.status}</span>
              {canEdit && (
                <button onClick={() => deleteSource(src.id)} style={{
                  background: 'none', border: 'none', color: 'var(--red)', fontSize: 12,
                  cursor: 'pointer', opacity: 0.6, fontFamily: 'var(--font-sans)',
                }}>Delete</button>
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

// ─── History ──────────────────────────────────────────────────────────────────

// ── Diff panel ───────────────────────────────────────────────────────────────

function SkillDiff({ snapshot, current }: { snapshot: AgentSnapshot; current: AgentSnapshot | null }) {
  const snapSkills = snapshot.skillsJson;
  const currSkills = current ? current.skillsJson : null;

  // Build lookup maps
  const snapMap = new Map(snapSkills.map(s => [`${s.category}/${s.filename}`, s.content]));
  const currMap = currSkills ? new Map(currSkills.map(s => [`${s.category}/${s.filename}`, s.content])) : new Map<string, string>();

  const allKeys = new Set([...snapMap.keys(), ...currMap.keys()]);
  const files: { key: string; status: 'added' | 'removed' | 'modified' | 'same'; diff?: DiffLine[] }[] = [];

  for (const key of allKeys) {
    const snapContent = snapMap.get(key);
    const currContent = currMap.get(key);
    if (snapContent === undefined) {
      files.push({ key, status: 'added' });
    } else if (currContent === undefined) {
      files.push({ key, status: 'removed' });
    } else if (snapContent !== currContent) {
      files.push({ key, status: 'modified', diff: lineDiff(snapContent, currContent) });
    }
  }

  if (files.length === 0) {
    return <p style={{ fontSize: 13, color: 'var(--subtle)', margin: 0 }}>No skill changes.</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {files.map(f => (
        <div key={f.key} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{
            padding: '7px 12px', background: 'var(--surface-2)',
            borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{f.key}</span>
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4, fontWeight: 600,
              background: f.status === 'added' ? 'rgba(22,163,74,0.15)' : f.status === 'removed' ? 'rgba(239,68,68,0.15)' : 'rgba(234,179,8,0.15)',
              color: f.status === 'added' ? '#16a34a' : f.status === 'removed' ? '#ef4444' : '#ca8a04',
            }}>{f.status}</span>
          </div>
          {f.diff && (
            <pre style={{
              margin: 0, padding: '10px 0', fontSize: 11.5, fontFamily: 'var(--font-mono)',
              lineHeight: 1.6, overflow: 'auto', maxHeight: 320,
            }}>
              {f.diff.map((line, i) => (
                <div key={i} style={{
                  padding: '0 12px',
                  background: line.type === 'add' ? 'rgba(22,163,74,0.1)' : line.type === 'remove' ? 'rgba(239,68,68,0.1)' : 'transparent',
                  color: line.type === 'add' ? '#16a34a' : line.type === 'remove' ? '#ef4444' : 'var(--muted)',
                }}>
                  {line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  '}{line.line}
                </div>
              ))}
            </pre>
          )}
          {f.status === 'added' && <p style={{ margin: '8px 12px', fontSize: 12, color: '#16a34a' }}>File added since this snapshot.</p>}
          {f.status === 'removed' && <p style={{ margin: '8px 12px', fontSize: 12, color: '#ef4444' }}>File deleted since this snapshot.</p>}
        </div>
      ))}
    </div>
  );
}

function PermsDiff({ snapshot, current }: { snapshot: AgentSnapshot; current: AgentSnapshot | null }) {
  const currAllowed = new Set(current ? current.allowedTools : []);
  const currDenied  = new Set(current ? current.deniedTools  : []);
  const snapAllowed = new Set(snapshot.allowedTools);
  const snapDenied  = new Set(snapshot.deniedTools);

  const addedAllowed   = [...currAllowed].filter(t => !snapAllowed.has(t));
  const removedAllowed = [...snapAllowed].filter(t => !currAllowed.has(t));
  const addedDenied    = [...currDenied].filter(t => !snapDenied.has(t));
  const removedDenied  = [...snapDenied].filter(t => !currDenied.has(t));

  if (!addedAllowed.length && !removedAllowed.length && !addedDenied.length && !removedDenied.length) {
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
      {row('Allowed tools added', addedAllowed, '#16a34a')}
      {row('Allowed tools removed', removedAllowed, '#ef4444')}
      {row('Denied tools added', addedDenied, '#ef4444')}
      {row('Denied tools removed', removedDenied, '#16a34a')}
    </div>
  );
}

function McpsDiff({ snapshot, current, allMcps }: { snapshot: AgentSnapshot; current: AgentSnapshot | null; allMcps: McpServer[] }) {
  const nameFor = (id: string) => allMcps.find(m => m.id === id)?.name ?? id;
  const currIds = new Set(current ? current.mcpIds : []);
  const snapIds = new Set(snapshot.mcpIds);
  const added   = [...currIds].filter(id => !snapIds.has(id));
  const removed = [...snapIds].filter(id => !currIds.has(id));
  if (!added.length && !removed.length) return <p style={{ fontSize: 13, color: 'var(--subtle)', margin: 0 }}>No MCP changes.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {added.length > 0 && <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#16a34a', marginBottom: 4 }}>Added</div>
        {added.map(id => <div key={id} style={{ fontSize: 12.5, color: '#16a34a' }}>+ {nameFor(id)}</div>)}
      </div>}
      {removed.length > 0 && <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#ef4444', marginBottom: 4 }}>Removed</div>
        {removed.map(id => <div key={id} style={{ fontSize: 12.5, color: '#ef4444' }}>- {nameFor(id)}</div>)}
      </div>}
    </div>
  );
}

function ChannelsDiff({ snapshot, current }: { snapshot: AgentSnapshot; current: AgentSnapshot | null }) {
  const currChannels = new Set(current?.allowedChannels ?? []);
  const snapChannels = new Set(snapshot.allowedChannels ?? []);
  const added   = [...currChannels].filter(ch => !snapChannels.has(ch));
  const removed = [...snapChannels].filter(ch => !currChannels.has(ch));
  if (!added.length && !removed.length) return <p style={{ fontSize: 13, color: 'var(--subtle)', margin: 0 }}>No channel restriction changes.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {added.length > 0 && <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#16a34a', marginBottom: 4 }}>Channels added</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {added.map(ch => (
            <span key={ch} style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', padding: '2px 8px', borderRadius: 4, background: '#16a34a22', color: '#16a34a' }}>{ch}</span>
          ))}
        </div>
      </div>}
      {removed.length > 0 && <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#ef4444', marginBottom: 4 }}>Channels removed</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {removed.map(ch => (
            <span key={ch} style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', padding: '2px 8px', borderRadius: 4, background: '#ef444422', color: '#ef4444' }}>{ch}</span>
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
  const [compareId, setCompareId] = useState<string>('__current__');
  const [compareSnapshot, setCompareSnapshot] = useState<AgentSnapshot | null>(null);
  // Live current state — fetched once and used as the "Current state" comparison target
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

  // Lazy-load live state only when user picks "Compare with current"
  useEffect(() => {
    if (compareId !== '__current__' || liveSnapshot) return;
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
  }, [agentId, compareId, liveSnapshot]);

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

  // Load compare snapshot when compareId changes
  useEffect(() => {
    if (compareId === '__current__') { setCompareSnapshot(null); return; }
    fetch(`/api/agents/${agentId}/snapshots/${compareId}`)
      .then(r => r.json())
      .then(setCompareSnapshot);
  }, [agentId, compareId]);

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

  // Build comparison target: live state or a selected historical snapshot
  const currentAsSnapshot: AgentSnapshot | null = compareId === '__current__' ? liveSnapshot : compareSnapshot;

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
                  onClick={() => { setSelectedId(isSelected ? null : snap.id); setCompareId('__current__'); setCompareSnapshot(null); }}
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

                  {/* Actions — only when selected */}
                  {isSelected && canEdit && (
                    <div style={{ display: 'flex', gap: 7, marginTop: 11, paddingTop: 11, borderTop: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => handleRestore(snap)}
                        disabled={restoring}
                        style={{
                          flex: 1, fontSize: 12, padding: '6px 0', borderRadius: 6, cursor: restoring ? 'not-allowed' : 'pointer',
                          background: 'var(--green)', color: 'var(--accent-fg)', border: 'none',
                          fontFamily: 'var(--font-sans)', fontWeight: 600, transition: 'opacity 0.15s',
                        }}
                        onMouseEnter={e => { if (!restoring) (e.currentTarget.style.opacity = '0.85'); }}
                        onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                      >{restoring ? 'Restoring…' : 'Restore'}</button>
                      <button
                        onClick={() => handleDelete(snap.id)}
                        style={{
                          fontSize: 12, padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
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

          {/* Compare bar */}
          <div style={{
            background: 'var(--surface)', borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-card)', padding: '14px 18px',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
              Compare with
            </span>
            <select
              value={compareId}
              onChange={e => setCompareId(e.target.value)}
              style={{
                flex: 1, fontSize: 13, padding: '7px 12px', borderRadius: 8,
                border: '1.5px solid var(--border)', background: 'var(--surface-2)',
                color: 'var(--text)', fontFamily: 'var(--font-sans)', outline: 'none', cursor: 'pointer',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            >
              <option value="__current__">Current state</option>
              {snapshots.filter(s => s.id !== selectedId).map(s => (
                <option key={s.id} value={s.id}>{fmt(s.createdAt)} — {s.trigger}{s.label ? ` · ${s.label}` : ''}</option>
              ))}
            </select>
          </div>

          {/* Diff sections — wait for compare target to load */}
          {!currentAsSnapshot ? (
            <div style={{
              background: 'var(--surface)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-card)',
              padding: '24px 18px', textAlign: 'center', color: 'var(--subtle)', fontSize: 13,
            }}>
              Loading comparison…
            </div>
          ) : [
            { title: 'Skills',       content: <SkillDiff snapshot={fullSnapshot} current={currentAsSnapshot} /> },
            { title: 'Tools',        content: <PermsDiff snapshot={fullSnapshot} current={currentAsSnapshot} /> },
            { title: 'MCPs',         content: <McpsDiff snapshot={fullSnapshot} current={currentAsSnapshot} allMcps={allMcps} /> },
            { title: 'Channels',     content: <ChannelsDiff snapshot={fullSnapshot} current={currentAsSnapshot} /> },
            { title: 'System Prompt', content: (() => {
                if (!fullSnapshot.compiledMd || !currentAsSnapshot.compiledMd)
                  return <p style={{ fontSize: 12.5, color: 'var(--subtle)', margin: 0 }}>Not available for this snapshot</p>;
                const diff = lineDiff(fullSnapshot.compiledMd.trim(), currentAsSnapshot.compiledMd.trim());
                const changed = diff.some(l => l.type !== 'same');
                if (!changed) return <p style={{ fontSize: 12.5, color: 'var(--subtle)', margin: 0 }}>No changes</p>;
                return (
                  <pre style={{
                    margin: 0, padding: '14px 16px', borderRadius: 8, fontSize: 12,
                    fontFamily: 'var(--font-mono)', background: 'var(--surface-2)',
                    border: '1px solid var(--border)', overflow: 'auto', maxHeight: 380,
                    color: 'var(--text)', lineHeight: 1.7,
                  }}>
                    {diff.map((l, i) => (
                      <div key={i} style={{
                        background: l.type === 'add' ? 'rgba(34,197,94,0.12)' : l.type === 'remove' ? 'rgba(239,68,68,0.10)' : 'transparent',
                        color: l.type === 'add' ? '#16a34a' : l.type === 'remove' ? '#dc2626' : 'inherit',
                        padding: '1px 6px', borderRadius: 3, marginBottom: 1,
                      }}>
                        {l.type === 'add' ? '+ ' : l.type === 'remove' ? '- ' : '  '}{l.line}
                      </div>
                    ))}
                  </pre>
                );
              })(),
            },
          ].map(({ title, content }) => (
            <div key={title} style={{
              background: 'var(--surface)', borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow-card)', overflow: 'hidden',
            }}>
              <div style={{
                padding: '12px 18px', borderBottom: '1px solid var(--border)',
                fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
                color: 'var(--muted)', textTransform: 'uppercase',
              }}>{title}</div>
              <div style={{ padding: '16px 18px' }}>{content}</div>
            </div>
          ))}
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
