'use client';

/**
 * @fileoverview 5-step agent onboarding wizard.
 *
 * Steps: Name & Role → Slack App → Credentials → Tools → Review
 *
 * Route: /agents/new
 * @module web/app/agents/new
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { AlertTriangle, Eye, EyeOff, Search, X, Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { Agent, McpServer, PersonaTemplate, PersonaCategory } from '@slackhive/shared';
import { PERSONA_CATALOG, searchPersonas } from '@slackhive/shared';
import { generateSlackManifest } from '@/lib/slack-manifest';

// ─── State ────────────────────────────────────────────────────────────────────

interface AgentExportPayload {
  version: number;
  exportedAt?: string;
  claudeMd: string;
  skills: { category: string; filename: string; content: string; sortOrder: number }[];
}

interface WizardState {
  name: string; slug: string; description: string; persona: string;
  model: string; isBoss: boolean;
  reportsToIds: string[];
  slackBotToken: string; slackAppToken: string; slackSigningSecret: string;
  mcpServerIds: string[];
  selectedPersona: PersonaTemplate | null;
  importPayload: AgentExportPayload | null;
}

const INITIAL: WizardState = {
  name: '', slug: '', description: '', persona: '',
  model: 'claude-opus-4-6', isBoss: false,
  reportsToIds: [],
  slackBotToken: '', slackAppToken: '', slackSigningSecret: '',
  mcpServerIds: [], selectedPersona: null, importPayload: null,
};

const MODELS = [
  { value: 'claude-opus-4-6',           label: 'Opus 4.6',   sub: 'Most capable' },
  { value: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', sub: 'Balanced' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  sub: 'Fastest' },
];

const TEMPLATES = [
  { value: 'blank',        label: 'Blank',        desc: 'Minimal identity only' },
  { value: 'data-analyst', label: 'Data Analyst', desc: 'SQL, Redshift, metrics' },
  { value: 'writer',       label: 'Writer',       desc: 'Content & summaries' },
  { value: 'developer',    label: 'Developer',    desc: 'Code review & dev' },
];

// ─── Wizard ───────────────────────────────────────────────────────────────────

/**
 * New agent onboarding wizard.
 *
 * @returns {JSX.Element}
 */
