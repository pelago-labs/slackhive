'use client';

/**
 * @fileoverview 5-step agent onboarding wizard.
 *
 * Steps: Identity → Slack App → Tokens → MCPs & Skills → Review
 *
 * Route: /agents/new
 * @module web/app/agents/new
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Agent, McpServer } from '@slackhive/shared';
import { generateSlackManifest } from '@/lib/slack-manifest';

// ─── State ────────────────────────────────────────────────────────────────────

interface WizardState {
  name: string; slug: string; description: string; persona: string;
  model: string; isBoss: boolean;
  reportsToIds: string[];
  slackBotToken: string; slackAppToken: string; slackSigningSecret: string;
  mcpServerIds: string[];
  skillTemplate: 'blank' | 'data-analyst' | 'writer' | 'developer';
}

const INITIAL: WizardState = {
  name: '', slug: '', description: '', persona: '',
  model: 'claude-opus-4-6', isBoss: false,
  reportsToIds: [],
  slackBotToken: '', slackAppToken: '', slackSigningSecret: '',
  mcpServerIds: [], skillTemplate: 'blank',
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

  // Boss agents skip the MCPs & Skills step (their CLAUDE.md is auto-generated)
  const totalSteps = state.isBoss ? 4 : 5;
  const stepLabels = state.isBoss
    ? ['Identity', 'Slack App', 'Tokens', 'Review']
    : ['Identity', 'Slack App', 'Tokens', 'MCPs & Skills', 'Review'];

  const next = () => setStep(s => Math.min(s + 1, totalSteps - 1));
  const back = () => setStep(s => Math.max(s - 1, 0));

  const canNext = () => {
    if (step === 0) return !!(state.name && state.slug);
    if (step === 2) return !!(state.slackBotToken && state.slackAppToken && state.slackSigningSecret);
    return true;
  };

  const submit = async () => {
    setSubmitting(true); setError('');
    try {
      const r = await fetch('/api/agents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...state,
          reportsTo: state.isBoss ? [] : state.reportsToIds,
        }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? 'Failed to create agent'); return; }
      router.push(`/agents/${data.slug}`);
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
      <div style={{ flex: 1, display: 'flex', padding: '40px 36px', gap: 40, maxWidth: 900, margin: '0 auto', width: '100%' }}>

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
                               'var(--border)',
                  color: i < step ? '#fff' :
                         i === step ? 'var(--accent)' :
                         'var(--subtle)',
                  border: i === step ? '1.5px solid var(--accent)' : '1.5px solid transparent',
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
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 14, padding: '32px',
            }}
            className="fade-up"
            key={step}
          >
            {step === 0 && <Step1Identity state={state} update={update} bosses={bosses} />}
            {step === 1 && <Step2SlackApp state={state} />}
            {step === 2 && <Step3Tokens state={state} update={update} />}
            {step === 3 && !state.isBoss && <Step4McpsSkills state={state} update={update} catalog={catalog} />}
            {((step === 3 && state.isBoss) || step === 4) && <Step5Review state={state} catalog={catalog} agents={agents} />}
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
                border: '1px solid var(--border)', borderRadius: 8,
                padding: '9px 20px', fontSize: 13, cursor: step === 0 ? 'not-allowed' : 'pointer',
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
                  color: '#fff', border: 'none', borderRadius: 8,
                  padding: '9px 24px', fontSize: 13, fontWeight: 500,
                  cursor: canNext() ? 'pointer' : 'not-allowed',
                  fontFamily: 'var(--font-sans)', transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => { if (canNext()) (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
              >Next →</button>
            ) : (
              <button
                onClick={submit}
                disabled={submitting || !state.slackBotToken || !state.slackAppToken || !state.slackSigningSecret}
                style={{
                  background: submitting ? 'var(--border)' : '#16a34a',
                  color: '#fff', border: 'none', borderRadius: 8,
                  padding: '9px 24px', fontSize: 13, fontWeight: 600,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  fontFamily: 'var(--font-sans)', transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => { if (!submitting) (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
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
      <StepHeader step={1} title="Agent Identity" desc="Define who this agent is and what it specializes in." />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <Field label="Agent Name *" value={state.name} placeholder="e.g. GILFOYLE"
          onChange={v => update({ name: v, slug: autoSlug(v) })} />
        <Field label="Slug *" value={state.slug} placeholder="e.g. gilfoyle"
          hint="Lowercase, hyphens only"
          onChange={v => update({ slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
      </div>
      <Field label="Description" value={state.description} placeholder="Data warehouse NLQ, Redshift queries, business metrics"
        hint="Used by the boss to decide when to delegate here."
        onChange={v => update({ description: v })} />
      <TextArea label="Persona" value={state.persona}
        placeholder="You are GILFOYLE, a cynical but brilliant data engineer…"
        hint="Injected into CLAUDE.md as the agent's identity and personality."
        rows={3} onChange={v => update({ persona: v })} />

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
      <StepHeader step={2} title="Create Slack App" desc="Use this manifest to create a new Slack app. Takes about 2 minutes." />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        {[
          { n: 1, text: <>Go to <strong style={{ color: 'var(--text)' }}>api.slack.com/apps</strong> → <strong style={{ color: 'var(--text)' }}>Create New App</strong></> },
          { n: 2, text: <>Choose <strong style={{ color: 'var(--text)' }}>From an app manifest</strong> and select your workspace</> },
          { n: 3, text: <>Paste the JSON manifest below and click <strong style={{ color: 'var(--text)' }}>Next → Create</strong></> },
          { n: 4, text: <>Go to <strong style={{ color: 'var(--text)' }}>Install App</strong> → Install to workspace. Then collect tokens in the next step.</> },
        ].map(({ n, text }) => (
          <div key={n} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              background: 'rgba(59,130,246,0.15)', color: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
            }}>{n}</div>
            <span style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, paddingTop: 2 }}>{text}</span>
          </div>
        ))}
      </div>

      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)',
        }}>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
            {state.name || 'agent'}-manifest.json
          </span>
          <button onClick={copy} style={{
            background: copied ? '#dcfce7' : 'none',
            color: copied ? '#16a34a' : 'var(--accent)',
            border: 'none', cursor: 'pointer', fontSize: 12,
            fontFamily: 'var(--font-sans)', padding: '2px 8px', borderRadius: 4,
            transition: 'all 0.15s',
          }}>{copied ? '✓ Copied' : 'Copy'}</button>
        </div>
        <pre style={{
          margin: 0, padding: '16px', fontSize: 11.5, color: 'var(--accent)',
          fontFamily: 'var(--font-mono)', overflow: 'auto', maxHeight: 280, lineHeight: 1.6,
        }}>{manifest}</pre>
      </div>
    </div>
  );
}

// ─── Step 3: Tokens ───────────────────────────────────────────────────────────

function Step3Tokens({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
  return (
    <div>
      <StepHeader step={3} title="Slack Credentials" desc="Find these in your Slack app settings after installing to workspace." />

      <div style={{
        background: '#eff6ff', border: '1px solid #bfdbfe',
        borderRadius: 8, padding: '12px 14px', marginBottom: 18, fontSize: 12, color: '#1e40af',
        lineHeight: 1.85,
      }}>
        <div>
          <strong>Bot Token (xoxb-…)</strong> →{' '}
          <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb' }}>api.slack.com/apps</a>
          {' '}→ your app → <strong>OAuth &amp; Permissions</strong> → <em>Bot User OAuth Token</em>
        </div>
        <div>
          <strong>App-Level Token (xapp-…)</strong> → <strong>Basic Information</strong> → <em>App-Level Tokens</em> → Generate with scope{' '}
          <code style={{ fontFamily: 'var(--font-mono)', background: '#dbeafe', padding: '0 4px', borderRadius: 3 }}>connections:write</code>
        </div>
        <div>
          <strong>Signing Secret</strong> → <strong>Basic Information</strong> → <em>App Credentials</em> → Signing Secret
        </div>
      </div>

      <Field label="Bot Token *" value={state.slackBotToken} placeholder="xoxb-..."
        type="password" onChange={v => update({ slackBotToken: v })} />
      <Field label="App-Level Token *" value={state.slackAppToken} placeholder="xapp-..."
        type="password" onChange={v => update({ slackAppToken: v })} />
      <Field label="Signing Secret *" value={state.slackSigningSecret} placeholder="abc123def..."
        type="password" onChange={v => update({ slackSigningSecret: v })} />
    </div>
  );
}

// ─── Step 4: MCPs & Skills ────────────────────────────────────────────────────

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
      <StepHeader step={4} title="MCPs & Skills" desc="Choose MCP servers and a starting skill template." />

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

      {/* Template grid */}
      <div>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Skill Template
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {TEMPLATES.map(t => {
            const active = state.skillTemplate === t.value;
            return (
              <label key={t.value} style={{
                padding: '12px 14px', border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 8, cursor: 'pointer',
                background: active ? 'rgba(59,130,246,0.08)' : 'transparent',
                transition: 'all 0.15s',
              }}>
                <input type="radio" name="template" value={t.value} checked={active}
                  onChange={() => update({ skillTemplate: t.value as WizardState['skillTemplate'] })}
                  style={{ display: 'none' }} />
                <div style={{ fontSize: 13, fontWeight: 600, color: active ? 'var(--accent)' : 'var(--text)', marginBottom: 2 }}>
                  {t.label}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--subtle)' }}>{t.desc}</div>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Step 5: Review ───────────────────────────────────────────────────────────

function Step5Review({ state, catalog, agents }: { state: WizardState; catalog: McpServer[]; agents: Agent[] }) {
  const assignedBosses = agents.filter(a => state.reportsToIds.includes(a.id));
  const assignedMcps = catalog.filter(m => state.mcpServerIds.includes(m.id));
  const template = TEMPLATES.find(t => t.value === state.skillTemplate)?.label ?? state.skillTemplate;

  const reportsToValue = state.isBoss
    ? '—'
    : assignedBosses.length > 0
      ? assignedBosses.map(b => b.name).join(', ')
      : 'None';

  return (
    <div>
      <StepHeader step={state.isBoss ? 4 : 5} title="Review & Create" desc="Everything looks good? Hit Create Agent to launch." />

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
        borderRadius: 8, padding: '12px 14px', fontSize: 12.5, color: '#15803d', lineHeight: 1.6,
      }}>
        After creation, the runner will automatically pick up the new agent and connect it to Slack via Socket Mode.
        You can manage skills, MCPs, and permissions from the agent detail page.
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
          width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 7, padding: '8px 12px', color: 'var(--text)',
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
          width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 7, padding: '8px 12px', color: 'var(--text)',
          fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none', resize: 'vertical',
          transition: 'border-color 0.15s', lineHeight: 1.55,
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
      />
      {hint && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>{hint}</p>}
    </div>
  );
}
