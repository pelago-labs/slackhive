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
import { PERSONA_CATALOG, searchPersonas } from '@slackhive/shared/personas';
import { DEFAULT_AGENT_MODEL } from '@slackhive/shared/models';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

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

  const cardClass = 'rounded-lg border border-border bg-card px-6 py-6 shadow-sm';

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border bg-card px-6 py-3.5">
        <a href="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline">
          <ArrowLeft size={14} /> Agents
        </a>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-6 pb-32 pt-11">
        <div className="fade-up mx-auto max-w-[660px]">
          {/* Hero */}
          <div className="mb-6">
            <h1 className="m-0 text-2xl font-bold tracking-tight text-foreground">Create a new agent</h1>
            <p className="mt-1.5 text-base leading-relaxed text-muted-foreground">
              Name it and shape its role. You&apos;ll connect Slack and add tools right after — it takes under a minute.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <div className={cardClass}>
              <Step1Identity state={state} update={update} bosses={bosses} />
            </div>
            {!state.isBoss && (
              <div className={cardClass}>
                <Step2Persona state={state} update={update} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sticky action bar */}
      <div className="sticky bottom-0 border-t border-border bg-card/90 px-6 py-3.5 backdrop-blur">
        <div className="mx-auto flex max-w-[660px] items-center gap-4">
          <span className={cn('min-w-0 flex-1 text-xs leading-snug', error ? 'text-destructive' : 'text-muted-foreground')}>
            {error || 'Slack, tools, model & permissions are configured after creation.'}
          </span>
          <Button
            onClick={submit}
            disabled={submitting || !canCreate}
            className="shrink-0"
          >{submitting ? 'Creating…' : 'Create agent'}</Button>
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
        hint={state.slug ? <>URL: <code className="font-mono text-2xs">/agents/{state.slug}</code></> : undefined} />

      {/* Role — two selectable cards */}
      <div className="mb-3.5">
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Role</label>
        <div className="grid grid-cols-2 gap-2.5">
          {[
            { boss: false, title: 'Specialist', desc: 'Does the work. Can report to a boss.' },
            { boss: true,  title: 'Boss',       desc: 'Orchestrates specialists. Brain auto-written.' },
          ].map(opt => {
            const active = state.isBoss === opt.boss;
            return (
              <button key={opt.title} type="button"
                onClick={() => update({ isBoss: opt.boss, reportsToIds: [] })}
                className={cn(
                  'cursor-pointer rounded-md border-[1.5px] px-3.5 py-3 text-left transition-colors',
                  active ? 'border-primary bg-primary/[0.08]' : 'border-border bg-card hover:border-input',
                )}
              >
                <div className="mb-0.5 flex items-center gap-1.5">
                  <span className={cn('text-sm font-semibold', active ? 'text-primary' : 'text-foreground')}>{opt.title}</span>
                  {active && <Check size={13} className="text-primary" />}
                </div>
                <div className="text-2xs leading-snug text-muted-foreground">{opt.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Reports to — multi-select boss agents (only shown for non-boss agents) */}
      {!state.isBoss && (
        <div className="mb-3.5">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Reports to
          </label>
          {bosses.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3.5 py-3 text-xs text-muted-foreground">
              No boss agents yet — create a boss first, or mark this agent as a boss above.
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-border">
              {bosses.map((boss, i) => (
                <label key={boss.id} className={cn(
                  'flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors',
                  i < bosses.length - 1 && 'border-b border-border',
                  state.reportsToIds.includes(boss.id) ? 'bg-blue/[0.06]' : 'bg-transparent',
                )}>
                  <input type="checkbox"
                    checked={state.reportsToIds.includes(boss.id)}
                    onChange={() => toggleBoss(boss.id)}
                    className="h-3.5 w-3.5 accent-primary" />
                  <span className="text-sm text-foreground">{boss.name}</span>
                </label>
              ))}
            </div>
          )}
          {state.reportsToIds.length > 0 && (
            <p className="mt-1.5 text-2xs text-muted-foreground">
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
    <div className={cn(
      'mt-5 rounded-md border-[1.5px] border-dashed px-4 py-3.5 transition-colors',
      value ? 'border-[#8b5cf6] bg-[#8b5cf6]/[0.03]' : 'border-input bg-card',
    )}>
      {!value ? (
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="mb-0.5 text-sm font-medium text-foreground">
              Import from existing config
            </div>
            <div className="text-xs text-muted-foreground">
              Load AGENTS.md + skills from a previously exported agent
            </div>
            {error && <div className="mt-1 text-2xs text-destructive">{error}</div>}
          </div>
          <button type="button" onClick={() => ref.current?.click()}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-[1.5px] border-input bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-[#8b5cf6] hover:text-foreground"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v9M4 7l4 4 4-4M2 13h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Choose file
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#8b5cf6]/10">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6L9 2z" stroke="#8b5cf6" strokeWidth="1.4" strokeLinejoin="round"/>
                <path d="M9 2v4h4" stroke="#8b5cf6" strokeWidth="1.4" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">
                Config file loaded
              </div>
              <div className="text-2xs text-muted-foreground">
                {value.skills.length} skill{value.skills.length !== 1 ? 's' : ''} · AGENTS.md included
                {value.exportedAt && ` · ${new Date(value.exportedAt).toLocaleDateString()}`}
              </div>
            </div>
          </div>
          <button type="button" onClick={() => { onChange(null); setError(''); }}
            className="cursor-pointer rounded-sm border-none bg-transparent px-2 py-1 text-2xs text-muted-foreground"
          >Remove</button>
        </div>
      )}
      <input ref={ref} type="file" accept=".json" className="hidden" onChange={handleFile} />
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
      <div className="mb-2.5">
        <div className="relative mb-2.5">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text" placeholder="Search personas…" value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-auto bg-secondary py-2 pl-[30px] pr-2.5 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PERSONA_CATEGORY_LABELS.map(([val, label]) => {
            const active = category === val;
            return (
              <button key={val} onClick={() => setCategory(val)}
                className={cn(
                  'cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors',
                  active ? 'border-primary bg-blue/10 font-semibold text-primary' : 'border-border bg-transparent font-normal text-muted-foreground',
                )}
              >{label}</button>
            );
          })}
        </div>
      </div>

      {/* Card grid */}
      <div className="grid max-h-[290px] grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 overflow-y-auto pr-0.5">
        {/* Blank card — always first */}
        {(() => {
          const isBlank = selected === null;
          return (
            <div
              onClick={() => update({ selectedPersona: null, importPayload: null })}
              className={cn(
                'relative cursor-pointer rounded-md border-[1.5px] px-3 py-3 transition-colors',
                isBlank ? 'border-input bg-secondary' : 'border-border bg-transparent hover:border-input',
              )}
            >
              {isBlank && (
                <div className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-muted-foreground">
                  <Check size={10} color="#fff" strokeWidth={3} />
                </div>
              )}
              <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">generic</div>
              <div className="mb-1 text-sm font-semibold leading-tight text-foreground">Blank</div>
              <div className="text-2xs leading-snug text-muted-foreground">No persona, no skills — start from scratch</div>
              <div className="mt-1.5 text-2xs text-muted-foreground">0 skills</div>
            </div>
          );
        })()}
        {filtered.map(p => {
          const isSelected = selected?.id === p.id;
          const catColor = PERSONA_CATEGORY_COLORS[p.category] ?? '#6b7280';
          return (
            <div key={p.id}
              onClick={() => update({ selectedPersona: isSelected ? null : p, importPayload: null })}
              className={cn(
                'relative cursor-pointer rounded-md border-[1.5px] px-3 py-3 transition-colors',
                isSelected ? '' : 'border-border bg-secondary hover:border-input',
              )}
              style={isSelected ? { borderColor: catColor, background: `${catColor}12` } : undefined}
            >
              {isSelected && (
                <div className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full"
                  style={{ background: catColor }}>
                  <Check size={10} color="#fff" strokeWidth={3} />
                </div>
              )}
              <div className="mb-1.5 inline-block text-2xs font-semibold uppercase tracking-[0.05em]"
                style={{ color: catColor }}>{p.category}</div>
              <div className="mb-1 text-sm font-semibold leading-tight text-foreground">{p.name}</div>
              <div className="overflow-hidden text-2xs leading-snug text-muted-foreground [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [display:-webkit-box]">{p.cardDescription}</div>
              <div className="mt-1.5 text-2xs text-muted-foreground">
                {p.skills.length} skills
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {state.importPayload
          ? <><span className="font-medium text-foreground">Imported config</span> — persona &amp; description come from the file</>
          : selected
            ? <><span className="font-medium text-foreground">{selected.name}</span> selected</>
            : 'Blank selected — describe the agent below'}
      </p>

      {/* When "Blank" is picked (and not importing) there's no template to supply
          description/persona. Description is required so the agent has an identity
          AND so Coach bootstrap has a seed (see submit() — seed = description ?? persona). */}
      {selected === null && !state.importPayload && (
        <div className="mt-3.5 grid gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Description <span className="text-primary">*</span>
            </label>
            <Textarea
              value={state.description}
              onChange={e => update({ description: e.target.value })}
              placeholder="What does this agent do in one sentence? (e.g. 'Daily team birthday reminders in #general')"
              rows={2}
              className="resize-y bg-secondary text-sm leading-normal"
            />
            <p className="mt-1 text-2xs text-muted-foreground">
              Used to seed the agent&apos;s AGENTS.md and kick off the Coach&apos;s first-turn draft.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Persona <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              value={state.persona}
              onChange={e => update({ persona: e.target.value })}
              placeholder="Tone / voice / how it should speak. Leave blank and the Coach will draft one."
              rows={2}
              className="resize-y bg-secondary text-sm leading-normal"
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
    <div className="mb-3.5">
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Tags <span className="font-normal">(optional)</span></label>
      <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-blue/[0.12] px-2 py-0.5 text-xs font-medium text-blue">
            {tag}
            <button onClick={() => remove(tag)} className="cursor-pointer border-none bg-transparent p-0 leading-none text-inherit opacity-70">×</button>
          </span>
        ))}
        <div className="relative min-w-[80px] flex-1">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKey}
            onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)}
            placeholder={tags.length === 0 ? 'e.g. Engineering, Data...' : ''}
            className="w-full border-none bg-transparent p-0 text-sm text-foreground outline-none" />
          {focused && (input || suggestions.length > 0) && (
            <div className="absolute left-0 top-full z-50 mt-1 max-h-[200px] min-w-[180px] overflow-y-auto rounded-md border border-border bg-card shadow-md">
              {suggestions.map(s => (
                <div key={s} onMouseDown={() => add(s)} className="cursor-pointer px-3 py-2 text-sm text-foreground hover:bg-secondary">{s}</div>
              ))}
              {input.trim() && !tags.includes(input.trim()) && !suggestions.includes(input.trim()) && (
                <div onMouseDown={() => add(input)} className="cursor-pointer px-3 py-2 text-sm text-blue hover:bg-secondary">
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
    <div className="mb-4">
      <h2 className="m-0 mb-1 text-md font-bold tracking-tight text-foreground">
        {title}
      </h2>
      <p className="m-0 text-xs leading-normal text-muted-foreground">{desc}</p>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, hint, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; hint?: React.ReactNode; type?: string;
}) {
  return (
    <div className="mb-3.5">
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="h-auto bg-secondary px-3.5 py-2.5 text-base" />
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
