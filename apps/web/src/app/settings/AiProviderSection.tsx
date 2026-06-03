'use client';

/**
 * @fileoverview Settings → AI Provider. Renders entirely from the backend
 * registry descriptors (`GET /api/system/backends`) so new backends/presets need
 * no UI changes. Lets the operator pick the global agent backend (Claude Code /
 * Codex), its model, auth mode, and credentials — replacing `slackhive init` auth.
 */

import { useEffect, useState } from 'react';
import type { BackendDescriptor } from '@slackhive/shared';
import { ChevronDown, Check } from 'lucide-react';

interface ApiResponse {
  descriptors: BackendDescriptor[];
  current: { backend: string; claudeAuthMode: string; codexAuthMode: string };
  secretsSet: Record<string, boolean>;
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 } as const;
const controlStyle = {
  width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 7, padding: '8px 11px', color: 'var(--text)', fontSize: 13,
  fontFamily: 'var(--font-sans)', outline: 'none', boxSizing: 'border-box' as const,
};
const hintStyle = { margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' } as const;

export default function AiProviderSection({ onSaved }: { onSaved?: () => void } = {}) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [backend, setBackend] = useState('claude');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [authModes, setAuthModes] = useState<Record<string, string>>({});
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [connStatus, setConnStatus] = useState<{ label?: string; status: string } | null>(null);

  const loadStatus = () => {
    fetch('/api/system/backend-status').then(r => r.ok ? r.json() : null).then(s => s && setConnStatus(s)).catch(() => {});
  };

  useEffect(() => {
    fetch('/api/system/backends').then(r => r.json()).then((d: ApiResponse) => {
      setData(d);
      setBackend(d.current.backend);
      setExpandedId(d.current.backend);
      setAuthModes({ claude: d.current.claudeAuthMode, codex: d.current.codexAuthMode });
    }).catch(() => {});
    loadStatus();
  }, []);

  if (!data) return null;

  async function save() {
    setSaving(true);
    try {
      const secrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(secretInputs)) if (v.trim()) secrets[k] = v;
      const res = await fetch('/api/system/backends', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backend,
          claudeAuthMode: authModes.claude,
          codexAuthMode: authModes.codex,
          secrets,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      setSecretInputs({});
      // reflect newly-set secrets without a refetch
      setData(d => d ? { ...d, secretsSet: { ...d.secretsSet, ...Object.fromEntries(Object.keys(secrets).map(k => [k, !!secrets[k]])) } } : d);
      setToast('Saved — agents reloading');
      loadStatus();
      onSaved?.(); // let the parent (AI tab) refresh coach model / dependent state
    } catch {
      setToast('Save failed');
    } finally {
      setSaving(false);
      setTimeout(() => setToast(''), 3000);
    }
  }

  // Auth config body for one backend card (auth mode + connect + credentials).
  const renderAuthConfig = (d: BackendDescriptor) => {
    const mode = authModes[d.id] ?? d.authOptions[0]?.mode;
    const activeAuth = d.authOptions.find(o => o.mode === mode) ?? d.authOptions[0];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 14 }}>
        <div>
          <label style={labelStyle}>Authentication</label>
          <select
            style={{ ...controlStyle, cursor: 'pointer' }}
            value={mode}
            onChange={e => setAuthModes(m => ({ ...m, [d.id]: e.target.value }))}
          >
            {d.authOptions.map(o => <option key={o.mode} value={o.mode}>{o.label}</option>)}
          </select>
          {activeAuth?.hint && <p style={hintStyle}>{activeAuth.hint}</p>}
        </div>

        {/* Credential fields for the selected auth mode */}
        {activeAuth?.fields.map(field => {
          const isSet = data.secretsSet[field.secretKey];
          const val = secretInputs[field.secretKey] ?? '';
          return (
            <div key={field.secretKey}>
              <label style={labelStyle}>
                {field.label}{isSet && !val ? <span style={{ color: 'var(--accent)', marginLeft: 6 }}>✓ saved</span> : ''}
              </label>
              {field.kind === 'json' ? (
                <textarea
                  style={{ ...controlStyle, minHeight: 90, fontFamily: 'var(--font-mono, monospace)', resize: 'vertical' }}
                  placeholder={isSet ? '•••••• (saved — paste to replace)' : field.placeholder}
                  value={val}
                  onChange={e => setSecretInputs(s => ({ ...s, [field.secretKey]: e.target.value }))}
                />
              ) : (
                <input
                  type="password"
                  style={controlStyle}
                  placeholder={isSet ? '•••••• (saved — type to replace)' : field.placeholder}
                  value={val}
                  onChange={e => setSecretInputs(s => ({ ...s, [field.secretKey]: e.target.value }))}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ marginBottom: 22, paddingBottom: 22, borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
        Agent Backend
      </div>
      <p style={{ ...hintStyle, marginBottom: 14 }}>The runtime all agents run on — only one is active at a time. Switching reloads every agent. Model is chosen per agent on each agent&apos;s page.</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data.descriptors.map(d => {
          const isActive = backend === d.id;
          const isOpen = expandedId === d.id;
          const mode = authModes[d.id] ?? d.authOptions[0]?.mode;
          const subLabel = d.authOptions.find(o => o.mode === mode)?.label ?? '';
          return (
            <div key={d.id} style={{
              border: isActive ? '1px solid var(--border-2)' : '1px solid var(--border)',
              borderRadius: 12, background: isActive ? 'var(--surface-2)' : 'var(--surface)',
              overflow: 'hidden', transition: 'border-color .15s, background .15s',
            }}>
              <div
                onClick={() => setExpandedId(isOpen ? null : d.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', cursor: 'pointer' }}
              >
                {/* Active radio */}
                <button
                  onClick={e => { e.stopPropagation(); setBackend(d.id); setExpandedId(d.id); }}
                  aria-label={`Set ${d.label} as active backend`}
                  style={{
                    width: 18, height: 18, borderRadius: '50%', flexShrink: 0, padding: 0, cursor: 'pointer',
                    border: `2px solid ${isActive ? 'var(--accent)' : 'var(--border-2)'}`,
                    background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {isActive && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />}
                </button>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{d.label}</span>
                    {isActive && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, color: 'var(--green)', background: 'color-mix(in srgb, var(--green) 12%, transparent)', padding: '1px 7px', borderRadius: 999 }}>
                        <Check size={11} /> Active
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{subLabel}</div>
                </div>

                {isActive && connStatus && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: connStatus.status === 'connected' ? '#10b981' : connStatus.status === 'expired' ? '#f59e0b' : '#dc2626' }} />
                    {connStatus.status}
                  </span>
                )}
                <ChevronDown size={16} style={{ color: 'var(--subtle)', flexShrink: 0, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
              </div>

              {isOpen && (
                <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border)' }}>
                  {renderAuthConfig(d)}
                </div>
              )}
            </div>
          );
        })}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
          <button
            onClick={save}
            disabled={saving}
            style={{
              background: saving ? 'var(--border)' : 'var(--accent)', color: 'var(--accent-fg)',
              border: 'none', borderRadius: 7, padding: '8px 18px', fontSize: 13, fontWeight: 500,
              cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)',
            }}
          >{saving ? 'Saving...' : 'Save Backend'}</button>
          {toast && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{toast}</span>}
        </div>
      </div>
    </div>
  );
}