export default function NewAgentWizard() {
  const router   = useRouter();
  const [step, setStep]       = useState(0);
  const [state, setState]     = useState<WizardState>(INITIAL);
  const [catalog, setCatalog] = useState<McpServer[]>([]);
  const [agents, setAgents]   = useState<Agent[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]     = useState('');

  const bosses = agents.filter(a => a.isBoss);

  useEffect(() => {
    fetch('/api/mcps').then(r => r.json()).then(setCatalog);
    fetch('/api/agents').then(r => r.json()).then((a: Agent[]) => {
      setAgents(a);
    }).catch(() => {});
  }, []);

  const update = (patch: Partial<WizardState>) => setState(s => ({ ...s, ...patch }));

  // Boss agents skip Persona + Tools steps (their CLAUDE.md is auto-generated)
  const totalSteps = state.isBoss ? 4 : 6;
  const stepLabels = state.isBoss
    ? ['Name & Role', 'Slack App', 'Credentials', 'Review']
    : ['Name & Role', 'Persona', 'Slack App', 'Credentials', 'Tools', 'Review'];

  const next = () => setStep(s => Math.min(s + 1, totalSteps - 1));
  const back = () => setStep(s => Math.max(s - 1, 0));

  const credStep = state.isBoss ? 2 : 3;
  const canNext = () => {
    if (step === 0) return !!(state.name && state.slug);
    // Persona step (non-boss only, step index 1): if "Blank" is picked, the
    // user must type a description. Otherwise the template supplies it and
    // Coach bootstrap would silently skip (see seed check in submit()).
    if (!state.isBoss && step === 1) {
      if (!state.selectedPersona && !state.description.trim()) return false;
    }
    if (step === credStep) return !!(state.slackBotToken && state.slackAppToken && state.slackSigningSecret);
    return true;
  };

  const submit = async () => {
    setSubmitting(true); setError('');
    try {
      const r = await fetch('/api/agents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: state.slug,
          name: state.name,
          persona: state.selectedPersona?.persona ?? state.persona,
          description: state.selectedPersona?.description ?? state.description,
          model: state.model,
          isBoss: state.isBoss,
          reportsTo: state.isBoss ? [] : state.reportsToIds,
          skillTemplate: 'blank',
          mcpServerIds: state.mcpServerIds,
          platform: 'slack',
          platformCredentials: {
            botToken: state.slackBotToken,
            appToken: state.slackAppToken,
            signingSecret: state.slackSigningSecret,
          },
        }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? 'Failed to create agent'); return; }

      // Apply selected persona (claudeMd + skills)
      if (state.selectedPersona) {
        const { claudeMd, skills } = state.selectedPersona;
        await fetch(`/api/agents/${data.id}/claude-md`, {
          method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: claudeMd,
        });
        await Promise.all(skills.map(s =>
          fetch(`/api/agents/${data.id}/skills?noSnapshot=1`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(s),
          })
        ));
      } else if (state.importPayload) {
        const { claudeMd, skills } = state.importPayload;
        await fetch(`/api/agents/${data.id}/claude-md`, {
          method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: claudeMd,
        });
        await Promise.all(skills.map(s =>
          fetch(`/api/agents/${data.id}/skills`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(s),
          })
        ));
      }

      // Kick off bootstrap in the background — don't await. The route returns
      // 202 quickly; the runner then drafts claude.md + skills and writes the
      // result to the coach session. The Instructions tab polls it live.
      // Invariant: for non-import, non-boss agents, description is required
      // (enforced in canNext() and API validation), so seed is always non-empty.
      const seed = [state.description?.trim(), state.persona?.trim()].filter(Boolean).join('\n\n');
      if (!state.importPayload && !state.isBoss && seed.length > 0) {
        fetch(`/api/agents/${data.id}/coach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userMessage: seed, autoApply: true, detached: true }),
        }).catch(() => { /* non-fatal; user can run Coach manually */ });
      }

      window.dispatchEvent(new Event('slackhive:sidebar-refresh'));
      router.push(`/agents/${data.slug}?coach=open`);
    } finally { setSubmitting(false); }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{
        padding: '18px 36px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12,
        background: 'var(--surface)',
      }}>
        <a href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 12 }}>
          ← Agents
        </a>
        <span style={{ color: 'var(--border-2)' }}>/</span>
        <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>New Agent</span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, display: 'flex', padding: '40px 36px', gap: 36, maxWidth: 860, width: '100%' }}>

        {/* ── Left: step nav ───────────────────────────────────────────── */}
        <div style={{ width: 180, flexShrink: 0 }}>
          <div style={{ position: 'sticky', top: 40 }}>
            {stepLabels.map((label, i) => (
              <div
                key={i}
                onClick={() => i < step && setStep(i)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 0', cursor: i < step ? 'pointer' : 'default',
                }}
              >
                <div style={{
                  width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: i < step ? 11 : 12, fontWeight: 600,
                  background: i < step ? 'var(--accent)' :
                               i === step ? 'rgba(59,130,246,0.15)' :
                               'transparent',
                  color: i < step ? '#fff' :
                         i === step ? 'var(--accent)' :
                         'var(--muted)',
                  border: i < step ? '1.5px solid transparent' :
                          i === step ? '1.5px solid var(--accent)' :
                          '1.5px solid var(--border-2)',
                  transition: 'all 0.2s',
                }}>
                  {i < step ? '✓' : i + 1}
                </div>
                <span style={{
                  fontSize: 13,
                  fontWeight: i === step ? 600 : 400,
                  color: i === step ? 'var(--text)' : i < step ? 'var(--muted)' : 'var(--subtle)',
                  transition: 'color 0.2s',
                }}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right: step panel ────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              background: 'var(--surface)',
              borderRadius: 'var(--radius-lg)',
              padding: '32px',
              boxShadow: 'var(--shadow-card)',
            }}
            className="fade-up"
            key={step}
          >
            {step === 0 && <Step1Identity state={state} update={update} bosses={bosses} />}
            {/* Specialist steps */}
            {!state.isBoss && step === 1 && <Step2Persona state={state} update={update} />}
            {!state.isBoss && step === 2 && <Step2SlackApp state={state} />}
            {!state.isBoss && step === 3 && <Step3Tokens state={state} update={update} />}
            {!state.isBoss && step === 4 && <Step4McpsSkills state={state} update={update} catalog={catalog} />}
            {!state.isBoss && step === 5 && <Step5Review state={state} update={update} catalog={catalog} agents={agents} />}
            {/* Boss steps */}
            {state.isBoss && step === 1 && <Step2SlackApp state={state} />}
            {state.isBoss && step === 2 && <Step3Tokens state={state} update={update} />}
            {state.isBoss && step === 3 && <Step5Review state={state} update={update} catalog={catalog} agents={agents} />}
          </div>

          {error && (
            <div style={{
              marginTop: 12, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171',
            }}>{error}</div>
          )}

          {/* Nav buttons */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
            <button
              onClick={back} disabled={step === 0}
              style={{
                background: 'transparent', color: step === 0 ? 'var(--subtle)' : 'var(--muted)',
                border: '1.5px solid var(--border)', borderRadius: 'var(--radius)',
                padding: '10px 20px', fontSize: 14, fontWeight: 500, cursor: step === 0 ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-sans)', transition: 'border-color 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { if (step > 0) { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; } }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; }}
            >← Back</button>

            {step < totalSteps - 1 ? (
              <button
                onClick={next} disabled={!canNext()}
                style={{
                  background: canNext() ? 'var(--accent)' : 'var(--border)',
                  color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--radius)',
                  padding: '10px 24px', fontSize: 14, fontWeight: 600,
                  cursor: canNext() ? 'pointer' : 'not-allowed',
                  fontFamily: 'var(--font-sans)', transition: 'opacity 0.15s, transform 0.15s',
                  boxShadow: canNext() ? 'var(--shadow-sm)' : 'none',
                  letterSpacing: '-0.01em',
                }}
                onMouseEnter={e => { if (canNext()) { (e.currentTarget as HTMLElement).style.opacity = '0.88'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; } }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
              >Continue →</button>
            ) : (
              <button
                onClick={submit}
                disabled={submitting || !state.slackBotToken || !state.slackAppToken || !state.slackSigningSecret}
                style={{
                  background: submitting ? 'var(--border)' : '#16a34a',
                  color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--radius)',
                  padding: '10px 24px', fontSize: 14, fontWeight: 600,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  fontFamily: 'var(--font-sans)', transition: 'opacity 0.15s, transform 0.15s',
                  boxShadow: !submitting ? 'var(--shadow-sm)' : 'none',
                  letterSpacing: '-0.01em',
                }}
                onMouseEnter={e => { if (!submitting) { (e.currentTarget as HTMLElement).style.opacity = '0.88'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; } }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
              >{submitting ? 'Creating…' : 'Create Agent'}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Step 1: Identity ─────────────────────────────────────────────────────────

function Step1Identity({ state, update, bosses }: {
  state: WizardState; update: (p: Partial<WizardState>) => void;
  bosses: Agent[];
}) {
  const autoSlug = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const toggleBoss = (id: string) => {
    const next = state.reportsToIds.includes(id)
      ? state.reportsToIds.filter(x => x !== id)
      : [...state.reportsToIds, id];
    update({ reportsToIds: next });
  };

  return (
    <div>
      <StepHeader step={1} title="Name your agent" desc="Give it a name and decide if it leads a team or works as a specialist." />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <Field label="Agent Name *" value={state.name} placeholder="e.g. GILFOYLE"
          onChange={v => update({ name: v, slug: autoSlug(v) })} />
        <Field label="Slug *" value={state.slug} placeholder="e.g. gilfoyle"
          hint="Lowercase, hyphens only"
          onChange={v => update({ slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
      </div>
      {/* Model selector */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 8 }}>
          Model
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {MODELS.map(m => (
            <label key={m.value} style={{
              display: 'flex', flexDirection: 'column', gap: 2,
              padding: '10px 12px', border: `1px solid ${state.model === m.value ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8, cursor: 'pointer',
              background: state.model === m.value ? 'rgba(59,130,246,0.08)' : 'transparent',
              transition: 'border-color 0.15s, background 0.15s',
            }}>
              <input type="radio" name="model" value={m.value} checked={state.model === m.value}
                onChange={() => update({ model: m.value })} style={{ display: 'none' }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: state.model === m.value ? 'var(--accent)' : 'var(--text)' }}>
                {m.label}
              </span>
              <span style={{ fontSize: 11, color: 'var(--subtle)' }}>{m.sub}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Boss toggle */}
      <div style={{ marginBottom: 14 }}>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', border: `1px solid ${state.isBoss ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 8, cursor: 'pointer',
          background: state.isBoss ? 'rgba(59,130,246,0.08)' : 'transparent',
          transition: 'all 0.15s',
        }}>
          <input type="checkbox" checked={state.isBoss}
            onChange={e => update({ isBoss: e.target.checked, reportsToIds: [] })}
            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: state.isBoss ? 'var(--accent)' : 'var(--text)' }}>
              This agent is a Boss
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--subtle)' }}>
              Boss agents orchestrate specialists. Their CLAUDE.md is auto-generated from the team.
            </div>
          </div>
        </label>
      </div>

      {/* Reports to — multi-select boss agents (only shown for non-boss agents) */}
      {!state.isBoss && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 6 }}>
            Reports to
          </label>
          {bosses.length === 0 ? (
            <div style={{
              border: '1px dashed var(--border)', borderRadius: 8, padding: '12px 14px',
              fontSize: 12.5, color: 'var(--subtle)',
            }}>
              No boss agents yet — create a boss first, or mark this agent as a boss above.
            </div>
          ) : (
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              {bosses.map((boss, i) => (
                <label key={boss.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                  cursor: 'pointer',
                  borderBottom: i < bosses.length - 1 ? '1px solid var(--border)' : 'none',
                  background: state.reportsToIds.includes(boss.id) ? 'rgba(59,130,246,0.06)' : 'transparent',
                  transition: 'background 0.12s',
                }}>
                  <input type="checkbox"
                    checked={state.reportsToIds.includes(boss.id)}
                    onChange={() => toggleBoss(boss.id)}
                    style={{ accentColor: 'var(--accent)', width: 14, height: 14 }} />
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>{boss.name}</span>
                </label>
              ))}
            </div>
          )}
          {state.reportsToIds.length > 0 && (
            <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--subtle)' }}>
              This agent will appear in the team registry of {state.reportsToIds.length} boss{state.reportsToIds.length > 1 ? 'es' : ''}.
            </p>
          )}
        </div>
      )}

      {/* Import config */}
    </div>
  );
}

