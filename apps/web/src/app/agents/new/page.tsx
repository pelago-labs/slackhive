'use client';

/**
 * @fileoverview 2-step agent onboarding wizard.
 *
 * Steps: Identity (name, role, reports-to, tags) → Profile (persona / blank /
 * import). Boss agents are a single Identity step. Everything else — Slack
 * credentials, tools/MCPs, model, permissions — is configured after creation on
 * the agent page; a credential-less agent is created in a clean `stopped` state.
 * After creating, we land on the agent page with Connect-Slack open.
 *
 * Route: /agents/new
 * @module web/app/agents/new
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Search, Check, ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { Agent, PersonaTemplate, PersonaCategory } from '@slackhive/shared';
import { PERSONA_CATALOG, searchPersonas, DEFAULT_AGENT_MODEL } from '@slackhive/shared';

// ─── State ────────────────────────────────────────────────────────────────────

interface AgentExportPayload {
  version: number;
  exportedAt?: string;
  persona?: string;
  description?: string;
  claudeMd: string;
  skills: { category: string; filename: string; content: string; sortOrder: number }[];
}

interface WizardState {
  name: string; slug: string; description: string; persona: string;
  model: string; isBoss: boolean;
  reportsToIds: string[];
  tags: string[];
  selectedPersona: PersonaTemplate | null;
  importPayload: AgentExportPayload | null;
}

const INITIAL: WizardState = {
  name: '', slug: '', description: '', persona: '',
  model: DEFAULT_AGENT_MODEL, isBoss: false,
  reportsToIds: [], tags: [],
  selectedPersona: null, importPayload: null,
};

// ─── Wizard ───────────────────────────────────────────────────────────────────

/**
 * New agent onboarding wizard.
 *
 * @returns {JSX.Element}
 */
