'use client';

/**
 * @fileoverview Settings → Env Vars page.
 * Platform-level secret store — named key/value pairs used by MCP servers
 * via envRefs. Values are write-only and never returned by the API.
 *
 * @module web/settings/env-vars/page
 */

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { KeyRound, Plus, Search, ShieldCheck, Pencil, Trash2 } from 'lucide-react';
import { PageShell, PageHeader, EmptyState } from '@/components/patterns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface EnvVarRow { key: string; description?: string; createdBy: string; updatedAt: string; }

export default function EnvVarsPage() {
  const { canEdit, canManageUsers, username } = useAuth();
  const [vars, setVars]         = useState<EnvVarRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState({ key: '', value: '', description: '' });
  const [editKey, setEditKey]   = useState<string | null>(null);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const load = () => {
    setLoading(true);
    fetch('/api/env-vars').then(r => r.json()).then(setVars).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const resetForm = () => { setForm({ key: '', value: '', description: '' }); setEditKey(null); setShowForm(false); setError(''); };

  const save = async () => {
    if (!form.key) { setError('Key is required'); return; }
    if (!editKey && !form.value) { setError('Value is required'); return; }
    setSaving(true); setError('');
    try {
      let res: Response;
      if (editKey) {
        const body: Record<string, string> = {};
        if (form.value) body.value = form.value;
        if (form.description !== undefined) body.description = form.description;
        res = await fetch(`/api/env-vars/${editKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        res = await fetch('/api/env-vars', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      }
      if (!res.ok) { const b = await res.json(); throw new Error(b.error ?? 'Failed'); }
      resetForm(); load();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };

  const remove = async (key: string) => {
    if (!confirm(`Delete "${key}"? MCPs referencing it will stop receiving this value.`)) return;
    await fetch(`/api/env-vars/${key}`, { method: 'DELETE' });
    load();
  };

  const startEdit = (v: EnvVarRow) => {
    setEditKey(v.key);
    setForm({ key: v.key, value: '', description: v.description ?? '' });
    setShowForm(true);
  };

  const canModify = (v: EnvVarRow) => canManageUsers || v.createdBy === username;

  return (
    <PageShell>
      <div className="max-w-[1180px]">
      {/* Header */}
      <PageHeader
        title={
          <span className="flex flex-col gap-1">
            <span className="text-xs font-normal text-muted-foreground">Settings</span>
            <span className="text-2xl font-semibold tracking-normal">Env Vars</span>
          </span>
        }
        subtitle="Named secrets for MCP servers — values are write-only, never shown after saving"
        action={canEdit && !showForm
          ? <Button onClick={() => setShowForm(true)}><Plus size={15} /> Add Env Var</Button>
          : undefined}
      />

      {/* Add/Edit form */}
      {showForm && (
        <div className="mb-5 rounded-lg border border-border bg-card p-5 shadow-card">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="m-0 text-md font-semibold text-foreground">
              {editKey ? `Edit ${editKey}` : 'New Env Var'}
            </h2>
            <button onClick={resetForm} className="cursor-pointer border-none bg-transparent text-lg text-muted-foreground">×</button>
          </div>
          {error && <div className="mb-3.5 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
          <div className="flex flex-col gap-3.5">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Key {!editKey && '*'} {editKey && <span className="font-normal text-muted-foreground/70">(cannot be changed)</span>}
              </label>
              <Input
                value={form.key}
                onChange={e => setForm(f => ({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }))}
                placeholder="REDSHIFT_DATABASE_URL"
                readOnly={!!editKey}
                className={editKey
                  ? 'cursor-not-allowed bg-muted font-mono text-muted-foreground'
                  : 'font-mono'}
              />
              {!editKey && <p className="m-0 mt-1 text-2xs text-muted-foreground/70">Uppercase letters, digits, underscores</p>}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Value {editKey ? <span className="font-normal text-green">✓ value saved · enter new to replace</span> : '*'}
              </label>
              <Input
                type="password"
                value={form.value}
                onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                placeholder={editKey ? 'Enter new value to replace existing' : 'Enter secret value'}
                className="font-mono"
              />
              {editKey && <p className="m-0 mt-1 text-2xs text-muted-foreground/70">For security, the existing value is not shown. Leave blank to keep it unchanged.</p>}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Description</label>
              <Input
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What is this secret used for?"
              />
            </div>
          </div>
          <div className="mt-5 flex gap-2.5">
            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : editKey ? 'Update' : 'Save'}</Button>
            <Button variant="outline" onClick={resetForm}>Cancel</Button>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : vars.length === 0 && !showForm ? (
        <EmptyState
          icon={<KeyRound size={28} className="text-border" />}
          title="No env vars yet"
          hint="Add secrets here and reference them in MCP configs instead of pasting raw values."
          action={canEdit && (
            <Button onClick={() => setShowForm(true)}>Add First Env Var</Button>
          )}
        />
      ) : (
        <div className="rounded-lg border border-border bg-card shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-md border border-green/20 bg-green/10 text-green">
                <ShieldCheck size={15} />
              </div>
              <div>
                <div className="text-sm font-semibold text-foreground">{vars.length} secret{vars.length !== 1 ? 's' : ''}</div>
                <div className="text-2xs text-muted-foreground">Stored values are hidden after save.</div>
              </div>
            </div>
            <div className="relative w-full sm:w-[320px]">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search secrets..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-9 pl-9"
              />
            </div>
          </div>

          <div className="divide-y divide-border">
            {vars.filter(v => !search || v.key.toLowerCase().includes(search.toLowerCase()) || (v.description ?? '').toLowerCase().includes(search.toLowerCase())).map(v => (
              <div
                key={v.key}
                className="grid items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/70 md:grid-cols-[minmax(220px,320px)_minmax(0,1fr)_210px_auto]"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
                    <KeyRound size={13} />
                  </span>
                  <code className="min-w-0 truncate font-mono text-xs font-semibold text-foreground">{v.key}</code>
                </div>
                <div className={`min-w-0 truncate text-xs text-muted-foreground ${v.description ? '' : 'italic'}`}>
                  {v.description ?? 'No description'}
                </div>
                <div className="text-2xs text-muted-foreground">
                  <span className="font-medium text-foreground">{v.createdBy}</span>
                  <span className="mx-1.5 text-muted-foreground/60">·</span>
                  {new Date(v.updatedAt).toLocaleDateString()}
                </div>
                {canModify(v) && (
                  <div className="flex items-center justify-end gap-1.5">
                    <button onClick={() => startEdit(v)} title="Edit secret" className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => remove(v.key)} title="Delete secret" className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-red/20 bg-red/5 text-red hover:bg-red/10">
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))}
            {vars.filter(v => !search || v.key.toLowerCase().includes(search.toLowerCase()) || (v.description ?? '').toLowerCase().includes(search.toLowerCase())).length === 0 && (
              <div className="px-5 py-10 text-center text-sm text-muted-foreground">No env vars match your search.</div>
            )}
          </div>
        </div>
      )}
      </div>
    </PageShell>
  );
}
