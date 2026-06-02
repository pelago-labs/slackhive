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
  const [authModes, setAuthModes] = useState<Record<string, string>>({});
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [device, setDevice] = useState<{ status: string; verificationUrl?: string; userCode?: string; error?: string; output?: string } | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    fetch('/api/system/backends').then(r => r.json()).then((d: ApiResponse) => {
      setData(d);
      setBackend(d.current.backend);
      setAuthModes({ claude: d.current.claudeAuthMode, codex: d.current.codexAuthMode });
    }).catch(() => {});
  }, []);

  // Poll the device-auth login until it resolves.
  useEffect(() => {
    if (device?.status !== 'pending') return;
    const t = setInterval(async () => {
      const r = await fetch('/api/system/codex-login').then(res => res.json()).catch(() => null);
      if (!r) return;
      setDevice(r);
      if (r.status === 'connected') {
        setData(d => d ? { ...d, secretsSet: { ...d.secretsSet, CODEX_AUTH_JSON: true } } : d);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [device?.status]);

  async function startCodexLogin() {
    setConnecting(true);
    setDevice(null);
    try {
      const r = await fetch('/api/system/codex-login', { method: 'POST' }).then(res => res.json());
      setDevice(r);
    } catch {
      setDevice({ status: 'failed', error: 'Failed to start login' });
    } finally {
      setConnecting(false);
    }
  }

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
      onSaved?.(); // let the parent (AI tab) refresh coach model / dependent state
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

        <p style={{ ...hintStyle, marginTop: -4 }}>Model is chosen per agent on each agent&apos;s page.</p>

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

        {/* Codex ChatGPT device-auth: one-click web login (no host CLI / keychain). */}
        {descriptor.id === 'codex' && authMode === 'subscription' && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 7, padding: 12, background: 'var(--surface-2)' }}>
            <button
              onClick={startCodexLogin}
              disabled={connecting || device?.status === 'pending'}
              style={{
                background: device?.status === 'connected' ? '#10b981' : 'var(--accent)', color: 'var(--accent-fg)',
                border: 'none', borderRadius: 7, padding: '8px 16px', fontSize: 13, fontWeight: 500,
                cursor: connecting || device?.status === 'pending' ? 'not-allowed' : 'pointer',
              }}
            >
              {device?.status === 'connected' ? '✓ Connected to ChatGPT'
                : device?.status === 'pending' ? 'Waiting for authorization…'
                : connecting ? 'Starting…' : 'Connect ChatGPT'}
            </button>
            {device?.status === 'pending' && device.verificationUrl && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                1. Open <a href={device.verificationUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{device.verificationUrl}</a><br />
                2. Enter this code:{' '}
                {device.userCode
                  ? <strong style={{ color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', letterSpacing: 1, fontSize: 14 }}>{device.userCode}</strong>
                  : <span style={{ color: 'var(--subtle)' }}>(see terminal output below)</span>}
                <br />
                3. Approve — this updates automatically when done.
                {device.output && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--subtle)' }}>codex output (find your code here if not shown above)</summary>
                    <pre style={{ marginTop: 6, padding: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflow: 'auto' }}>{device.output}</pre>
                  </details>
                )}
              </div>
            )}
            {device?.status === 'failed' && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626', lineHeight: 1.6 }}>
                {/429|too many requests/i.test(device.error ?? '')
                  ? <>OpenAI is rate-limiting device sign-in (too many attempts). Wait ~15&nbsp;minutes and retry, or use <strong>API key</strong> auth above, or paste <strong>auth.json</strong> below (from a machine where you ran <code>codex login</code>).</>
                  : <>Login failed: {device.error}</>}
              </div>
            )}
            <p style={{ ...hintStyle, marginTop: 8 }}>Authenticates from here — no <code>codex login</code> on the host needed. Or paste auth.json below.</p>
          </div>
        )}

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