export default function NewAgentWizard() {
  const router   = useRouter();
  const [state, setState]     = useState<WizardState>(INITIAL);
  const [agents, setAgents]   = useState<Agent[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]     = useState('');

  const bosses = agents.filter(a => a.isBoss);

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then((a: Agent[]) => {
      setAgents(a);
    }).catch(() => {});
  }, []);

  const update = (patch: Partial<WizardState>) => setState(s => ({ ...s, ...patch }));

  // Single-step creation. A specialist needs a profile (persona, a typed
  // description, or an imported config — each supplies the brain + a Coach seed);
  // a boss only needs a name (its CLAUDE.md is auto-generated). Everything else
  // (Slack, tools, model, permissions) is configured after creation.
  const canCreate = !!(
    state.name && state.slug &&
    (state.isBoss || state.selectedPersona || state.description.trim() || state.importPayload)
  );

  const submit = async () => {
    setSubmitting(true); setError('');
    try {
      // Resolve persona/description from the chosen source: a persona template,
      // an imported config (which may carry its own), or the typed fields. The
      // API requires a non-empty description for specialists, so an import
      // without one falls back to the agent name.
      const imp = state.importPayload;
      const persona = state.selectedPersona?.persona ?? imp?.persona ?? state.persona;
      const description = state.selectedPersona?.description
        ?? (imp ? (imp.description?.trim() || state.name) : state.description);
      const r = await fetch('/api/agents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // No Slack credentials or MCPs here — both are configured post-creation
        // on the agent page (omitting platformCredentials avoids an empty
        // integration row; the agent is created in a clean `stopped` state).
        body: JSON.stringify({
          slug: state.slug,
          name: state.name,
          persona,
          description,
          model: state.model,
          isBoss: state.isBoss,
          reportsTo: state.isBoss ? [] : state.reportsToIds,
          tags: state.tags,
          skillTemplate: 'blank',
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
          fetch(`/api/agents/${data.id}/skills?noSnapshot=1`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(s),
          })
        ));
      }

      // Kick off Coach bootstrap in the background — don't await. The route
      // returns 202 quickly; the runner drafts claude.md + skills and writes the
      // result to the coach session, which the Instructions tab polls live.
      // Seed = the typed description/persona. A persona-TEMPLATE pick leaves
      // state.description empty (the template supplies claude.md + skills
      // directly), so the seed is empty and Coach is skipped for those — by
      // design. Imports and bosses are skipped too. So this fires only for the
      // blank+typed-description path, where the seed is guaranteed non-empty.
      const seed = [state.description?.trim(), state.persona?.trim()].filter(Boolean).join('\n\n');
      if (!state.importPayload && !state.isBoss && seed.length > 0) {
        fetch(`/api/agents/${data.id}/coach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userMessage: seed, autoApply: true, detached: true }),
        }).catch(() => { /* non-fatal; user can run Coach manually */ });
      }

      window.dispatchEvent(new Event('slackhive:sidebar-refresh'));
      // Land on the new agent with Connect-Slack open — connecting Slack is the
      // next action that makes the agent live.
      router.push(`/agents/${data.slug}?setup=slack`);
    } finally { setSubmitting(false); }
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 16, padding: '24px 26px', boxShadow: 'var(--shadow-sm)',
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Top bar */}
      <div style={{
        padding: '14px 24px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10,
        background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 10,
      }}>
        <a href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={14} /> Agents
        </a>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '44px 24px 132px' }}>
        <div style={{ maxWidth: 660, margin: '0 auto' }} className="fade-up">
          {/* Hero */}
          <div style={{ marginBottom: 26 }}>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: '-0.025em', color: 'var(--text)' }}>Create a new agent</h1>
            <p style={{ margin: '7px 0 0', fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
              Name it and shape its role. You&apos;ll connect Slack and add tools right after — it takes under a minute.
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={cardStyle}>
              <Step1Identity state={state} update={update} bosses={bosses} />
            </div>
            {!state.isBoss && (
              <div style={cardStyle}>
                <Step2Persona state={state} update={update} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sticky action bar */}
      <div style={{
        position: 'sticky', bottom: 0, borderTop: '1px solid var(--border)',
        background: 'color-mix(in srgb, var(--surface) 92%, transparent)', backdropFilter: 'blur(8px)',
        padding: '14px 24px',
      }}>
        <div style={{ maxWidth: 660, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 12.5, color: error ? '#dc2626' : 'var(--subtle)', lineHeight: 1.5, flex: 1, minWidth: 0 }}>
            {error || 'Slack, tools, model & permissions are configured after creation.'}
          </span>
          <button
            onClick={submit}
            disabled={submitting || !canCreate}
            style={{
              flexShrink: 0,
              background: (submitting || !canCreate) ? 'var(--border)' : 'var(--accent)',
              color: 'var(--accent-fg)', border: 'none', borderRadius: 10,
              padding: '11px 22px', fontSize: 14, fontWeight: 600,
              cursor: (submitting || !canCreate) ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-sans)', transition: 'opacity 0.15s, transform 0.15s',
              boxShadow: (submitting || !canCreate) ? 'none' : 'var(--shadow-sm)', letterSpacing: '-0.01em',
            }}
            onMouseEnter={e => { if (!submitting && canCreate) { (e.currentTarget as HTMLElement).style.opacity = '0.9'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; } }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
          >{submitting ? 'Creating…' : 'Create agent'}</button>
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
  // No model picker at creation — default to the active backend's model; it's
  // editable later on the agent page.
  useEffect(() => {
    fetch('/api/system/models').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.models?.length && !d.models.some((m: { value: string }) => m.value === state.model)) {
        update({ model: d.models[0].value });
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <StepHeader title="Identity" desc="The basics. You can rename it or change the role anytime." />
      <Field label="Agent name" value={state.name} placeholder="e.g. GILFOYLE"
        onChange={v => update({ name: v, slug: autoSlug(v) })}
        hint={state.slug ? <>URL: <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>/agents/{state.slug}</code></> : undefined} />

      {/* Role — two selectable cards */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 6 }}>Role</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            { boss: false, title: 'Specialist', desc: 'Does the work. Can report to a boss.' },
            { boss: true,  title: 'Boss',       desc: 'Orchestrates specialists. Brain auto-written.' },
          ].map(opt => {
            const active = state.isBoss === opt.boss;
            return (
              <button key={opt.title} type="button"
                onClick={() => update({ isBoss: opt.boss, reportsToIds: [] })}
                style={{
                  textAlign: 'left', cursor: 'pointer', borderRadius: 10, padding: '12px 14px',
                  border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  background: active ? 'color-mix(in srgb, var(--accent) 8%, var(--surface))' : 'var(--surface)',
                  fontFamily: 'var(--font-sans)', transition: 'border-color 0.12s, background 0.12s',
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: active ? 'var(--accent)' : 'var(--text)' }}>{opt.title}</span>
                  {active && <Check size={13} style={{ color: 'var(--accent)' }} />}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--subtle)', lineHeight: 1.45 }}>{opt.desc}</div>
              </button>
            );
          })}
        </div>
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

      {/* Tags */}
      <TagInputWizard tags={state.tags} onChange={tags => update({ tags })} />
    </div>
  );
}

// ─── Import config picker ─────────────────────────────────────────────────────

function ImportConfigPicker({ value, onChange }: {
  value: AgentExportPayload | null;
  onChange: (p: AgentExportPayload | null) => void;
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
              Load AGENTS.md + skills from a previously exported agent
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
                {value.skills.length} skill{value.skills.length !== 1 ? 's' : ''} · AGENTS.md included
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
    // The hardcoded card above already represents "Blank" (selectedPersona: null);
    // excluding it here prevents a duplicate entry in the grid.
    return list.filter(p => p.id !== 'blank');
  }, [search, category]);

  const selected = state.selectedPersona;

  return (
    <div>
      <StepHeader title="Profile" desc="Pick a persona (system prompt + skills), start blank with a description, or import an exported config." />

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
              onClick={() => update({ selectedPersona: null, importPayload: null })}
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
              onClick={() => update({ selectedPersona: isSelected ? null : p, importPayload: null })}
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
        {state.importPayload
          ? <><span style={{ color: 'var(--text)', fontWeight: 500 }}>Imported config</span> — persona &amp; description come from the file</>
          : selected
            ? <><span style={{ color: 'var(--text)', fontWeight: 500 }}>{selected.name}</span> selected</>
            : 'Blank selected — describe the agent below'}
      </p>

      {/* When "Blank" is picked (and not importing) there's no template to supply
          description/persona. Description is required so the agent has an identity
          AND so Coach bootstrap has a seed (see submit() — seed = description ?? persona). */}
      {selected === null && !state.importPayload && (
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
              Used to seed the agent&apos;s AGENTS.md and kick off the Coach&apos;s first-turn draft.
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

      {/* Import from JSON — loading a config sets importPayload and clears any
          selected persona (the file supplies claudeMd + skills). */}
      <ImportConfigPicker
        value={state.importPayload}
        onChange={p => update({ importPayload: p, ...(p ? { selectedPersona: null } : {}) })}
      />
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

const SUGGESTED_TAGS = ['Engineering', 'Product', 'Infra', 'Security', 'Customer Success', 'Data', 'Marketing', 'Operations'];

function TagInputWizard({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const suggestions = SUGGESTED_TAGS.filter(t => t.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t));
  const add = (tag: string) => { const t = tag.trim(); if (t && !tags.includes(t)) onChange([...tags, t]); setInput(''); };
  const remove = (tag: string) => onChange(tags.filter(t => t !== tag));
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && input.trim()) { e.preventDefault(); add(input); }
    if (e.key === 'Backspace' && !input && tags.length) remove(tags[tags.length - 1]);
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 6 }}>Tags <span style={{ fontWeight: 400 }}>(optional)</span></label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', background: 'var(--surface)', minHeight: 38 }}>
        {tags.map(tag => (
          <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(59,130,246,0.12)', color: '#3b82f6', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 500 }}>
            {tag}
            <button onClick={() => remove(tag)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: 'inherit', opacity: 0.7 }}>×</button>
          </span>
        ))}
        <div style={{ position: 'relative', flex: 1, minWidth: 80 }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKey}
            onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)}
            placeholder={tags.length === 0 ? 'e.g. Engineering, Data...' : ''}
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: 'var(--text)', width: '100%', padding: 0 }} />
          {focused && (input || suggestions.length > 0) && (
            <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 50, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 180, maxHeight: 200, overflowY: 'auto' }}>
              {suggestions.map(s => (
                <div key={s} onMouseDown={() => add(s)} style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--text)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>{s}</div>
              ))}
              {input.trim() && !tags.includes(input.trim()) && !suggestions.includes(input.trim()) && (
                <div onMouseDown={() => add(input)} style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: '#3b82f6' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  Add &ldquo;{input.trim()}&rdquo;
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h2 style={{ margin: '0 0 3px', fontSize: 16, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>
        {title}
      </h2>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{desc}</p>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, hint, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; hint?: React.ReactNode; type?: string;
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

