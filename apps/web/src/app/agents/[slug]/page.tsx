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
import Link from 'next/link';
import type { Agent, Skill, McpServer, Memory, Permission } from '@slack-agent-team/shared';
import { useAuth } from '@/lib/auth-context';

type Tab = 'overview' | 'skills' | 'claude-md' | 'mcps' | 'permissions' | 'memory' | 'logs';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',     label: 'Overview'     },
  { id: 'skills',       label: 'Skills'       },
  { id: 'claude-md',    label: 'CLAUDE.md'    },
  { id: 'mcps',         label: 'MCPs'         },
  { id: 'permissions',  label: 'Permissions'  },
  { id: 'memory',       label: 'Memory'       },
  { id: 'logs',         label: 'Logs'         },
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
  const { canEdit } = useAuth();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');

  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then((agents: Agent[]) => setAgent(agents.find(a => a.slug === slug) ?? null))
      .finally(() => setLoading(false));
  }, [slug]);

  const triggerAction = async (action: 'start' | 'stop' | 'reload') => {
    if (!agent) return;
    setActionMsg(action === 'start' ? 'Starting…' : action === 'stop' ? 'Stopping…' : 'Reloading…');
    await fetch(`/api/agents/${agent.id}/${action}`, { method: 'POST' });
    const r = await fetch(`/api/agents/${agent.id}`);
    setAgent(await r.json());
    setActionMsg('Done');
    setTimeout(() => setActionMsg(''), 2000);
  };

  if (loading) return <PageLoader />;
  if (!agent)  return <NotFound slug={slug} />;

  const statusColor = STATUS_COLOR[agent.status] ?? 'var(--border-2)';

  return (
    <div style={{ minHeight: '100vh' }} className="fade-up">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '20px 36px 0',
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
              fontSize: 14, fontWeight: 700, color: '#fff',
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
        {tab === 'overview'    && <OverviewTab    agent={agent} onUpdate={setAgent} canEdit={canEdit} />}
        {tab === 'skills'      && <SkillsTab      agentId={agent.id} canEdit={canEdit} />}
        {tab === 'claude-md'   && <ClaudeMdTab    agentId={agent.id} canEdit={canEdit} />}
        {tab === 'mcps'        && <McpsTab        agentId={agent.id} canEdit={canEdit} />}
        {tab === 'permissions' && <PermissionsTab agentId={agent.id} canEdit={canEdit} />}
        {tab === 'memory'      && <MemoryTab      agentId={agent.id} canEdit={canEdit} />}
        {tab === 'logs'        && <LogsTab        agentId={agent.id} slug={agent.slug} />}
      </div>
    </div>
  );
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({ agent, onUpdate, canEdit }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean }) {
  const [form, setForm] = useState({
    name:               agent.name,
    description:        agent.description ?? '',
    persona:            agent.persona ?? '',
    model:              agent.model,
    slackBotToken:      agent.slackBotToken,
    slackAppToken:      agent.slackAppToken,
    slackSigningSecret: agent.slackSigningSecret,
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState('');
  const [manifest, setManifest]       = useState('');
  const [showManifest, setShowManifest] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/agents/${agent.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
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
    <div style={{ maxWidth: 640 }} className="fade-up">
      <Section title="Identity">
        <Grid2>
          <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} readOnly={!canEdit} />
          <Field label="Model" value={form.model} onChange={v => setForm(f => ({ ...f, model: v }))}
            hint="claude-opus-4-6 · claude-sonnet-4-6 · claude-haiku-4-5-20251001" readOnly={!canEdit} />
        </Grid2>
        <Field label="Description" value={form.description}
          onChange={v => setForm(f => ({ ...f, description: v }))}
          hint="Shown to the boss agent for delegation decisions." readOnly={!canEdit} />
        <TextArea label="Persona" value={form.persona}
          onChange={v => setForm(f => ({ ...f, persona: v }))}
          hint="Injected into CLAUDE.md — who is this agent?" rows={4} readOnly={!canEdit} />
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
        {agent.slackBotUserId && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#f0fdf4', border: '1px solid #bbf7d0',
            borderRadius: 7, padding: '8px 12px', fontSize: 12,
          }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a', flexShrink: 0 }} />
            <span style={{ color: '#15803d' }}>Connected ·</span>
            <span style={{ color: '#166534', fontFamily: 'var(--font-mono)' }}>Bot User ID: {agent.slackBotUserId}</span>
            <span style={{ color: '#86efac', marginLeft: 'auto', fontSize: 11 }}>auto-set by runner on connect</span>
          </div>
        )}
      </Section>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
    </div>
  );
}

