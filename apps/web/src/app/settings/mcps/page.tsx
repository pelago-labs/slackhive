'use client';

/**
 * @fileoverview Settings → MCP Catalog page.
 * Global MCP server catalog — add, edit, enable/disable, delete.
 * Supports stdio, SSE, and HTTP transport types.
 *
 * @module web/settings/mcps/page
 */

import { useState, useEffect } from 'react';
import type { McpServer, McpServerType } from '@slackhive/shared';
import { useAuth } from '@/lib/auth-context';

interface McpFormState {
  name: string; type: McpServerType; description: string; enabled: boolean;
  command: string; args: string; env: string;
  url: string; headers: string;
}

const DEFAULT_FORM: McpFormState = {
  name: '', type: 'stdio', description: '', enabled: true,
  command: '', args: '', env: '{}',
  url: '', headers: '{}',
};

/**
 * MCP Catalog settings page.
 *
 * @returns {JSX.Element}
 */
export default function McpSettingsPage() {
  const { canEdit } = useAuth();
  const [servers, setServers]     = useState<McpServer[]>([]);
  const [loading, setLoading]     = useState(true);
  const [form, setForm]           = useState<McpFormState>(DEFAULT_FORM);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm]   = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/mcps');
      setServers(await r.json());
    } finally { setLoading(false); }
  };

  const buildConfig = (f: McpFormState): object => {
    if (f.type === 'stdio') {
      const cfg: Record<string, unknown> = { command: f.command };
      if (f.args.trim()) cfg.args = f.args.split(',').map(a => a.trim()).filter(Boolean);
      try { const env = JSON.parse(f.env); if (Object.keys(env).length > 0) cfg.env = env; } catch { /* ok */ }
      return cfg;
    }
    const cfg: Record<string, unknown> = { url: f.url };
    try { const h = JSON.parse(f.headers); if (Object.keys(h).length > 0) cfg.headers = h; } catch { /* ok */ }
    return cfg;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const r = await fetch(editingId ? `/api/mcps/${editingId}` : '/api/mcps', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, type: form.type, description: form.description || undefined, enabled: form.enabled, config: buildConfig(form) }),
      });
      if (!r.ok) { const b = await r.json(); throw new Error(b.error ?? 'Failed'); }
      resetForm(); await load();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this MCP server from the catalog?')) return;
    await fetch(`/api/mcps/${id}`, { method: 'DELETE' });
    load();
  };

  const handleToggle = async (server: McpServer) => {
    await fetch(`/api/mcps/${server.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !server.enabled }),
    });
    load();
  };

  const handleEdit = (server: McpServer) => {
    const cfg = server.config as unknown as Record<string, unknown>;
    setForm({
      name: server.name, type: server.type,
      description: server.description ?? '', enabled: server.enabled,
      command: (cfg.command as string) ?? '',
      args: Array.isArray(cfg.args) ? (cfg.args as string[]).join(', ') : '',
      env: cfg.env ? JSON.stringify(cfg.env, null, 2) : '{}',
      url: (cfg.url as string) ?? '',
      headers: cfg.headers ? JSON.stringify(cfg.headers, null, 2) : '{}',
    });
    setEditingId(server.id);
    setShowForm(true);
  };

  const resetForm = () => {
    setForm(DEFAULT_FORM); setEditingId(null); setShowForm(false); setError('');
  };

  const f = (key: keyof McpFormState, val: unknown) => setForm(prev => ({ ...prev, [key]: val }));

  return (
    <div style={{ padding: '32px 36px', maxWidth: 860 }} className="fade-up">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>Settings</div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            MCP Catalog
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            {servers.length} server{servers.length !== 1 ? 's' : ''} · available to all agents
          </p>
        </div>
        {canEdit && !showForm && (
          <button onClick={() => setShowForm(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--accent)', color: '#fff',
            padding: '8px 16px', borderRadius: 8, border: 'none',
            fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
            transition: 'opacity 0.15s',
          }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <span style={{ fontSize: 16, lineHeight: 1, marginTop: -1 }}>+</span>
            Add Server
          </button>
        )}
      </div>

      {/* Server list */}
      {loading ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : servers.length === 0 && !showForm ? (
        <div style={{
          border: '1px dashed var(--border)', borderRadius: 12, padding: '48px',
          textAlign: 'center', color: 'var(--subtle)',
        }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>⚙️</div>
          <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 500, color: 'var(--muted)' }}>No MCP servers yet</p>
          <p style={{ margin: '0 0 16px', fontSize: 13 }}>Add servers to the catalog to enable agent tools.</p>
          {canEdit && <button onClick={() => setShowForm(true)} style={{
            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8,
            padding: '8px 20px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
          }}>Add First Server</button>}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
          {servers.map((server, i) => (
            <ServerRow
              key={server.id} server={server}
              isLast={i === servers.length - 1}
              onEdit={() => handleEdit(server)}
              onDelete={() => handleDelete(server.id)}
              onToggle={() => handleToggle(server)}
              canEdit={canEdit}
            />
          ))}
        </div>
      )}

      {/* Add/Edit form */}
      {showForm && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, padding: '28px', marginTop: 4,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
              {editingId ? 'Edit Server' : 'Add MCP Server'}
            </h2>
            <button onClick={resetForm} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', fontSize: 18, fontFamily: 'var(--font-sans)',
            }}>×</button>
          </div>

          {error && (
            <div style={{
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: 7, padding: '9px 13px', marginBottom: 16,
              fontSize: 13, color: '#f87171',
            }}>{error}</div>
          )}

          <form onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <FField label="Name *" required>
                <input value={form.name} onChange={e => f('name', e.target.value)} placeholder="redshift-mcp"
                  required {...inputStyle()} />
                <small style={{ color: 'var(--subtle)', fontSize: 11, marginTop: 3, display: 'block' }}>
                  Tool pattern: <code style={{ fontFamily: 'var(--font-mono)' }}>mcp__name__tool</code>
                </small>
              </FField>
              <FField label="Transport Type">
                <select value={form.type} onChange={e => f('type', e.target.value as McpServerType)} {...inputStyle()}>
                  <option value="stdio">stdio — local subprocess</option>
                  <option value="sse">SSE — remote Server-Sent Events</option>
                  <option value="http">HTTP — remote HTTP transport</option>
                </select>
              </FField>
            </div>

            <FField label="Description" style={{ marginBottom: 14 }}>
              <input value={form.description} onChange={e => f('description', e.target.value)}
                placeholder="What does this MCP server provide?" {...inputStyle()} />
            </FField>

            {form.type === 'stdio' ? (
              <>
                <FField label="Command *" style={{ marginBottom: 14 }}>
                  <input value={form.command} onChange={e => f('command', e.target.value)}
                    placeholder="node" required {...inputStyle('var(--font-mono)')} />
                </FField>
                <FField label="Arguments" hint="Comma-separated" style={{ marginBottom: 14 }}>
                  <input value={form.args} onChange={e => f('args', e.target.value)}
                    placeholder="/path/to/server.js, --port, 3000" {...inputStyle('var(--font-mono)')} />
                </FField>
                <FField label="Environment Variables (JSON)" style={{ marginBottom: 14 }}>
                  <textarea value={form.env} onChange={e => f('env', e.target.value)}
                    rows={4} placeholder={'{\n  "DATABASE_URL": "postgresql://..."\n}'} {...inputStyle('var(--font-mono)')} />
                </FField>
              </>
            ) : (
              <>
                <FField label="URL *" style={{ marginBottom: 14 }}>
                  <input value={form.url} onChange={e => f('url', e.target.value)}
                    placeholder="https://mcp.example.com/sse" required type="url" {...inputStyle('var(--font-mono)')} />
                </FField>
                <FField label="Headers (JSON)" style={{ marginBottom: 14 }}>
                  <textarea value={form.headers} onChange={e => f('headers', e.target.value)}
                    rows={3} placeholder={'{\n  "Authorization": "Bearer ..."\n}'} {...inputStyle('var(--font-mono)')} />
                </FField>
              </>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', marginBottom: 20 }}>
              <input type="checkbox" checked={form.enabled} onChange={e => f('enabled', e.target.checked)}
                style={{ accentColor: 'var(--accent)', width: 14, height: 14 }} />
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                Enabled — available for agents to use
              </span>
            </label>

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" disabled={saving} style={{
                background: saving ? 'var(--border)' : 'var(--accent)',
                color: '#fff', border: 'none', borderRadius: 7,
                padding: '9px 22px', fontSize: 13, fontWeight: 500,
                cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)',
                transition: 'opacity 0.15s',
              }}>{saving ? 'Saving…' : editingId ? 'Update Server' : 'Add Server'}</button>
              <button type="button" onClick={resetForm} style={{
                background: 'transparent', color: 'var(--muted)',
                border: '1px solid var(--border)', borderRadius: 7,
                padding: '9px 22px', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}>Cancel</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ─── Server row ───────────────────────────────────────────────────────────────

function ServerRow({
  server, isLast, onEdit, onDelete, onToggle, canEdit,
}: {
  server: McpServer; isLast: boolean;
  onEdit: () => void; onDelete: () => void; onToggle: () => void;
  canEdit: boolean;
}) {
  const cfg = server.config as unknown as Record<string, unknown>;
  const preview = server.type === 'stdio'
    ? `${cfg.command} ${Array.isArray(cfg.args) ? (cfg.args as string[]).join(' ') : ''}`.trim()
    : String(cfg.url ?? '');

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px',
      borderBottom: isLast ? 'none' : '1px solid var(--border)',
      transition: 'background 0.12s',
      opacity: server.enabled ? 1 : 0.55,
    }}
      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'}
      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
    >
      {/* Type badge */}
      <span style={{
        fontSize: 10.5, fontFamily: 'var(--font-mono)', fontWeight: 500,
        background: 'var(--border)', color: 'var(--muted)',
        padding: '2px 8px', borderRadius: 5, flexShrink: 0, letterSpacing: '0.02em',
      }}>{server.type}</span>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{server.name}</span>
          {!server.enabled && (
            <span style={{ fontSize: 10.5, color: 'var(--subtle)', background: 'var(--border)', padding: '1px 6px', borderRadius: 4 }}>
              disabled
            </span>
          )}
        </div>
        {server.description && (
          <p style={{ margin: '1px 0 0', fontSize: 12, color: 'var(--muted)' }}>{server.description}</p>
        )}
        <p style={{
          margin: '2px 0 0', fontSize: 11.5, color: 'var(--subtle)',
          fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{preview}</p>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <ActionBtn onClick={onToggle} color="var(--muted)" disabled={!canEdit}>
          {server.enabled ? 'Disable' : 'Enable'}
        </ActionBtn>
        {canEdit && <ActionBtn onClick={onEdit} color="var(--accent)">Edit</ActionBtn>}
        {canEdit && <ActionBtn onClick={onDelete} color="#ef4444">Delete</ActionBtn>}
      </div>
    </div>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function FField({ label, hint, children, style: s, required: req }: {
  label: string; hint?: string; children: React.ReactNode;
  style?: React.CSSProperties; required?: boolean;
}) {
  return (
    <div style={s}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>
        {label}{req && <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>}
      </label>
      {children}
      {hint && <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--subtle)' }}>{hint}</p>}
    </div>
  );
}

function inputStyle(fontFamily = 'var(--font-sans)'): React.HTMLAttributes<HTMLElement> & { style: React.CSSProperties } {
  return {
    style: {
      width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 7, padding: '8px 11px', color: 'var(--text)',
      fontSize: 13, fontFamily, outline: 'none', resize: 'vertical' as const,
      transition: 'border-color 0.15s',
    } as React.CSSProperties,
    onFocus: (e: React.FocusEvent<HTMLElement>) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'),
    onBlur:  (e: React.FocusEvent<HTMLElement>) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'),
  };
}

function ActionBtn({ children, onClick, color, disabled }: {
  children: React.ReactNode; onClick: () => void; color?: string; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: 'none', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      fontSize: 12, color: color ?? 'var(--muted)', fontFamily: 'var(--font-sans)',
      padding: '3px 8px', borderRadius: 5, transition: 'background 0.12s, color 0.12s',
    }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >{children}</button>
  );
}
