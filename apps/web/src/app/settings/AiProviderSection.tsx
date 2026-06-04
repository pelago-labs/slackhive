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
  detected?: Record<string, { detected: boolean; source: string }>;
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
  const [showFields, setShowFields] = useState<Record<string, boolean>>({});
  const [authModes, setAuthModes] = useState<Record<string, string>>({});
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [connStatus, setConnStatus] = useState<{ label?: string; status: string } | null>(null);
  const [detecting, setDetecting] = useState(false);

  const loadStatus = () => {
    fetch('/api/system/backend-status').then(r => r.ok ? r.json() : null).then(s => s && setConnStatus(s)).catch(() => {});
  };

  // Re-fetch backend descriptors + credential detection (re-runs the server-side
  // Keychain/file scan). Used on mount and by the "Detect" button after a login.
  const loadBackends = async (init = false) => {
    try {
      const d: ApiResponse = await fetch('/api/system/backends', { cache: 'no-store' }).then(r => r.json());
      setData(d);
      if (init) {
        setBackend(d.current.backend);
        setExpandedId(d.current.backend);
        setAuthModes({ claude: d.current.claudeAuthMode, codex: d.current.codexAuthMode });
      }
    } catch { /* ignore */ }
  };

  const detect = async () => {
    setDetecting(true);
    try { await Promise.all([loadBackends(), Promise.resolve(loadStatus())]); }
    finally { setTimeout(() => setDetecting(false), 400); }
  };

  useEffect(() => {
    loadBackends(true);
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

  // Auth config body for one backend card. Detect-first: if the CLI login is
  // already present we just confirm it; otherwise tell the user to log in from
  // the terminal, with paste/API-key tucked under an "Advanced" toggle.
  const renderAuthConfig = (d: BackendDescriptor) => {
    const mode = authModes[d.id] ?? d.authOptions[0]?.mode;
    const activeAuth = d.authOptions.find(o => o.mode === mode) ?? d.authOptions[0];
    const det = data.detected?.[d.id];
    const isDetected = !!det?.detected;
    const loginCmd = d.id === 'codex' ? 'codex login' : 'claude login';
    const sourceText =
      det?.source === 'login' ? `your ${d.label} login`
      : det?.source === 'file' ? `your ${d.label} login file`
      : det?.source === 'env' ? 'an environment variable'
      : det?.source === 'settings' ? 'pasted credentials'
      : 'your login';
    const showAdv = showFields[d.id];

    const codeChip: React.CSSProperties = { fontFamily: 'var(--font-mono, monospace)', fontSize: 12.5, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', display: 'inline-block', color: 'var(--text)', userSelect: 'all' };

    const credentialFields = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
        <div>
          <label style={labelStyle}>Authentication</label>
          <select style={{ ...controlStyle, cursor: 'pointer' }} value={mode} onChange={e => setAuthModes(m => ({ ...m, [d.id]: e.target.value }))}>
            {d.authOptions.map(o => <option key={o.mode} value={o.mode}>{o.label}</option>)}
          </select>
          {activeAuth?.hint && <p style={hintStyle}>{activeAuth.hint}</p>}
        </div>
        {activeAuth?.fields.map(field => {
          const isSet = data.secretsSet[field.secretKey];
          const val = secretInputs[field.secretKey] ?? '';
          return (
            <div key={field.secretKey}>
              <label style={labelStyle}>
                {field.label}{isSet && !val ? <span style={{ color: 'var(--accent)', marginLeft: 6 }}>✓ saved</span> : ''}
              </label>
              {field.kind === 'json' ? (
                <textarea style={{ ...controlStyle, minHeight: 90, fontFamily: 'var(--font-mono, monospace)', resize: 'vertical' }}
                  placeholder={isSet ? '•••••• (saved — paste to replace)' : field.placeholder}
                  value={val} onChange={e => setSecretInputs(s => ({ ...s, [field.secretKey]: e.target.value }))} />
              ) : (
                <input type="password" style={controlStyle}
                  placeholder={isSet ? '•••••• (saved — type to replace)' : field.placeholder}
                  value={val} onChange={e => setSecretInputs(s => ({ ...s, [field.secretKey]: e.target.value }))} />
              )}
            </div>
          );
        })}
      </div>
    );

    return (
      <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 14 }}>
        {isDetected ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', flexShrink: 0 }} />
            Connected — using {sourceText}.
          </div>
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', background: 'var(--surface)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>Log in from your terminal</div>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
              Run this once on the machine running SlackHive, then click Detect:
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <code style={codeChip}>{loginCmd}</code>
              <button onClick={detect} disabled={detecting} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 7, padding: '6px 12px', fontSize: 12.5, fontWeight: 500,
                cursor: detecting ? 'default' : 'pointer', fontFamily: 'var(--font-sans)',
              }}>{detecting ? 'Detecting…' : 'Detect login'}</button>
            </div>
            <p style={{ ...hintStyle, marginTop: 10 }}>
              No {d.label} installed (or running on a remote box)? Use <strong>Advanced</strong> below to paste credentials or an API key.
            </p>
          </div>
        )}

        <button onClick={() => setShowFields(s => ({ ...s, [d.id]: !s[d.id] }))} style={{
          alignSelf: 'flex-start', marginTop: 10, background: 'none', border: 'none', padding: 0,
          color: 'var(--muted)', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-sans)', textDecoration: 'underline', textUnderlineOffset: 3,
        }}>
          {showAdv ? 'Hide advanced' : isDetected ? 'Replace credentials' : 'Advanced — paste credentials / API key'}
        </button>

        {showAdv && credentialFields}
      </div>
    );
  };

  return (
    <div style={{ marginBottom: 22, paddingBottom: 22, borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Agent Backend
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {toast && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{toast}</span>}
          <button onClick={save} disabled={saving} style={{
            background: saving ? 'var(--border)' : 'var(--accent)', color: 'var(--accent-fg)',
            border: 'none', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 500,
            cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)',
          }}>{saving ? 'Saving…' : 'Save Backend'}</button>
        </div>
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
      </div>
    </div>
  );
}
