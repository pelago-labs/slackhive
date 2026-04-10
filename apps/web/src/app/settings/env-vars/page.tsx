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
import { KeyRound } from 'lucide-react';

interface EnvVarRow { key: string; description?: string; updatedAt: string; }

export default function EnvVarsPage() {
  const { canEdit } = useAuth();
  const [vars, setVars]         = useState<EnvVarRow[]>([]);
  const [loading, setLoading]   = useState(true);
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

  const inputSt: React.CSSProperties = {
    width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 7, padding: '8px 11px', color: 'var(--text)',
    fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none', boxSizing: 'border-box',
    transition: 'border-color 0.15s',
  };

  return (
    <div style={{ padding: '32px 36px', maxWidth: 860 }} className="fade-up">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>Settings</div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            Env Vars
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Named secrets for MCP servers — values are write-only, never shown after saving
          </p>
        </div>
        {canEdit && !showForm && (
          <button onClick={() => setShowForm(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--accent)', color: 'var(--accent-fg)',
            padding: '8px 16px', borderRadius: 8, border: 'none',
            fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
          }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <span style={{ fontSize: 16, lineHeight: 1, marginTop: -1 }}>+</span>
            Add Env Var
          </button>
        )}
      </div>

      {/* Add/Edit form */}
      {showForm && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, padding: 28, marginBottom: 20,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
              {editKey ? `Edit ${editKey}` : 'New Env Var'}
            </h2>
            <button onClick={resetForm} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>×</button>
          </div>
          {error && <div style={{ fontSize: 12, color: '#dc2626', background: 'rgba(220,38,38,0.06)', padding: '8px 12px', borderRadius: 6, marginBottom: 14 }}>{error}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>Key *</label>
              <input
                value={form.key}
                onChange={e => setForm(f => ({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }))}
                placeholder="REDSHIFT_DATABASE_URL"
                readOnly={!!editKey}
                style={{ ...inputSt, fontFamily: 'var(--font-mono)', opacity: editKey ? 0.6 : 1 }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              />
              <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--subtle)' }}>Uppercase letters, digits, underscores</p>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>
                Value {editKey ? <span style={{ fontWeight: 400 }}>(leave blank to keep existing)</span> : '*'}
              </label>
              <input
                type="password"
                value={form.value}
                onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                placeholder={editKey ? '••••••••' : 'Enter secret value'}
                style={{ ...inputSt, fontFamily: 'var(--font-mono)' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>Description</label>
              <input
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What is this secret used for?"
                style={inputSt}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button onClick={save} disabled={saving} style={{
              background: saving ? 'var(--border)' : 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
              borderRadius: 7, padding: '9px 22px', fontSize: 13, fontWeight: 500,
              cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)',
            }}>{saving ? 'Saving…' : editKey ? 'Update' : 'Save'}</button>
            <button onClick={resetForm} style={{
              background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)',
              borderRadius: 7, padding: '9px 22px', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>Cancel</button>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : vars.length === 0 && !showForm ? (
        <div style={{
          border: '1px dashed var(--border)', borderRadius: 12, padding: '48px',
          textAlign: 'center', color: 'var(--subtle)',
        }}>
          <div style={{ marginBottom: 10, color: 'var(--subtle)' }}><KeyRound size={28} /></div>
          <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 500, color: 'var(--muted)' }}>No env vars yet</p>
          <p style={{ margin: '0 0 16px', fontSize: 13 }}>
            Add secrets here and reference them in MCP configs instead of pasting raw values.
          </p>
          {canEdit && (
            <button onClick={() => setShowForm(true)} style={{
              background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 8,
              padding: '8px 20px', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>Add First Env Var</button>
          )}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {vars.map((v, i) => (
            <div key={v.key} style={{
              display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px',
              borderBottom: i < vars.length - 1 ? '1px solid var(--border)' : 'none',
              transition: 'background 0.12s',
            }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
            >
              <code style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text)', flexShrink: 0 }}>{v.key}</code>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)', fontStyle: v.description ? 'normal' : 'italic' }}>
                {v.description ?? 'No description'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--subtle)', flexShrink: 0 }}>
                {new Date(v.updatedAt).toLocaleDateString()}
              </span>
              {canEdit && <button onClick={() => startEdit(v)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-sans)', padding: '3px 8px', borderRadius: 5 }}>Edit</button>}
              {canEdit && <button onClick={() => remove(v.key)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-sans)', padding: '3px 8px', borderRadius: 5 }}>Delete</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