// ─── Import config picker ─────────────────────────────────────────────────────

function ImportConfigPicker({ value, onChange, compact }: {
  value: AgentExportPayload | null;
  onChange: (p: AgentExportPayload | null) => void;
  compact?: boolean;
}) {
  const [error, setError] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setError('');
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (typeof data.claudeMd !== 'string' || !Array.isArray(data.skills)) {
          setError('Invalid file — must contain claudeMd (string) and skills (array)'); return;
        }
        if (typeof data.version !== 'number') {
          setError('Invalid file — missing version field'); return;
        }
        onChange(data);
      } catch {
        setError('Could not parse file — must be valid JSON');
      }
    };
    reader.readAsText(file);
  };

  if (compact) {
    return (
      <div>
        {!value ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 1 }}>Import config</div>
              <div style={{ fontSize: 11.5, color: 'var(--subtle)' }}>Load CLAUDE.md + skills from an exported agent</div>
              {error && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 3 }}>{error}</div>}
            </div>
            <button type="button" onClick={() => ref.current?.click()} style={{
              display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
              padding: '6px 12px', borderRadius: 6,
              border: '1px solid var(--border-2)', background: 'var(--surface)',
              fontSize: 12, fontWeight: 500, color: 'var(--muted)', cursor: 'pointer',
            }}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 2v9M4 7l4 4 4-4M2 13h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Choose file
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#7c3aed' }}>
                Config loaded
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {value.skills.length} skill{value.skills.length !== 1 ? 's' : ''} · CLAUDE.md included
              </div>
            </div>
            <button type="button" onClick={() => { onChange(null); setError(''); }} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 11.5, color: 'var(--muted)', padding: '3px 6px',
            }}>Remove</button>
          </div>
        )}
        <input ref={ref} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFile} />
      </div>
    );
  }

  return (
    <div style={{
      marginTop: 20, padding: '14px 16px', borderRadius: 10,
      border: `1.5px dashed ${value ? '#8b5cf6' : 'var(--border-2)'}`,
      background: value ? 'rgba(139,92,246,0.03)' : 'var(--surface)',
      transition: 'all 0.2s',
    }}>
      {!value ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>
              Import from existing config
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Load CLAUDE.md + skills from a previously exported agent
            </div>
            {error && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 4 }}>{error}</div>}
          </div>
          <button type="button" onClick={() => ref.current?.click()} style={{
            display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
            padding: '7px 14px', borderRadius: 7,
            border: '1.5px solid var(--border-2)', background: 'var(--surface)',
            fontSize: 12.5, fontWeight: 500, color: 'var(--muted)', cursor: 'pointer',
            transition: 'all 0.15s',
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#8b5cf6'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v9M4 7l4 4 4-4M2 13h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Choose file
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              background: 'rgba(139,92,246,0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6L9 2z" stroke="#8b5cf6" strokeWidth="1.4" strokeLinejoin="round"/>
                <path d="M9 2v4h4" stroke="#8b5cf6" strokeWidth="1.4" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
                Config file loaded
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {value.skills.length} skill{value.skills.length !== 1 ? 's' : ''} · CLAUDE.md included
                {value.exportedAt && ` · ${new Date(value.exportedAt).toLocaleDateString()}`}
              </div>
            </div>
          </div>
          <button type="button" onClick={() => { onChange(null); setError(''); }} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 11.5, color: 'var(--muted)', padding: '4px 8px', borderRadius: 5,
          }}>Remove</button>
        </div>
      )}
      <input ref={ref} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFile} />
    </div>
  );
}

