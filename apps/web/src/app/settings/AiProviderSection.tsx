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
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface ApiResponse {
  descriptors: BackendDescriptor[];
  current: { backend: string; claudeAuthMode: string; codexAuthMode: string };
  secretsSet: Record<string, boolean>;
  // Expiry-aware per-backend credential state: connected / expired / none.
  detected?: Record<string, { status: string; source: string }>;
}

const labelClass = 'block text-xs font-medium text-muted-foreground mb-1';
const controlClass =
  'w-full bg-card border border-border rounded-md px-3 py-2 text-sm text-foreground outline-none box-border';
const hintClass = 'mt-1 text-2xs text-muted-foreground';

export default function AiProviderSection({ onSaved }: { onSaved?: () => void } = {}) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [backend, setBackend] = useState('claude');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showFields, setShowFields] = useState<Record<string, boolean>>({});
  const [authModes, setAuthModes] = useState<Record<string, string>>({});
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
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

  const disconnect = async (id: string, label: string) => {
    if (!window.confirm(`Disconnect ${label}? This clears SlackHive's saved credentials and removes its login file. Your terminal login (if any) is untouched — re-detect after logging in again.`)) return;
    await fetch('/api/system/backends', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disconnect: id }),
    }).catch(() => {});
    await detect();
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
      toast.success('Saved — agents reloading');
      loadStatus();
      loadBackends(); // re-run credential detection so the card reflects the new state
      onSaved?.(); // let the parent (AI tab) refresh coach model / dependent state
    } catch {
      toast.error('Save failed');
    } finally {
      setSaving(false);
    }
  }

  // Auth config body for one backend card. Detect-first: if the CLI login is
  // already present we just confirm it; otherwise tell the user to log in from
  // the terminal, with paste/API-key tucked under an "Advanced" toggle.
  const renderAuthConfig = (d: BackendDescriptor) => {
    const mode = authModes[d.id] ?? d.authOptions[0]?.mode;
    const activeAuth = d.authOptions.find(o => o.mode === mode) ?? d.authOptions[0];
    const det = data.detected?.[d.id];
    const detStatus = det?.status ?? 'none';
    const isDetected = detStatus === 'connected';
    const isExpired = detStatus === 'expired';
    const loginCmd = d.id === 'codex' ? 'codex login' : 'claude login';
    const sourceText =
      det?.source === 'login' ? `your ${d.label} login`
      : det?.source === 'file' ? `your ${d.label} login file`
      : det?.source === 'env' ? 'an environment variable'
      : det?.source === 'settings' ? 'pasted credentials'
      : 'your login';
    const showAdv = showFields[d.id];

    const codeChipClass = 'font-mono text-xs bg-card border border-border rounded-md px-2.5 py-1.5 inline-block text-foreground select-all';

    const credentialFields = (
      <div className="flex flex-col gap-3 mt-3 pt-3 border-t border-dashed border-border">
        <div>
          <label className={labelClass}>Authentication</label>
          <select className={cn(controlClass, 'cursor-pointer')} value={mode} onChange={e => setAuthModes(m => ({ ...m, [d.id]: e.target.value }))}>
            {d.authOptions.map(o => <option key={o.mode} value={o.mode}>{o.label}</option>)}
          </select>
          {activeAuth?.hint && <p className={hintClass}>{activeAuth.hint}</p>}
        </div>
        {activeAuth?.fields.map(field => {
          const isSet = data.secretsSet[field.secretKey];
          const val = secretInputs[field.secretKey] ?? '';
          return (
            <div key={field.secretKey}>
              <label className={labelClass}>
                {field.label}{isSet && !val ? <span className="text-primary ml-1.5">✓ saved</span> : ''}
              </label>
              {field.kind === 'json' ? (
                <textarea className={cn(controlClass, 'min-h-[90px] font-mono resize-y')}
                  placeholder={isSet ? '•••••• (saved — paste to replace)' : field.placeholder}
                  value={val} onChange={e => setSecretInputs(s => ({ ...s, [field.secretKey]: e.target.value }))} />
              ) : (
                <input type="password" className={controlClass}
                  placeholder={isSet ? '•••••• (saved — type to replace)' : field.placeholder}
                  value={val} onChange={e => setSecretInputs(s => ({ ...s, [field.secretKey]: e.target.value }))} />
              )}
            </div>
          );
        })}
      </div>
    );

    return (
      <div className="flex flex-col pt-3.5">
        {isDetected ? (
          <div className="flex items-center gap-2 text-sm text-foreground">
            <span className="w-2 h-2 rounded-full bg-green shrink-0" />
            Connected — using {sourceText}.
            <button onClick={() => disconnect(d.id, d.label)} className="ml-auto bg-transparent border-none p-0 text-red text-xs cursor-pointer">Disconnect</button>
          </div>
        ) : isExpired ? (
          <div className="border border-amber/45 rounded-lg px-4 py-3.5 bg-amber/[0.08]">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground mb-1.5">
              <span className="w-2 h-2 rounded-full bg-amber shrink-0" />
              {d.label} session expired
            </div>
            <p className="mt-0 mb-2.5 text-xs text-muted-foreground leading-normal">
              The saved login is no longer valid. Re-authenticate on the machine running SlackHive, then click Detect:
            </p>
            <div className="flex items-center gap-2.5 flex-wrap">
              <code className={codeChipClass}>{loginCmd}</code>
              <Button variant="secondary" size="sm" onClick={detect} disabled={detecting}>{detecting ? 'Detecting…' : 'Detect login'}</Button>
              <button onClick={() => disconnect(d.id, d.label)} className="ml-auto bg-transparent border-none p-0 text-red text-xs cursor-pointer">Disconnect</button>
            </div>
            <p className={cn(hintClass, 'mt-2.5')}>
              On a remote box? Use <strong>Advanced</strong> below to paste fresh credentials or an API key.
            </p>
          </div>
        ) : (
          <div className="border border-border rounded-lg px-4 py-3.5 bg-card">
            <div className="text-sm font-semibold text-foreground mb-1.5">Log in from your terminal</div>
            <p className="mt-0 mb-2.5 text-xs text-muted-foreground leading-normal">
              Run this once on the machine running SlackHive, then click Detect:
            </p>
            <div className="flex items-center gap-2.5 flex-wrap">
              <code className={codeChipClass}>{loginCmd}</code>
              <Button variant="secondary" size="sm" onClick={detect} disabled={detecting}>{detecting ? 'Detecting…' : 'Detect login'}</Button>
            </div>
            <p className={cn(hintClass, 'mt-2.5')}>
              No {d.label} installed (or running on a remote box)? Use <strong>Advanced</strong> below to paste credentials or an API key.
            </p>
          </div>
        )}

        <button onClick={() => setShowFields(s => ({ ...s, [d.id]: !s[d.id] }))} className="self-start mt-2.5 bg-transparent border-none p-0 text-muted-foreground text-xs cursor-pointer underline underline-offset-[3px]">
          {showAdv ? 'Hide advanced' : isDetected ? 'Replace credentials' : 'Advanced — paste credentials / API key'}
        </button>

        {showAdv && credentialFields}
      </div>
    );
  };

  return (
    <div className="mb-5 pb-5 border-b border-border">
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="text-xs font-semibold text-muted-foreground tracking-[0.06em] uppercase">
          Agent Backend
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Backend'}</Button>
        </div>
      </div>
      <p className={cn(hintClass, 'mb-3.5')}>The runtime all agents run on — only one is active at a time. Switching reloads every agent. Model is chosen per agent on each agent&apos;s page.</p>

      <div className="flex flex-col gap-2.5">
        {data.descriptors.map(d => {
          const isActive = backend === d.id;
          const isOpen = expandedId === d.id;
          const mode = authModes[d.id] ?? d.authOptions[0]?.mode;
          const subLabel = d.authOptions.find(o => o.mode === mode)?.label ?? '';
          return (
            <div key={d.id} className={cn(
              'border rounded-lg overflow-hidden transition-colors',
              isActive ? 'border-border bg-secondary' : 'border-border bg-card',
            )}>
              <div
                onClick={() => setExpandedId(isOpen ? null : d.id)}
                className="flex items-center gap-3 px-4 py-3.5 cursor-pointer"
              >
                {/* Active radio */}
                <button
                  onClick={e => { e.stopPropagation(); setBackend(d.id); setExpandedId(d.id); }}
                  aria-label={`Set ${d.label} as active backend`}
                  className={cn(
                    'w-[18px] h-[18px] rounded-full shrink-0 p-0 cursor-pointer bg-transparent flex items-center justify-center border-2',
                    isActive ? 'border-primary' : 'border-border',
                  )}
                >
                  {isActive && <span className="w-2 h-2 rounded-full bg-primary" />}
                </button>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-foreground">{d.label}</span>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 text-2xs font-semibold text-green bg-green/[0.12] px-1.5 py-px rounded-full">
                        <Check size={11} /> Active
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{subLabel}</div>
                </div>

                {isActive && connStatus && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
                    <span className={cn(
                      'w-2 h-2 rounded-full',
                      connStatus.status === 'connected' ? 'bg-green' : connStatus.status === 'expired' ? 'bg-amber' : 'bg-red',
                    )} />
                    {connStatus.status}
                  </span>
                )}
                <ChevronDown size={16} className="text-muted-foreground shrink-0 transition-transform duration-150" style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }} />
              </div>

              {isOpen && (
                <div className="px-4 pb-4 border-t border-border">
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
