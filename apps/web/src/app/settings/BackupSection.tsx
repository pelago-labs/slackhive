'use client';

/**
 * @fileoverview Settings → Backups & Disaster Recovery (superadmin).
 *
 * Download/manage only — this UI NEVER restores. It configures the scheduled backup,
 * lists/downloads backups, triggers a manual backup, and exports the password-wrapped
 * recovery key. Restore is a deliberate CLI operation (shown in the "How to restore"
 * panel) run with the runner stopped.
 *
 * @module web/app/settings/BackupSection
 */

import React, { useEffect, useState } from 'react';
import { Database, Download, KeyRound, ShieldAlert, RefreshCw } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';
import { Switch } from '@/components/ui/switch';

interface BackupInfo { name: string; bytes: number; mtime: number; }

const DEFAULTS = { enabled: true, everyHours: 24, retain: 5 };

function fmtMB(b: number) { return `${(b / 1024 / 1024).toFixed(1)} MB`; }
function ago(ms: number) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function BackupSection() {
  const [enabled, setEnabled] = useState(DEFAULTS.enabled);
  const [everyHours, setEveryHours] = useState(String(DEFAULTS.everyHours));
  const [retain, setRetain] = useState(String(DEFAULTS.retain));
  const [lastTime, setLastTime] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backing, setBacking] = useState(false);
  const [keyPw, setKeyPw] = useState('');
  const [exporting, setExporting] = useState(false);

  const loadSettings = () => fetch('/api/settings').then(r => r.json()).then((s: Record<string, string>) => {
    if (s['backup.enabled'] !== undefined) setEnabled(s['backup.enabled'] === 'true');
    if (s['backup.everyHours']) setEveryHours(s['backup.everyHours']);
    if (s['backup.retain']) setRetain(s['backup.retain']);
    setLastTime(s['backup.lastTime'] ?? null);
    setLastStatus(s['backup.lastStatus'] ?? null);
  }).catch(() => {});

  const loadBackups = () => fetch('/api/backup/list').then(r => r.json())
    .then((d: { backups?: BackupInfo[] }) => setBackups(d.backups ?? [])).catch(() => {});

  useEffect(() => { loadSettings(); loadBackups(); }, []);

  async function saveSetting(key: string, value: string) {
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
  }

  async function onToggle(v: boolean) {
    setEnabled(v);
    await saveSetting('backup.enabled', String(v));
    sonnerToast.success(v ? 'Automatic backups enabled' : 'Automatic backups disabled');
  }

  async function backupNow() {
    setBacking(true);
    try {
      const res = await fetch('/api/backup/now', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) throw new Error(d.error ?? 'Backup failed');
      sonnerToast.success(`Backup created · ${fmtMB(d.bytes ?? 0)}`);
      await Promise.all([loadBackups(), loadSettings()]);
    } catch (e) {
      sonnerToast.error((e as Error).message);
    } finally { setBacking(false); }
  }

  async function exportRecoveryKey() {
    if (keyPw.length < 12) { sonnerToast.error('Password must be at least 12 characters'); return; }
    setExporting(true);
    try {
      const res = await fetch('/api/recovery-key/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: keyPw }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error ?? 'Export failed');
      // Trigger a client-side download of the recovery blob.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `slackhive-recovery-${stamp}.json`; a.click();
      URL.revokeObjectURL(url);
      setKeyPw('');
      sonnerToast.success('Recovery key downloaded — store it (and the password) safely');
    } catch (e) {
      sonnerToast.error((e as Error).message);
    } finally { setExporting(false); }
  }

  return (
    <div>
      {/* DR readiness banner */}
      <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber/30 bg-amber/10 px-4 py-3 text-sm text-foreground">
        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber" />
        <div>
          <strong>Full recovery needs three things:</strong> the database backup file, the
          recovery-key file, and its password. Backups contain your encrypted secrets but
          not the key to decrypt them — download the recovery key below and store it
          (and its password) <em>separately</em> from the backups.
        </div>
      </div>

      {/* Schedule */}
      <Card title="Automatic backups">
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">Enable scheduled backups</span>
          <Switch checked={enabled} onCheckedChange={onToggle} />
        </label>
        {enabled && (
          <div className="grid grid-cols-2 gap-3">
            <Num label="Every (hours)" value={everyHours} min={1}
              onChange={setEveryHours} onCommit={v => saveSetting('backup.everyHours', v)} />
            <Num label="Keep latest" value={retain} min={1}
              onChange={setRetain} onCommit={v => saveSetting('backup.retain', v)} />
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          {lastTime ? <>Last backup {ago(Date.parse(lastTime))} · <span className="text-tertiary">{lastStatus}</span></> : 'No backups yet'}
          {' · '}stored in <code className="font-mono">~/.slackhive/backups/</code>
        </div>
        <div>
          <button onClick={backupNow} disabled={backing}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
            <Database size={14} />{backing ? 'Backing up…' : 'Back up now'}
          </button>
        </div>
      </Card>

      {/* Backup list */}
      <Card title="Backups">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{backups.length} stored locally</span>
          <button onClick={loadBackups} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <RefreshCw size={12} />Refresh
          </button>
        </div>
        {backups.length === 0 ? (
          <div className="text-sm text-subtle">No backups yet.</div>
        ) : (
          <div className="divide-y divide-border">
            {backups.map(b => (
              <div key={b.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-foreground">{b.name}</div>
                  <div className="text-xs text-subtle">{fmtMB(b.bytes)} · {ago(b.mtime)}</div>
                </div>
                <a href={`/api/backup/download?name=${encodeURIComponent(b.name)}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-secondary">
                  <Download size={13} />Download
                </a>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Recovery key export */}
      <Card title="Recovery key">
        <div className="text-sm text-muted-foreground">
          Wraps your encryption key under a password so backups are recoverable on a fresh
          host. The downloaded file is useless without the password.
        </div>
        <div className="flex items-center gap-2">
          <input type="password" value={keyPw} onChange={e => setKeyPw(e.target.value)}
            placeholder="Password (min 12 chars)" autoComplete="new-password"
            className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground" />
          <button onClick={exportRecoveryKey} disabled={exporting || keyPw.length < 12}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary disabled:opacity-60">
            <KeyRound size={14} />{exporting ? 'Exporting…' : 'Download recovery key'}
          </button>
        </div>
      </Card>

      {/* How to restore (CLI only) */}
      <Card title="How to restore">
        <div className="text-sm text-muted-foreground">
          Restore is a manual CLI operation with the runner stopped (never from this UI):
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-secondary/40 px-3 py-2.5 text-xs text-foreground">
{`slackhive stop
slackhive restore -f <backup.db> --recovery-key <recovery.json>
# (prompts for the recovery-key password)
slackhive start`}
        </pre>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-xl border border-border bg-card shadow-card">
      <div className="border-b border-border bg-secondary/45 px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</div>
      </div>
      <div className="flex flex-col gap-3 px-4 py-4">{children}</div>
    </section>
  );
}

function Num({ label, value, min, onChange, onCommit }: {
  label: string; value: string; min: number; onChange: (v: string) => void; onCommit: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input type="number" min={min} value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={e => onCommit(String(Math.max(min, Number(e.target.value) || min)))}
        className="rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground" />
    </label>
  );
}