// ─── Step 2: Slack App ────────────────────────────────────────────────────────

function Step2SlackApp({ state }: { state: WizardState }) {
  const [copied, setCopied] = useState(false);
  const manifest = state.name
    ? JSON.stringify(generateSlackManifest({ name: state.name, description: state.description, isBoss: state.isBoss }), null, 2)
    : '{}';

  const copy = () => { navigator.clipboard.writeText(manifest); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  return (
    <div>
      <StepHeader step={2} title="Create a Slack app" desc="Paste this manifest into Slack — it configures everything automatically in about 2 minutes." />

      {/* Steps */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 20 }}>
        {([
          {
            n: 1,
            title: 'Open api.slack.com/apps',
            body: <>Click <Kbd>Create New App</Kbd> → <Kbd>From a manifest</Kbd> and select your workspace.</>,
          },
          {
            n: 2,
            title: 'Paste the manifest',
            body: <>Switch to the <Kbd>JSON</Kbd> tab, paste the manifest below, click <Kbd>Next</Kbd> → <Kbd>Create</Kbd>.</>,
          },
          {
            n: 3,
            title: 'Install to workspace',
            body: <>In the sidebar go to <Kbd>Install App</Kbd> → <Kbd>Install to Workspace</Kbd> → Allow. This generates your Bot Token — it won&apos;t appear until you install.</>,
          },
        ] as { n: number; title: string; body: React.ReactNode }[]).map(({ n, title, body }, i, arr) => (
          <div key={n} style={{ display: 'flex', gap: 0 }}>
            {/* Connector line + dot */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 32, flexShrink: 0 }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                background: 'var(--accent)', color: 'var(--accent-fg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, zIndex: 1,
              }}>{n}</div>
              {i < arr.length - 1 && (
                <div style={{ width: 2, flex: 1, background: 'var(--border)', minHeight: 20, marginTop: 4 }} />
              )}
            </div>
            {/* Content */}
            <div style={{ paddingLeft: 14, paddingBottom: i < arr.length - 1 ? 20 : 0, paddingTop: 3 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 3 }}>{title}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.65 }}>{body}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Manifest block */}
      <div style={{ background: 'var(--surface-2)', border: '1.5px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 16px', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
            {state.name || 'agent'}-manifest.json
          </span>
          <button onClick={copy} style={{
            background: copied ? 'var(--green)' : 'var(--accent)',
            color: copied ? '#fff' : 'var(--accent-fg)',
            border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            fontFamily: 'var(--font-sans)', padding: '5px 12px', borderRadius: 6,
            transition: 'all 0.15s',
          }}>{copied ? '✓ Copied!' : 'Copy manifest'}</button>
        </div>
        <pre style={{
          margin: 0, padding: '16px', fontSize: 11.5, color: 'var(--text)',
          fontFamily: 'var(--font-mono)', overflow: 'auto', maxHeight: 260, lineHeight: 1.6,
        }}>{manifest}</pre>
      </div>
    </div>
  );
}

// ─── Step 3: Tokens ───────────────────────────────────────────────────────────

function Step3Tokens({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
  return (
    <div>
      <StepHeader step={3} title="Add your tokens" desc="Three values from your Slack app — paste each one below." />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <TokenCard
          label="Bot Token"
          prefix="xoxb-"
          path={['OAuth & Permissions', 'Bot User OAuth Token']}
          screenshot={<BotTokenScreenshot />}
          placeholder="xoxb-..."
          value={state.slackBotToken}
          onChange={v => update({ slackBotToken: v })}
        />
        <TokenCard
          label="App-Level Token"
          prefix="xapp-"
          path={['Basic Information', 'App-Level Tokens']}
          note={<>Click <strong>Generate Token and Scopes</strong>, add scope <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'rgba(59,130,246,0.08)', color: 'var(--accent)', padding: '1px 6px', borderRadius: 4 }}>connections:write</code>, then generate.</>}
          screenshot={<AppTokenScreenshot />}
          placeholder="xapp-..."
          value={state.slackAppToken}
          onChange={v => update({ slackAppToken: v })}
        />
        <TokenCard
          label="Signing Secret"
          prefix=""
          path={['Basic Information', 'App Credentials', 'Signing Secret']}
          screenshot={<SigningSecretScreenshot />}
          placeholder="abc123def..."
          value={state.slackSigningSecret}
          onChange={v => update({ slackSigningSecret: v })}
        />
      </div>
    </div>
  );
}

// ─── Token card ───────────────────────────────────────────────────────────────

