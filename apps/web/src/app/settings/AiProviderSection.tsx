'use client';

/**
 * @fileoverview Settings → AI Provider. Renders entirely from the backend
 * registry descriptors (`GET /api/system/backends`) so new backends/presets need
 * no UI changes. Lets the operator pick the global agent backend (Claude Code /
 * Codex), its model, auth mode, and credentials — replacing `slackhive init` auth.
 */

import { useEffect, useState } from 'react';
import type { BackendDescriptor } from '@slackhive/shared';

interface ApiResponse {
  descriptors: BackendDescriptor[];
  current: { backend: string; codexModel: string; claudeAuthMode: string; codexAuthMode: string };
  secretsSet: Record<string, boolean>;
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 } as const;
const controlStyle = {
  width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 7, padding: '8px 11px', color: 'var(--text)', fontSize: 13,
  fontFamily: 'var(--font-sans)', outline: 'none', boxSizing: 'border-box' as const,
};
const hintStyle = { margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' } as const;

export default function AiProviderSection() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [backend, setBackend] = useState('claude');
  const [codexModel, setCodexModel] = useState('');
  const [authModes, setAuthModes] = useState<Record<string, string>>({});
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    fetch('/api/system/backends').then(r => r.json()).then((d: ApiResponse) => {
      setData(d);
      setBackend(d.current.backend);
      setCodexModel(d.current.codexModel);
      setAuthModes({ claude: d.current.claudeAuthMode, codex: d.current.codexAuthMode });
    }).catch(() => {});
  }, []);

  if (!data) return null;

  const descriptor = data.descriptors.find(d => d.id === backend) ?? data.descriptors[0];
  const authMode = authModes[descriptor.id] ?? descriptor.authOptions[0]?.mode;
  const activeAuth = descriptor.authOptions.find(o => o.mode === authMode) ?? descriptor.authOptions[0];

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
          codexModel,
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
    } catch {
      setToast('Save failed');
    } finally {
      setSaving(false);
      setTimeout(() => setToast(''), 3000);
    }
  }

  return (
    <div style={{ marginBottom: 22, paddingBottom: 22, borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 14 }}>
        Agent Backend
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Backend */}
        <div>
          <label style={labelStyle}>Backend</label>
          <select style={{ ...controlStyle, cursor: 'pointer' }} value={backend} onChange={e => setBackend(e.target.value)}>
            {data.descriptors.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <p style={hintStyle}>The runtime all agents run on. Switching reloads every agent.</p>
        </div>

        {/* Model (only when the backend has its own model setting, e.g. Codex) */}
        {descriptor.modelSettingKey && descriptor.models.length > 0 && (
          <div>
            <label style={labelStyle}>Model</label>
            <select style={{ ...controlStyle, cursor: 'pointer' }} value={codexModel} onChange={e => setCodexModel(e.target.value)}>
              {descriptor.models.map(m => <option key={m.value} value={m.value}>{m.label}{m.sub ? ` — ${m.sub}` : ''}</option>)}
            </select>
          </div>
        )}

        {/* Auth mode */}
        <div>
          <label style={labelStyle}>Authentication</label>
          <select
            style={{ ...controlStyle, cursor: 'pointer' }}
            value={authMode}
            onChange={e => setAuthModes(m => ({ ...m, [descriptor.id]: e.target.value }))}
          >
            {descriptor.authOptions.map(o => <option key={o.mode} value={o.mode}>{o.label}</option>)}
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