// ─── CLAUDE.md viewer ─────────────────────────────────────────────────────────

function ClaudeMdTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [content, setContent] = useState<string>('');
  const [draft, setDraft] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => {
    setLoading(true);
    fetch(`/api/agents/${agentId}/claude-md`)
      .then(r => r.text())
      .then(t => { setContent(t); setDraft(t); })
      .catch(() => setContent('Failed to load CLAUDE.md'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [agentId]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/claude-md`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: draft,
      });
      if (!res.ok) throw new Error(await res.text());
      setContent(draft);
      setEditing(false);
      setMsg('Saved — agent will use this on next reload.');
      setTimeout(() => setMsg(''), 4000);
    } catch (e: any) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading...</p>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>CLAUDE.md</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            {editing ? 'Editing raw system prompt — this overrides all individual skills.' : 'Compiled system prompt sent to Claude.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!editing && (
            <span style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--surface-2)', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)' }}>
              {(content.length / 1024).toFixed(1)} KB · {content.split('\n').length} lines
            </span>
          )}
          {editing ? (
            <>
              <button onClick={() => { setEditing(false); setDraft(content); }} style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={save} disabled={saving} style={{ padding: '6px 16px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            canEdit && <button onClick={() => setEditing(true)} style={{ padding: '6px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, cursor: 'pointer' }}>
              Edit
            </button>
          )}
        </div>
      </div>

      {msg && <p style={{ fontSize: 13, color: msg.startsWith('Error') ? 'var(--danger)' : 'var(--success)', marginBottom: 12 }}>{msg}</p>}

      {editing ? (
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{
            width: '100%', height: '70vh', background: 'var(--surface)',
            border: '1px solid var(--accent)', borderRadius: 10,
            padding: '20px 24px', fontSize: 12.5, lineHeight: 1.7,
            color: 'var(--text)', fontFamily: 'var(--font-mono)',
            resize: 'vertical', outline: 'none', boxSizing: 'border-box',
          }}
        />
      ) : (
        <pre style={{
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '20px 24px', fontSize: 12.5, lineHeight: 1.7,
          overflowX: 'auto', overflowY: 'auto', maxHeight: '70vh', margin: 0,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          color: 'var(--text)', fontFamily: 'var(--font-mono)',
        }}>
          {content}
        </pre>
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
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                    fontSize: 12, fontFamily: 'var(--font-mono)',
                    background: selected?.id === s.id ? 'rgba(59,130,246,0.12)' : 'transparent',
                    color: selected?.id === s.id ? 'var(--accent)' : 'var(--muted)',
                    transition: 'background 0.12s, color 0.12s',
                  }}
                  onMouseEnter={e => { if (selected?.id !== s.id) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
                  onMouseLeave={e => { if (selected?.id !== s.id) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.filename}</span>
                  {canEdit && <button
                    onClick={e => { e.stopPropagation(); remove(s); }}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: '#ef4444', fontSize: 14, opacity: 0, transition: 'opacity 0.12s',
                      fontFamily: 'var(--font-sans)', lineHeight: 1, padding: '0 2px',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={e => (e.currentTarget.style.opacity = '0')}
                    className="delete-btn"
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
              <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                {selected.category}/{selected.filename}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {msg && <span style={{ fontSize: 11.5, color: '#16a34a' }}>{msg}</span>}
                {canEdit && <button
                  onClick={save} disabled={saving}
                  style={{
                    background: saving ? 'var(--border)' : 'var(--accent)',
                    color: '#fff', border: 'none', borderRadius: 6,
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
              readOnly={!canEdit}
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

function McpsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
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

const QUICK_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];

function PermissionsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [allowed, setAllowed] = useState('');
  const [denied,  setDenied]  = useState('');
  const [saving,  setSaving]  = useState(false);
  const [msg,     setMsg]     = useState('');

  useEffect(() => {
    fetch(`/api/agents/${agentId}/permissions`).then(r => r.json()).then((p: Permission) => {
      setAllowed((p.allowedTools ?? []).join('\n'));
      setDenied((p.deniedTools ?? []).join('\n'));
    });
  }, [agentId]);

  const addTool = (tool: string, list: 'allowed' | 'denied') => {
    const setter = list === 'allowed' ? setAllowed : setDenied;
    const current = (list === 'allowed' ? allowed : denied).split('\n').map(s => s.trim()).filter(Boolean);
    if (!current.includes(tool)) setter([...current, tool].join('\n'));
  };

  const save = async () => {
    setSaving(true);
    await fetch(`/api/agents/${agentId}/permissions`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedTools: allowed.split('\n').map(s => s.trim()).filter(Boolean),
        deniedTools:  denied.split('\n').map(s => s.trim()).filter(Boolean),
      }),
    });
    setSaving(false); setMsg('Saved & reload triggered');
    setTimeout(() => setMsg(''), 3000);
  };

  return (
    <div style={{ maxWidth: 660 }} className="fade-up">
      {/* Quick add */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, padding: '12px 16px', marginBottom: 18,
      }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Quick add built-in tools
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {QUICK_TOOLS.map(t => (
            <button
              key={t}
              onClick={() => addTool(t, 'allowed')}
              disabled={!canEdit}
              style={{
                background: 'var(--border)', border: '1px solid var(--border-2)',
                color: 'var(--text)', padding: '3px 10px', borderRadius: 5,
                fontSize: 11.5, fontFamily: 'var(--font-mono)', cursor: 'pointer',
                transition: 'background 0.12s, border-color 0.12s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--border-2)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--border)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; }}
            >{t}</button>
          ))}
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--subtle)' }}>
          MCP tools pattern: <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>mcp__serverName__toolName</code>
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 6 }}>
            Allowed Tools <span style={{ color: 'var(--subtle)', fontWeight: 400 }}>· one per line</span>
          </label>
          <textarea
            value={allowed} onChange={e => setAllowed(e.target.value)}
            rows={12} readOnly={!canEdit}
            style={{
              width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '10px 12px', color: 'var(--text)',
              fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7,
              outline: 'none', resize: 'vertical',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            placeholder={'Read\nWrite\nmcp__redshift-mcp__query'}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 6 }}>
            Denied Tools <span style={{ color: 'var(--subtle)', fontWeight: 400 }}>· overrides allowed</span>
          </label>
          <textarea
            value={denied} onChange={e => setDenied(e.target.value)}
            rows={12} readOnly={!canEdit}
            style={{
              width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '10px 12px', color: 'var(--danger)',
              fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7,
              outline: 'none', resize: 'vertical',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = '#ef4444')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            placeholder={'Bash'}
          />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {canEdit && <PrimaryBtn onClick={save} loading={saving}>Save Permissions</PrimaryBtn>}
        {msg && <span style={{ fontSize: 12, color: '#16a34a' }}>{msg}</span>}
      </div>
    </div>
  );
}

// ─── Memory ───────────────────────────────────────────────────────────────────

const MEM_TYPE_STYLE: Record<string, { bg: string; color: string }> = {
  user:      { bg: '#f3f0ff', color: '#7c3aed' },
  feedback:  { bg: '#eff6ff', color: '#2563eb' },
  project:   { bg: '#fffbeb', color: '#b45309' },
  reference: { bg: '#f0fdf4', color: '#15803d' },
};

function MemoryTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
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
      <div className="fade-up" style={{ textAlign: 'center', paddingTop: 80, color: 'var(--muted)' }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🧠</div>
        <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
          No memories yet
        </p>
        <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 300, margin: '0 auto' }}>
          The agent will automatically accumulate memories as it interacts in Slack.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }} className="fade-up">
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18 }}>
        {memories.length} memories across {Object.keys(grouped).length} categories
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
  // Strip ANSI color codes
  const stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
  try {
    const obj = JSON.parse(stripped);
    const level: LogLevel =
      obj.level === 'error' || obj.level === 50 ? 'error' :
      obj.level === 'warn'  || obj.level === 40 ? 'warn'  :
      obj.level === 'debug' || obj.level === 20 ? 'debug' : 'info';
    const ts = obj.timestamp ? new Date(obj.timestamp).toLocaleTimeString() : '';
    const msg = obj.message ?? obj.msg ?? '';
    const skip = new Set(['level', 'message', 'msg', 'timestamp', 'agent', 'service']);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!skip.has(k)) fields[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return { raw, level, time: ts, message: msg, fields };
  } catch {
    const level: LogLevel =
      stripped.includes('"level":"error"') || stripped.includes('"level":50') ? 'error' :
      stripped.includes('"level":"warn"')  || stripped.includes('"level":40') ? 'warn'  :
      stripped.includes('"level":"debug"') || stripped.includes('"level":20') ? 'debug' : 'info';
    return { raw: stripped, level, time: '', message: stripped, fields: {} };
  }
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  all:   'var(--text)',
  error: '#dc2626',
  warn:  '#b45309',
  info:  'var(--text)',
  debug: 'var(--muted)',
};

const LEVEL_BADGE: Record<LogLevel, string> = {
  all: 'var(--muted)', error: '#dc2626', warn: '#b45309', info: '#2563eb', debug: 'var(--subtle)',
};

function LogsTab({ agentId, slug }: { agentId: string; slug: string }) {
  const [lines, setLines]             = useState<ParsedLog[]>([]);
  const [connected, setConnected]     = useState(false);
  const [levelFilter, setLevelFilter] = useState<LogLevel>('all');
  const [search, setSearch]           = useState('');
  const [autoScroll, setAutoScroll]   = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
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

  const visibleLines = lines.filter(l => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return l.message.toLowerCase().includes(q) ||
        Object.values(l.fields).some(v => v.toLowerCase().includes(q));
    }
    return true;
  });

  const levelBtnStyle = (lvl: LogLevel) => ({
    padding: '2px 10px', borderRadius: 12, border: '1px solid var(--border)',
    fontSize: 11, fontFamily: 'var(--font-sans)', cursor: 'pointer',
    background: levelFilter === lvl ? 'var(--accent)' : 'var(--surface-2)',
    color: levelFilter === lvl ? '#fff' : lvl === 'info' || lvl === 'all' ? 'var(--muted)' : LEVEL_COLORS[lvl],
    fontWeight: levelFilter === lvl ? 600 : 400,
  });

  return (
    <div className="fade-up">
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div
            className={connected ? 'status-running' : ''}
            style={{ width: 7, height: 7, borderRadius: '50%', background: connected ? '#16a34a' : 'var(--border-2)' }}
          />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{connected ? 'Live' : 'Disconnected'}</span>
        </div>

        {/* Level filters */}
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => setLevelFilter('all')} style={levelBtnStyle('all')}>all</button>
          {LEVEL_ORDER.map(lvl => (
            <button key={lvl} onClick={() => setLevelFilter(lvl)} style={levelBtnStyle(lvl)}>{lvl}</button>
          ))}
        </div>

        {/* Search */}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search…"
          style={{
            padding: '2px 10px', borderRadius: 12, border: '1px solid var(--border)',
            fontSize: 11, fontFamily: 'var(--font-sans)', background: 'var(--surface-2)',
            color: 'var(--text)', outline: 'none', width: 160,
          }}
        />

        <button
          onClick={() => setLines([])}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-sans)' }}
        >Clear</button>
      </div>

      {/* Log pane */}
      <div
        ref={containerRef}
        onScroll={e => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollTop + el.clientHeight >= el.scrollHeight - 40);
        }}
        style={{
          background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '12px 16px', height: 500, overflow: 'auto',
          fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.7,
        }}
      >
        {visibleLines.length === 0
          ? <span style={{ color: 'var(--subtle)' }}>{lines.length === 0 ? 'Waiting for log lines…' : 'No matching lines.'}</span>
          : visibleLines.map((log, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 2, alignItems: 'baseline' }}>
              {/* Time */}
              {log.time && (
                <span style={{ color: 'var(--subtle)', flexShrink: 0, fontSize: 10.5 }}>{log.time}</span>
              )}
              {/* Level badge */}
              <span style={{
                flexShrink: 0, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em',
                textTransform: 'uppercase', color: LEVEL_BADGE[log.level],
                minWidth: 34,
              }}>{log.level}</span>
              {/* Message */}
              <span style={{ color: LEVEL_COLORS[log.level], flex: 1, wordBreak: 'break-word' }}>
                {log.message}
                {/* Inline fields */}
                {Object.entries(log.fields).map(([k, v]) => (
                  <span key={k}>
                    {' '}
                    <span style={{ color: 'var(--accent)' }}>{k}</span>
                    <span style={{ color: 'var(--subtle)' }}>=</span>
                    <span style={{ color: 'var(--muted)' }}>{v}</span>
                  </span>
                ))}
              </span>
            </div>
          ))
        }
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 22, paddingBottom: 22,
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em',
        textTransform: 'uppercase', marginBottom: 14 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
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
          width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 7, padding: '8px 11px', color: 'var(--text)',
          fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none',
          transition: 'border-color 0.15s',
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
      />
      {hint && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>{hint}</p>}
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
          width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 7, padding: '8px 11px', color: 'var(--text)',
          fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none', resize: 'vertical',
          transition: 'border-color 0.15s',
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
      />
      {hint && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>{hint}</p>}
    </div>
  );
}

function PrimaryBtn({ children, onClick, loading }: {
  children: React.ReactNode; onClick?: () => void; loading?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      background: loading ? 'var(--border)' : 'var(--accent)',
      color: '#fff', border: 'none', borderRadius: 7,
      padding: '8px 18px', fontSize: 13, fontWeight: 500,
      cursor: loading ? 'not-allowed' : 'pointer',
      fontFamily: 'var(--font-sans)', transition: 'opacity 0.15s',
    }}
      onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
    >{loading ? 'Saving…' : children}</button>
  );
}

function GhostBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} style={{
      background: 'transparent', color: 'var(--muted)',
      border: '1px solid var(--border)', borderRadius: 7,
      padding: '8px 18px', fontSize: 13, fontFamily: 'var(--font-sans)', cursor: 'pointer',
      transition: 'border-color 0.15s, color 0.15s',
    }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; }}
    >{children}</button>
  );
}

function Btn({ children, onClick, color, textColor }: {
  children: React.ReactNode; onClick?: () => void;
  color?: string; textColor?: string;
}) {
  return (
    <button onClick={onClick} style={{
      background: color ?? 'var(--border)', color: textColor ?? '#fff',
      border: 'none', borderRadius: 7, padding: '7px 16px',
      fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
      fontFamily: 'var(--font-sans)', transition: 'opacity 0.15s',
    }}
      onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
      onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
    >{children}</button>
  );
}

function Modal({ title, children, onClose }: {
  title: string; children: React.ReactNode; onClose: () => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        borderRadius: 14, padding: '24px', width: 420,
        boxShadow: '0 0 0 1px rgba(255,255,255,0.04)',
        display: 'flex', flexDirection: 'column', gap: 14,
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