function TokenCard({ label, prefix, path, note, screenshot, placeholder, value, onChange }: {
  label: string; prefix: string;
  path: string[];
  note?: React.ReactNode;
  screenshot?: React.ReactNode;
  placeholder: string; value: string; onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  const [showScreenshot, setShowScreenshot] = useState(false);
  const isDirty = value.length > 0;
  const isValid = prefix ? value.startsWith(prefix) : value.length >= 8;

  return (
    <div style={{
      borderRadius: 'var(--radius)',
      border: `1.5px solid ${isDirty ? (isValid ? '#86efac' : '#fca5a5') : 'var(--border)'}`,
      background: 'var(--surface)',
      overflow: 'hidden',
      transition: 'border-color 0.2s',
    }}>
      {/* Header: label + breadcrumb */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', flexShrink: 0 }}>{label}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden' }}>
            {path.map((p, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{ fontSize: 11, color: 'var(--border-2)' }}>›</span>}
                <span style={{
                  fontSize: 11.5, whiteSpace: 'nowrap',
                  color: i === path.length - 1 ? 'var(--muted)' : 'var(--subtle)',
                  fontWeight: i === path.length - 1 ? 500 : 400,
                }}>{p}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {screenshot && (
            <button
              type="button"
              onClick={() => setShowScreenshot(s => !s)}
              style={{
                background: showScreenshot ? 'var(--surface-2)' : 'none',
                border: '1px solid var(--border)', borderRadius: 5,
                padding: '3px 8px', cursor: 'pointer',
                color: 'var(--muted)', fontSize: 11, fontWeight: 500,
                fontFamily: 'var(--font-sans)', transition: 'all 0.15s',
              }}
            >{showScreenshot ? 'Hide guide' : 'Where?'}</button>
          )}
          {isDirty && (
            <span style={{ fontSize: 12, fontWeight: 700, color: isValid ? '#16a34a' : '#ef4444' }}>
              {isValid ? '✓' : '✗'}
            </span>
          )}
        </div>
      </div>

      {/* Screenshot guide */}
      {showScreenshot && screenshot && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          {screenshot}
        </div>
      )}

      {/* Note */}
      {note && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--muted)', background: 'var(--surface-2)', lineHeight: 1.6 }}>
          {note}
        </div>
      )}

      {/* Input */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 4px 0 16px', gap: 6 }}>
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1, background: 'transparent', border: 'none',
            padding: '12px 0', color: 'var(--text)',
            fontSize: 13, fontFamily: value ? 'var(--font-mono)' : 'var(--font-sans)',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => setShow(s => !s)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--subtle)', fontSize: 12, padding: '8px',
            fontFamily: 'var(--font-sans)', lineHeight: 1,
          }}
        >{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>
      </div>
    </div>
  );
}

// ─── Slack UI screenshot mockups ──────────────────────────────────────────────

const slackStyles = {
  wrap: {
    borderRadius: 8, overflow: 'hidden', border: '1px solid #e0e0e0',
    fontFamily: 'Lato, -apple-system, sans-serif', fontSize: 12,
  } as React.CSSProperties,
  chrome: {
    background: 'var(--surface-2)', padding: '6px 10px',
    borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8,
  } as React.CSSProperties,
  urlBar: {
    flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4,
    padding: '3px 8px', fontSize: 10.5, color: '#555',
    fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  body: { background: 'var(--surface)', padding: '14px 16px' } as React.CSSProperties,
  sectionTitle: { fontSize: 12, fontWeight: 700, color: '#1d1c1d', marginBottom: 10 } as React.CSSProperties,
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 10px', border: '1px solid #e8e8e8', borderRadius: 5,
  } as React.CSSProperties,
  label: { fontSize: 11.5, color: '#616061' } as React.CSSProperties,
  token: { fontSize: 11, fontFamily: 'monospace', color: '#1d1c1d', letterSpacing: 1 } as React.CSSProperties,
  greenBtn: {
    background: 'var(--green)', color: 'var(--accent-fg)', border: 'none', borderRadius: 4,
    padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: 'default',
    boxShadow: '0 0 0 3px rgba(0,122,90,0.25)',
  } as React.CSSProperties,
  badge: {
    background: '#e8f5f0', color: '#007a5a', border: '1px solid #b8dfd4',
    borderRadius: 3, padding: '1px 6px', fontSize: 10.5, fontWeight: 600,
  } as React.CSSProperties,
  highlight: {
    outline: '2.5px solid #007a5a', outlineOffset: 2, borderRadius: 4,
  } as React.CSSProperties,
};

function ChromeBar({ url }: { url: string }) {
  return (
    <div style={slackStyles.chrome}>
      <div style={{ display: 'flex', gap: 4 }}>
        {['#ff5f57','#febc2e','#28c840'].map(c => (
          <div key={c} style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
        ))}
      </div>
      <div style={slackStyles.urlBar}>{url}</div>
    </div>
  );
}

function SlackLayout({ url, activeNav, children }: { url: string; activeNav: string; children: React.ReactNode }) {
  const navItems = ['Basic Information', 'Socket Mode', 'Install App', 'OAuth & Permissions', 'Event Subscriptions', 'App Manifest'];
  return (
    <div style={slackStyles.wrap}>
      <ChromeBar url={url} />
      <div style={{ display: 'flex', background: 'var(--surface)' }}>
        {/* Sidebar */}
        <div style={{ width: 148, background: '#f8f8f8', borderRight: '1px solid #e0e0e0', padding: '10px 0', flexShrink: 0 }}>
          {navItems.map(item => (
            <div key={item} style={{
              padding: '5px 12px', fontSize: 11, cursor: 'default',
              background: item === activeNav ? '#e8e8e8' : 'transparent',
              color: item === activeNav ? '#1d1c1d' : '#616061',
              fontWeight: item === activeNav ? 700 : 400,
              borderLeft: item === activeNav ? '2px solid #007a5a' : '2px solid transparent',
            }}>{item}</div>
          ))}
        </div>
        {/* Content */}
        <div style={{ flex: 1, padding: '14px 16px', minWidth: 0 }}>{children}</div>
      </div>
    </div>
  );
}

function BotTokenScreenshot() {
  return (
    <SlackLayout url="api.slack.com/apps/A.../oauth" activeNav="OAuth & Permissions">
      {/* Install notice */}
      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--amber)', borderRadius: 5, padding: '7px 10px', marginBottom: 10, fontSize: 11, color: 'var(--amber)', lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>Token only appears after <strong>Install to Workspace</strong> (sidebar → Install App)</span>
      </div>
      <div style={slackStyles.sectionTitle}>OAuth Tokens</div>
      <div style={{ border: '1px solid #e8e8e8', borderRadius: 5, overflow: 'hidden' }}>
        <div style={{ padding: '8px 10px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, color: '#616061', marginBottom: 1 }}>Bot User OAuth Token</div>
          <div style={{ ...slackStyles.token, fontSize: 10.5 }}>xoxb-••••••••••••-••••••••••••-••••••••••••</div>
          <div style={{ fontSize: 10, color: '#616061', marginTop: 2 }}>Access Level: Workspace</div>
        </div>
        <div style={{ padding: '7px 10px', display: 'flex', justifyContent: 'flex-end' }}>
          <button style={{ ...slackStyles.greenBtn, ...slackStyles.highlight }}>Copy</button>
        </div>
      </div>
    </SlackLayout>
  );
}

function AppTokenScreenshot() {
  return (
    <SlackLayout url="api.slack.com/apps/A.../general" activeNav="Basic Information">
      <div style={slackStyles.sectionTitle}>App-Level Tokens</div>
      <div style={{ fontSize: 11, color: '#616061', marginBottom: 10, lineHeight: 1.5 }}>
        App-level tokens represent your app across organizations.
      </div>
      <div style={{ marginBottom: 10 }}>
        <button style={{ ...slackStyles.greenBtn, ...slackStyles.highlight }}>Generate Token and Scopes</button>
      </div>
      <div style={{ border: '1px solid #e8e8e8', borderRadius: 5, padding: '8px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#1d1c1d', marginBottom: 4 }}>SlackHive</div>
          <span style={slackStyles.badge}>connections:write</span>
        </div>
        <div style={slackStyles.token}>xapp-••••••••••••</div>
      </div>
    </SlackLayout>
  );
}

function SigningSecretScreenshot() {
  return (
    <SlackLayout url="api.slack.com/apps/A.../general" activeNav="Basic Information">
      <div style={slackStyles.sectionTitle}>App Credentials</div>
      <div style={{ fontSize: 11, color: '#616061', marginBottom: 10, lineHeight: 1.5 }}>
        These credentials allow your app to access the Slack API. Keep them secret.
      </div>
      {[
        { label: 'App ID', value: 'A0AN••••••9', mono: true },
        { label: 'Client ID', value: '9186••••••••••••••••', mono: true },
        { label: 'Client Secret', value: '••••••••••', mono: true },
      ].map(row => (
        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #f0f0f0', fontSize: 11, color: '#616061' }}>
          <span>{row.label}</span>
          <span style={{ fontFamily: 'monospace', color: '#1d1c1d' }}>{row.value}</span>
        </div>
      ))}
      {/* Signing Secret highlighted */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', marginTop: 6, border: '1px solid #e8e8e8', borderRadius: 5, ...slackStyles.highlight }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#1d1c1d', marginBottom: 2 }}>Signing Secret</div>
          <div style={slackStyles.token}>••••••••••••••••••••••••</div>
        </div>
        <button style={slackStyles.greenBtn}>Show</button>
      </div>
    </SlackLayout>
  );
}

// ─── Kbd helper ───────────────────────────────────────────────────────────────

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd style={{
      display: 'inline-block', fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600,
      background: 'var(--surface-3)', color: 'var(--text)',
      border: '1px solid var(--border)', borderRadius: 5,
      padding: '1px 7px', lineHeight: 1.7, whiteSpace: 'nowrap',
    }}>{children}</kbd>
  );
}

// ─── Step 2: Persona browser ─────────────────────────────────────────────────

const PERSONA_CATEGORY_LABELS: [PersonaCategory | 'all', string][] = [
  ['all', 'All'],
  ['engineering', 'Engineering'],
  ['data', 'Data'],
  ['product', 'Product'],
  ['business', 'Business'],
  ['generic', 'Generic'],
];

const PERSONA_CATEGORY_COLORS: Record<string, string> = {
  engineering: '#3b82f6',
  data: '#9333ea',
  product: '#16a34a',
  business: '#d97706',
  generic: '#6b7280',
};

function Step2Persona({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<PersonaCategory | 'all'>('all');

  const filtered = useMemo(() => {
    let list = search.trim() ? searchPersonas(search) : PERSONA_CATALOG;
    if (category !== 'all') list = list.filter(p => p.category === category);
    return list;
  }, [search, category]);

  const selected = state.selectedPersona;

  return (
    <div>
      <StepHeader step={2} title="Choose a persona" desc="Pick a pre-built role to give your agent a system prompt and skills. You can skip and start blank." />

      {/* Search + category chips */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
          <input
            type="text" placeholder="Search personas…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '8px 10px 8px 30px', fontSize: 13,
              background: 'var(--surface-2)', border: '1.5px solid var(--border)',
              borderRadius: 'var(--radius)', color: 'var(--text)', fontFamily: 'var(--font-sans)', outline: 'none',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PERSONA_CATEGORY_LABELS.map(([val, label]) => {
            const active = category === val;
            return (
              <button key={val} onClick={() => setCategory(val)}
                style={{
                  padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: active ? 600 : 400,
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  background: active ? 'rgba(59,130,246,0.1)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--muted)',
                  cursor: 'pointer', fontFamily: 'var(--font-sans)', transition: 'all 0.12s',
                }}
              >{label}</button>
            );
          })}
        </div>
      </div>

      {/* Card grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: 8, maxHeight: 290, overflowY: 'auto', paddingRight: 2,
      }}>
        {/* Blank card — always first */}
        {(() => {
          const isBlank = selected === null;
          return (
            <div
              onClick={() => update({ selectedPersona: null })}
              style={{
                padding: '11px 12px', borderRadius: 8, cursor: 'pointer',
                border: `1.5px solid ${isBlank ? 'var(--border-2)' : 'var(--border)'}`,
                background: isBlank ? 'var(--surface-2)' : 'transparent',
                transition: 'border-color 0.12s, background 0.12s',
                position: 'relative',
              }}
              onMouseEnter={e => { if (!isBlank) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; }}
              onMouseLeave={e => { if (!isBlank) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; }}
            >
              {isBlank && (
                <div style={{
                  position: 'absolute', top: 6, right: 6,
                  width: 16, height: 16, borderRadius: '50%',
                  background: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Check size={10} color="#fff" strokeWidth={3} />
                </div>
              )}
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', color: 'var(--subtle)', textTransform: 'uppercase', marginBottom: 5 }}>generic</div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', marginBottom: 3, lineHeight: 1.3 }}>Blank</div>
              <div style={{ fontSize: 11, color: 'var(--subtle)', lineHeight: 1.4 }}>No persona, no skills — start from scratch</div>
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>0 skills</div>
            </div>
          );
        })()}
        {filtered.map(p => {
          const isSelected = selected?.id === p.id;
          const catColor = PERSONA_CATEGORY_COLORS[p.category] ?? '#6b7280';
          return (
            <div key={p.id}
              onClick={() => update({ selectedPersona: isSelected ? null : p })}
              style={{
                padding: '11px 12px', borderRadius: 8, cursor: 'pointer',
                border: `1.5px solid ${isSelected ? catColor : 'var(--border)'}`,
                background: isSelected ? `${catColor}12` : 'var(--surface-2)',
                transition: 'border-color 0.12s, background 0.12s',
                position: 'relative',
              }}
              onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; }}
              onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; }}
            >
              {isSelected && (
                <div style={{
                  position: 'absolute', top: 6, right: 6,
                  width: 16, height: 16, borderRadius: '50%',
                  background: catColor, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Check size={10} color="#fff" strokeWidth={3} />
                </div>
              )}
              <div style={{
                display: 'inline-block', marginBottom: 5,
                fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
                color: catColor, textTransform: 'uppercase',
              }}>{p.category}</div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', marginBottom: 3, lineHeight: 1.3 }}>{p.name}</div>
              <div style={{
                fontSize: 11, color: 'var(--subtle)', lineHeight: 1.4,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>{p.cardDescription}</div>
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                {p.skills.length} skills
              </div>
            </div>
          );
        })}
      </div>

      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--subtle)' }}>
        {selected ? <><span style={{ color: 'var(--text)', fontWeight: 500 }}>{selected.name}</span> selected</> : 'Blank selected — describe the agent below'}
      </p>

      {/* When "Blank" is picked there's no template to supply description/persona.
          Description is required so the agent has an identity AND so Coach bootstrap
          has a seed to run with (see submit() — seed = description ?? persona). */}
      {selected === null && (
        <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 6 }}>
              Description <span style={{ color: 'var(--accent)' }}>*</span>
            </label>
            <textarea
              value={state.description}
              onChange={e => update({ description: e.target.value })}
              placeholder="What does this agent do in one sentence? (e.g. 'Daily team birthday reminders in #general')"
              rows={2}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '9px 11px', fontSize: 13, lineHeight: 1.5,
                background: 'var(--surface-2)', border: '1.5px solid var(--border)',
                borderRadius: 'var(--radius)', color: 'var(--text)',
                fontFamily: 'var(--font-sans)', outline: 'none', resize: 'vertical',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
            <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>
              Used to seed the agent&apos;s CLAUDE.md and kick off the Coach&apos;s first-turn draft.
            </p>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 6 }}>
              Persona <span style={{ color: 'var(--subtle)', fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              value={state.persona}
              onChange={e => update({ persona: e.target.value })}
              placeholder="Tone / voice / how it should speak. Leave blank and the Coach will draft one."
              rows={2}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '9px 11px', fontSize: 13, lineHeight: 1.5,
                background: 'var(--surface-2)', border: '1.5px solid var(--border)',
                borderRadius: 'var(--radius)', color: 'var(--text)',
                fontFamily: 'var(--font-sans)', outline: 'none', resize: 'vertical',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step 4: MCPs ─────────────────────────────────────────────────────────────

function Step4McpsSkills({
  state, update, catalog,
}: { state: WizardState; update: (p: Partial<WizardState>) => void; catalog: McpServer[] }) {
  const toggle = (id: string) => {
    const ids = state.mcpServerIds.includes(id)
      ? state.mcpServerIds.filter(x => x !== id)
      : [...state.mcpServerIds, id];
    update({ mcpServerIds: ids });
  };

  return (
    <div>
      <StepHeader step={5} title="Tools" desc="Attach MCP servers to give your agent access to external tools. You can change these anytime." />

      {/* MCP list */}
      <div style={{ marginBottom: 22 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          MCP Servers
        </label>
        {catalog.length === 0 ? (
          <div style={{
            border: '1px dashed var(--border)', borderRadius: 8, padding: '16px',
            fontSize: 12.5, color: 'var(--subtle)', textAlign: 'center',
          }}>
            No MCP servers yet — you can add them after creation in <strong style={{ color: 'var(--muted)' }}>Settings → MCP Catalog</strong>
          </div>
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            {catalog.map((mcp, i) => (
              <label key={mcp.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                cursor: mcp.enabled ? 'pointer' : 'not-allowed',
                borderBottom: i < catalog.length - 1 ? '1px solid var(--border)' : 'none',
                opacity: mcp.enabled ? 1 : 0.4, transition: 'background 0.12s',
              }}
                onMouseEnter={e => { if (mcp.enabled) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <input type="checkbox" checked={state.mcpServerIds.includes(mcp.id)}
                  onChange={() => toggle(mcp.id)} disabled={!mcp.enabled}
                  style={{ accentColor: 'var(--accent)', width: 14, height: 14 }} />
                <div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{mcp.name}</span>
                    <span style={{
                      fontSize: 10.5, fontFamily: 'var(--font-mono)',
                      color: 'var(--muted)', background: 'var(--border)', padding: '1px 6px', borderRadius: 4,
                    }}>{mcp.type}</span>
                  </div>
                  {mcp.description && <p style={{ margin: 0, fontSize: 11.5, color: 'var(--subtle)' }}>{mcp.description}</p>}
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {state.selectedPersona && (
        <div style={{
          background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)',
          borderRadius: 8, padding: '10px 14px', fontSize: 12.5, color: 'var(--muted)',
        }}>
          Persona: <span style={{ fontWeight: 600, color: 'var(--text)' }}>{state.selectedPersona.name}</span>
          {' '}· {state.selectedPersona.skills.length} skills will be applied after creation
        </div>
      )}
    </div>
  );
}

// ─── Step 5: Review ───────────────────────────────────────────────────────────

function Step5Review({ state, update, catalog, agents }: { state: WizardState; update: (p: Partial<WizardState>) => void; catalog: McpServer[]; agents: Agent[] }) {
  const assignedBosses = agents.filter(a => state.reportsToIds.includes(a.id));
  const assignedMcps = catalog.filter(m => state.mcpServerIds.includes(m.id));
  const template = state.selectedPersona
    ? `${state.selectedPersona.name} (${state.selectedPersona.skills.length} skills)`
    : state.importPayload
    ? `Import (${state.importPayload.skills.length} skills)`
    : 'Blank';

  const reportsToValue = state.isBoss
    ? '—'
    : assignedBosses.length > 0
      ? assignedBosses.map(b => b.name).join(', ')
      : 'None';

  return (
    <div>
      <StepHeader step={state.isBoss ? 4 : 6} title="Looks good?" desc="Review the details below, then hit Create Agent to launch." />

      <div style={{
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        borderRadius: 10, overflow: 'hidden', marginBottom: 18,
      }}>
        {[
          { label: 'Name',          value: state.name,                             mono: false },
          { label: 'Slug',          value: `@${state.slug}`,                       mono: true  },
          { label: 'Model',         value: state.model,                            mono: true  },
          { label: 'Role',          value: state.isBoss ? 'Boss (orchestrator)' : 'Specialist', mono: false },
          { label: 'Reports to',    value: reportsToValue,                         mono: false },
          { label: 'Description',   value: state.description || '—',               mono: false },
          { label: 'Bot Token',     value: `${state.slackBotToken.slice(0, 12)}…`, mono: true  },
          { label: 'App Token',     value: `${state.slackAppToken.slice(0, 12)}…`, mono: true  },
          { label: 'Signing Secret',value: '••••••••',                             mono: true  },
          ...(!state.isBoss ? [
            { label: 'MCPs',          value: assignedMcps.length > 0 ? assignedMcps.map(m => m.name).join(', ') : 'None', mono: false },
            { label: 'Skill Template',value: template,                               mono: false },
          ] : [
            { label: 'Skills',        value: 'Auto-generated from team registry',   mono: false },
          ]),
        ].map((row, i, arr) => (
          <div key={row.label} style={{
            display: 'flex', alignItems: 'baseline', gap: 12,
            padding: '10px 16px',
            borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
          }}>
            <span style={{ width: 130, flexShrink: 0, fontSize: 12, color: 'var(--subtle)' }}>{row.label}</span>
            <span style={{
              fontSize: 13, color: 'var(--text)',
              fontFamily: row.mono ? 'var(--font-mono)' : 'var(--font-sans)',
            }}>{row.value}</span>
          </div>
        ))}
      </div>

      <div style={{
        background: '#f0fdf4', border: '1px solid #bbf7d0',
        borderRadius: 'var(--radius)', padding: '14px 16px', fontSize: 13, color: '#15803d', lineHeight: 1.65,
      }}>
        Once created, the runner picks up the agent automatically and connects to Slack.
        Manage skills, MCPs, and channel permissions from the agent detail page.
      </div>
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function StepHeader({ step, title, desc }: { step: number; title: string; desc: string }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
        Step {step}
      </div>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>
        {title}
      </h2>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{desc}</p>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, hint, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; hint?: string; type?: string;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>
        {label}
      </label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          width: '100%', background: 'var(--surface-2)', border: '1.5px solid var(--border)',
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

function TextArea({ label, value, onChange, placeholder, hint, rows = 3 }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; hint?: string; rows?: number;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>
        {label}
      </label>
      <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows}
        style={{
          width: '100%', background: 'var(--surface-2)', border: '1.5px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '10px 14px', color: 'var(--text)',
          fontSize: 14, fontFamily: 'var(--font-sans)', outline: 'none', resize: 'vertical',
          transition: 'border-color 0.15s', lineHeight: 1.55,
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
      />
      {hint && <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--subtle)' }}>{hint}</p>}
    </div>
  );
}
