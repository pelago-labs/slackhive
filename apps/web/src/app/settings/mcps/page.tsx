'use client';

/**
 * @fileoverview Settings → MCP Catalog page.
 * Global MCP server catalog — add, edit, enable/disable, delete, test.
 * Supports stdio, SSE, HTTP, and inline TypeScript transports.
 *
 * @module web/settings/mcps/page
 */

import { useState, useEffect, useRef } from 'react';
import type { McpServer, McpServerType } from '@slackhive/shared';
import { useAuth } from '@/lib/auth-context';
import { Plug, Library, Search, X, Check, Loader2 } from 'lucide-react';
import { Portal } from '@/lib/portal';

// ─── Types ───────────────────────────────────────────────────────────────────

/** UI transport type — 'typescript' is sent to the API as 'stdio' with tsSource */
type UiTransportType = McpServerType | 'typescript';

interface EnvEntry {
  key: string;
  mode: 'value' | 'ref';
  val: string; // raw value (mode=value) or env_vars key name (mode=ref)
}

/** A single HTTP header row — value is either a static string or pulled from an env var */
interface HeaderEntry {
  name: string;
  mode: 'value' | 'ref';
  val: string;    // static value (mode=value) or env_vars key name (mode=ref)
  prefix: string; // prepended to env var value, e.g. "Bearer " (mode=ref only)
}

interface McpFormState {
  name: string;
  uiType: UiTransportType;
  description: string;
  enabled: boolean;
  // stdio fields
  command: string;
  args: string;
  envEntries: EnvEntry[];
  // typescript field
  tsSource: string;
  // sse/http fields
  url: string;
  headerEntries: HeaderEntry[];
}

const DEFAULT_FORM: McpFormState = {
  name: '', uiType: 'stdio', description: '', enabled: true,
  command: '', args: '', envEntries: [],
  tsSource: '// MCP server TypeScript source\n// See: https://modelcontextprotocol.io/docs\n',
  url: '', headerEntries: [] as HeaderEntry[],
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function McpSettingsPage() {
  const { canEdit } = useAuth();
  const [servers, setServers]       = useState<McpServer[]>([]);
  const [loading, setLoading]       = useState(true);
  const [form, setForm]             = useState<McpFormState>(DEFAULT_FORM);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [showForm, setShowForm]     = useState(false);
  const [envVarKeys, setEnvVarKeys] = useState<string[]>([]);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message?: string; error?: string } | 'testing'>>({});
  const formRef = useRef<HTMLDivElement>(null);

  // Template library state
  const [showLibrary, setShowLibrary] = useState(false);
  const [templates, setTemplates] = useState<any[]>([]);
  const [categories, setCategories] = useState<Record<string, { label: string; description: string }>>({});
  const [templateSearch, setTemplateSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [installingTemplate, setInstallingTemplate] = useState<string | null>(null);
  const [templateEnvValues, setTemplateEnvValues] = useState<Record<string, string>>({});
  const [selectedTemplate, setSelectedTemplate] = useState<any | null>(null);
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (showForm && formRef.current) {
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showForm, editingId]);
  useEffect(() => {
    // Load available env var keys for the ref dropdown
    fetch('/api/env-vars').then(r => r.json()).then((rows: { key: string }[]) => setEnvVarKeys(rows.map(r => r.key))).catch(() => {});
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/mcps');
      setServers(await r.json());
    } finally { setLoading(false); }
  };

  // ─── Template library ──────────────────────────────────────────────────────

  const loadTemplates = async () => {
    try {
      const r = await fetch('/api/mcps/templates');
      const data = await r.json();
      setTemplates(data.templates);
      setCategories(data.categories);
      // Mark already-installed servers
      const installed = new Set(servers.map(s => s.name));
      setInstalledIds(installed as Set<string>);
    } catch { /* ignore */ }
  };

  const openLibrary = () => {
    loadTemplates();
    setShowLibrary(true);
    setTemplateSearch('');
    setSelectedCategory(null);
    setSelectedTemplate(null);
  };

  const installTemplate = async (template: any) => {
    // If template has required env vars, show the config step
    const requiredKeys = template.envKeys.filter((k: any) => k.required);
    if (requiredKeys.length > 0 && !selectedTemplate) {
      setSelectedTemplate(template);
      setTemplateEnvValues({});
      return;
    }

    setInstallingTemplate(template.id);
    try {
      const r = await fetch('/api/mcps/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: template.id, envValues: templateEnvValues }),
      });
      if (r.ok) {
        setInstalledIds(prev => new Set([...prev, template.id]));
        setSelectedTemplate(null);
        setTemplateEnvValues({});
        await load(); // Refresh server list
      } else {
        const err = await r.json();
        alert(err.error || 'Failed to install');
      }
    } finally {
      setInstallingTemplate(null);
    }
  };

  const filteredTemplates = templates.filter(t => {
    if (selectedCategory && t.category !== selectedCategory) return false;
    if (templateSearch) {
      const q = templateSearch.toLowerCase();
      return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.tags?.some((tag: string) => tag.includes(q));
    }
    return true;
  });

  // ─── Config builder ─────────────────────────────────────────────────────────

  const buildConfig = (f: McpFormState): object => {
    if (f.uiType === 'typescript') {
      const env = entriesToEnv(f.envEntries);
      const envRefs = entriesToRefs(f.envEntries);
      const cfg: Record<string, unknown> = { command: 'tsx', tsSource: f.tsSource };
      if (Object.keys(env).length > 0) cfg.env = env;
      if (Object.keys(envRefs).length > 0) cfg.envRefs = envRefs;
      return cfg;
    }
    if (f.uiType === 'stdio') {
      const cfg: Record<string, unknown> = { command: f.command };
      if (f.args.trim()) cfg.args = f.args.split(',').map(a => a.trim()).filter(Boolean);
      const env = entriesToEnv(f.envEntries);
      const envRefs = entriesToRefs(f.envEntries);
      if (Object.keys(env).length > 0) cfg.env = env;
      if (Object.keys(envRefs).length > 0) cfg.envRefs = envRefs;
      return cfg;
    }
    // sse / http
    const cfg: Record<string, unknown> = { url: f.url };
    const headers: Record<string, string> = {};
    const envRefs: Record<string, string> = {};
    for (const h of f.headerEntries) {
      if (!h.name) continue;
      if (h.mode === 'value') {
        headers[h.name] = h.val;
      } else {
        headers[h.name] = h.prefix; // e.g. "Bearer " — runner prepends this to env var value
        envRefs[h.name] = h.val;
      }
    }
    if (Object.keys(headers).length > 0) cfg.headers = headers;
    if (Object.keys(envRefs).length > 0) cfg.envRefs = envRefs;
    return cfg;
  };

  const entriesToEnv = (entries: EnvEntry[]) =>
    Object.fromEntries(entries.filter(e => e.mode === 'value' && e.key).map(e => [e.key, e.val]));

  const entriesToRefs = (entries: EnvEntry[]) =>
    Object.fromEntries(entries.filter(e => e.mode === 'ref' && e.key && e.val).map(e => [e.key, e.val]));

  // API type is always 'stdio' for typescript
  const apiType = (uiType: UiTransportType): McpServerType =>
    uiType === 'typescript' ? 'stdio' : uiType;

  // ─── Handlers ───────────────────────────────────────────────────────────────

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const r = await fetch(editingId ? `/api/mcps/${editingId}` : '/api/mcps', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          type: apiType(form.uiType),
          description: form.description || undefined,
          enabled: form.enabled,
          config: buildConfig(form),
        }),
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

  const handleTest = async (server: McpServer) => {
    setTestResults(prev => ({ ...prev, [server.id]: 'testing' }));
    try {
      const r = await fetch(`/api/mcps/${server.id}/test`, { method: 'POST' });
      const result = await r.json() as { ok: boolean; message?: string; error?: string };
      setTestResults(prev => ({ ...prev, [server.id]: result }));
    } catch {
      setTestResults(prev => ({ ...prev, [server.id]: { ok: false, error: 'Request failed' } }));
    }
  };

  const handleEdit = (server: McpServer) => {
    const cfg = server.config as unknown as Record<string, unknown>;
    const isTs = typeof cfg.tsSource === 'string';
    const envObj = (cfg.env as Record<string, string>) ?? {};
    const envRefsObj = (cfg.envRefs as Record<string, string>) ?? {};

    const envEntries: EnvEntry[] = [
      ...Object.entries(envObj).map(([k, v]) => ({ key: k, mode: 'value' as const, val: v })),
      ...Object.entries(envRefsObj).map(([k, v]) => ({ key: k, mode: 'ref' as const, val: v })),
    ];

    const headersObj = (cfg.headers as Record<string, string>) ?? {};
    const envRefsObj2 = (cfg.envRefs as Record<string, string>) ?? {};
    const headerEntries: HeaderEntry[] = Object.entries(headersObj).map(([name, rawVal]) => {
      if (envRefsObj2[name] !== undefined) {
        return { name, mode: 'ref' as const, val: envRefsObj2[name], prefix: rawVal };
      }
      return { name, mode: 'value' as const, val: rawVal, prefix: '' };
    });

    setForm({
      name: server.name,
      uiType: isTs ? 'typescript' : server.type,
      description: server.description ?? '',
      enabled: server.enabled,
      command: (cfg.command as string) ?? '',
      args: Array.isArray(cfg.args) ? (cfg.args as string[]).join(', ') : '',
      envEntries,
      tsSource: isTs ? (cfg.tsSource as string) : DEFAULT_FORM.tsSource,
      url: (cfg.url as string) ?? '',
      headerEntries,
    });
    setEditingId(server.id);
    setShowForm(true);
  };

  const resetForm = () => { setForm(DEFAULT_FORM); setEditingId(null); setShowForm(false); setError(''); };

  const f = (key: keyof McpFormState, val: unknown) => setForm(prev => ({ ...prev, [key]: val }));

  // ─── Env entry helpers ──────────────────────────────────────────────────────

  const addEnvEntry = () => setForm(prev => ({ ...prev, envEntries: [...prev.envEntries, { key: '', mode: 'value', val: '' }] }));
  const removeEnvEntry = (i: number) => setForm(prev => ({ ...prev, envEntries: prev.envEntries.filter((_, idx) => idx !== i) }));
  const updateEnvEntry = (i: number, patch: Partial<EnvEntry>) =>
    setForm(prev => ({ ...prev, envEntries: prev.envEntries.map((e, idx) => idx === i ? { ...e, ...patch } : e) }));

  const addHeaderEntry = () => setForm(prev => ({ ...prev, headerEntries: [...prev.headerEntries, { name: '', mode: 'value', val: '', prefix: '' }] }));
  const removeHeaderEntry = (i: number) => setForm(prev => ({ ...prev, headerEntries: prev.headerEntries.filter((_, idx) => idx !== i) }));
  const updateHeaderEntry = (i: number, patch: Partial<HeaderEntry>) =>
    setForm(prev => ({ ...prev, headerEntries: prev.headerEntries.map((e, idx) => idx === i ? { ...e, ...patch } : e) }));

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '36px 40px' }} className="fade-up">
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
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={openLibrary} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'var(--surface)', color: 'var(--text)',
              padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)',
              fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
              transition: 'opacity 0.15s',
            }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              <Library size={14} />
              Browse Library
            </button>
            <button onClick={() => setShowForm(true)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'var(--accent)', color: 'var(--accent-fg)',
              padding: '8px 16px', borderRadius: 8, border: 'none',
              fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
              transition: 'opacity 0.15s',
            }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              <span style={{ fontSize: 16, lineHeight: 1, marginTop: -1 }}>+</span>
              Custom Server
            </button>
          </div>
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
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}><Plug size={28} style={{ color: 'var(--border-2)' }} /></div>
          <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 500, color: 'var(--muted)' }}>No MCP servers yet</p>
          <p style={{ margin: '0 0 16px', fontSize: 13 }}>Add tools like GitHub, Notion, Figma, and 50+ more from the library.</p>
          {canEdit && <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button onClick={openLibrary} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 8,
              padding: '8px 20px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}><Library size={14} /> Browse Library</button>
            <button onClick={() => setShowForm(true)} style={{
              background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '8px 16px', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>Add Custom</button>
          </div>}
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
              onTest={() => handleTest(server)}
              testResult={testResults[server.id]}
              canEdit={canEdit}
            />
          ))}
        </div>
      )}

      {/* Add/Edit form */}
      {showForm && (
        <div ref={formRef} style={{
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
                <select value={form.uiType} onChange={e => f('uiType', e.target.value as UiTransportType)} {...inputStyle()}>
                  <option value="stdio">stdio — local subprocess</option>
                  <option value="typescript">TypeScript — inline script</option>
                  <option value="sse">SSE — remote Server-Sent Events</option>
                  <option value="http">HTTP — remote HTTP transport</option>
                </select>
              </FField>
            </div>

            <FField label="Description" style={{ marginBottom: 14 }}>
              <input value={form.description} onChange={e => f('description', e.target.value)}
                placeholder="What does this MCP server provide?" {...inputStyle()} />
            </FField>

            {/* stdio fields */}
            {form.uiType === 'stdio' && (
              <>
                <FField label="Command *" style={{ marginBottom: 14 }}>
                  <input value={form.command} onChange={e => f('command', e.target.value)}
                    placeholder="node" required {...inputStyle('var(--font-mono)')} />
                </FField>
                <FField label="Arguments" hint="Comma-separated" style={{ marginBottom: 14 }}>
                  <input value={form.args} onChange={e => f('args', e.target.value)}
                    placeholder="/path/to/server.js, --port, 3000" {...inputStyle('var(--font-mono)')} />
                </FField>
                <EnvEntriesEditor entries={form.envEntries} envVarKeys={envVarKeys}
                  onAdd={addEnvEntry} onRemove={removeEnvEntry} onUpdate={updateEnvEntry} />
              </>
            )}

            {/* TypeScript inline script */}
            {form.uiType === 'typescript' && (
              <>
                <FField label="TypeScript Source *" style={{ marginBottom: 14 }}
                  hint="The runner saves this to disk and executes it with tsx. Must implement the MCP stdio protocol.">
                  <textarea value={form.tsSource} onChange={e => f('tsSource', e.target.value)}
                    rows={14} required {...inputStyle('var(--font-mono)')} />
                </FField>
                <EnvEntriesEditor entries={form.envEntries} envVarKeys={envVarKeys}
                  onAdd={addEnvEntry} onRemove={removeEnvEntry} onUpdate={updateEnvEntry} />
              </>
            )}

            {/* SSE / HTTP fields */}
            {(form.uiType === 'sse' || form.uiType === 'http') && (
              <>
                <FField label="URL *" style={{ marginBottom: 14 }}>
                  <input value={form.url} onChange={e => f('url', e.target.value)}
                    placeholder="https://mcp.example.com/sse" required type="url" {...inputStyle('var(--font-mono)')} />
                </FField>
                <HeaderEntriesEditor
                  entries={form.headerEntries} envVarKeys={envVarKeys}
                  onAdd={addHeaderEntry} onRemove={removeHeaderEntry} onUpdate={updateHeaderEntry}
                />
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
                color: 'var(--accent-fg)', border: 'none', borderRadius: 7,
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

      {/* ─── Template Library Modal ─────────────────────────────────────────── */}
      {showLibrary && (
        <Portal><div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '40px 20px',
        }}>
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          }} onClick={() => { setShowLibrary(false); setSelectedTemplate(null); }} />
          <div style={{
            position: 'relative', background: 'var(--bg)', borderRadius: 16,
            width: '100%', maxWidth: 720, height: '100%', maxHeight: '100%',
            display: 'flex', flexDirection: 'column',
            border: '1px solid var(--border)', boxShadow: '0 24px 48px rgba(0,0,0,0.2)',
          }}>
            {/* Modal header */}
            <div style={{
              padding: '20px 24px 16px', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>
                  MCP Server Library
                </h2>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                  {templates.length} pre-configured servers — click to add
                </p>
              </div>
              <button onClick={() => { setShowLibrary(false); setSelectedTemplate(null); }} style={{
                background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4,
              }}><X size={18} /></button>
            </div>

            {/* Search + category filter */}
            <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
                <input
                  type="text"
                  placeholder="Search servers..."
                  value={templateSearch}
                  onChange={e => setTemplateSearch(e.target.value)}
                  style={{
                    width: '100%', padding: '7px 10px 7px 30px', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--surface-2)',
                    fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-sans)', outline: 'none',
                  }}
                />
              </div>
              <select
                value={selectedCategory ?? ''}
                onChange={e => setSelectedCategory(e.target.value || null)}
                style={{
                  padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
                  background: 'var(--surface-2)', fontSize: 12, color: 'var(--text)',
                  fontFamily: 'var(--font-sans)', cursor: 'pointer',
                }}
              >
                <option value="">All Categories</option>
                {Object.entries(categories).map(([key, cat]) => (
                  <option key={key} value={key}>{cat.label}</option>
                ))}
              </select>
            </div>

            {/* Template list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 24px 24px' }}>
              {selectedTemplate ? (
                /* Env var configuration step */
                <div style={{ padding: '16px 0' }}>
                  <button onClick={() => setSelectedTemplate(null)} style={{
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)',
                    fontSize: 12, padding: 0, marginBottom: 12, fontFamily: 'var(--font-sans)',
                  }}>&larr; Back to library</button>
                  <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
                    {selectedTemplate.logo ? <img className="icon-adaptive" src={`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${selectedTemplate.logo}.svg`} alt="" width={20} height={20} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 8, borderRadius: 3, opacity: 0.8 }} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : null}{selectedTemplate.name}
                  </h3>
                  <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)' }}>
                    {selectedTemplate.description}
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {selectedTemplate.envKeys.map((env: any) => (
                      <div key={env.key}>
                        <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 4 }}>
                          {env.label} {env.required && <span style={{ color: '#ef4444' }}>*</span>}
                        </label>
                        <input
                          type="password"
                          placeholder={env.placeholder || env.key}
                          value={templateEnvValues[env.key] || ''}
                          onChange={e => setTemplateEnvValues(prev => ({ ...prev, [env.key]: e.target.value }))}
                          style={{
                            width: '100%', padding: '8px 12px', borderRadius: 8,
                            border: '1px solid var(--border)', background: 'var(--surface-2)',
                            fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)',
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => installTemplate(selectedTemplate)}
                    disabled={installingTemplate === selectedTemplate.id}
                    style={{
                      marginTop: 16, background: 'var(--accent)', color: 'var(--accent-fg)',
                      border: 'none', borderRadius: 8, padding: '9px 24px', fontSize: 13,
                      fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    {installingTemplate === selectedTemplate.id
                      ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Installing...</>
                      : 'Add to Catalog'}
                  </button>
                </div>
              ) : (
                /* Template grid */
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, paddingTop: 8 }}>
                  {filteredTemplates.map(t => {
                    const isInstalled = installedIds.has(t.id);
                    const isInstalling = installingTemplate === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => !isInstalled && installTemplate(t)}
                        disabled={isInstalled || isInstalling}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px',
                          background: isInstalled ? 'var(--surface-2)' : 'var(--surface)',
                          border: '1px solid var(--border)', borderRadius: 10,
                          cursor: isInstalled ? 'default' : 'pointer', textAlign: 'left',
                          fontFamily: 'var(--font-sans)', transition: 'border-color 0.15s, box-shadow 0.15s',
                          opacity: isInstalled ? 0.6 : 1,
                        }}
                        onMouseEnter={e => { if (!isInstalled) { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 1px var(--accent)'; } }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none'; }}
                      >
                        <span style={{ width: 24, height: 24, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {t.logo ? (
                            <img
                              className="icon-adaptive"
                              src={`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${t.logo}.svg`}
                              alt={t.name}
                              width={20} height={20}
                              style={{ borderRadius: 3, opacity: 0.8 }}
                              onError={e => {
                                const el = e.target as HTMLImageElement;
                                el.style.display = 'none';
                                el.parentElement!.querySelector('span')!.style.display = 'flex';
                              }}
                            />
                          ) : null}
                          <span style={{
                            display: t.logo ? 'none' : 'flex',
                            width: 24, height: 24, borderRadius: 6,
                            background: 'var(--border)', color: 'var(--muted)',
                            alignItems: 'center', justifyContent: 'center',
                            fontSize: 12, fontWeight: 700,
                          }}>{t.name.charAt(0)}</span>
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 4 }}>
                            {t.name}
                            {isInstalled && <Check size={13} style={{ color: 'var(--success, #22c55e)' }} />}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>
                            {t.description}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--subtle)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            {t.transport === 'http' ? 'Remote' : 'Local'}{t.official && ' · Official'}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {filteredTemplates.length === 0 && !selectedTemplate && (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--muted)', fontSize: 13 }}>
                  No servers match your search.
                </div>
              )}
            </div>
          </div>
        </div></Portal>
      )}
    </div>
  );
}

// ─── Env entries editor ───────────────────────────────────────────────────────

function EnvEntriesEditor({
  entries, envVarKeys, onAdd, onRemove, onUpdate,
}: {
  entries: EnvEntry[];
  envVarKeys: string[];
  onAdd: () => void;
  onRemove: (i: number) => void;
  onUpdate: (i: number, patch: Partial<EnvEntry>) => void;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>Environment Variables</label>
        <button type="button" onClick={onAdd} style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 5,
          color: 'var(--muted)', fontSize: 11, padding: '2px 10px', cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
        }}>+ Add</button>
      </div>

      {entries.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--subtle)', margin: 0, fontStyle: 'italic' }}>
          No env vars — click + Add to inject variables into the subprocess.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {entries.map((entry, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr auto', gap: 6, alignItems: 'center' }}>
              {/* Key */}
              <input
                value={entry.key}
                onChange={e => onUpdate(i, { key: e.target.value })}
                placeholder="KEY_NAME"
                style={{
                  background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                  padding: '6px 9px', color: 'var(--text)', fontSize: 12.5,
                  fontFamily: 'var(--font-mono)', outline: 'none',
                }}
              />
              {/* Mode toggle */}
              <select
                value={entry.mode}
                onChange={e => onUpdate(i, { mode: e.target.value as 'value' | 'ref', val: '' })}
                style={{
                  background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                  padding: '6px 8px', color: 'var(--muted)', fontSize: 11.5,
                  fontFamily: 'var(--font-sans)', cursor: 'pointer', outline: 'none',
                }}
              >
                <option value="value">Custom value</option>
                <option value="ref">From env vars</option>
              </select>
              {/* Value or ref picker */}
              {entry.mode === 'value' ? (
                <input
                  type="password"
                  value={entry.val}
                  onChange={e => onUpdate(i, { val: e.target.value })}
                  placeholder={entry.val === '********' ? 'Current value hidden' : 'Enter value'}
                  style={{
                    background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                    padding: '6px 9px', color: 'var(--text)', fontSize: 12.5,
                    fontFamily: 'var(--font-mono)', outline: 'none',
                  }}
                />
              ) : (
                <select
                  value={entry.val}
                  onChange={e => onUpdate(i, { val: e.target.value })}
                  style={{
                    background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                    padding: '6px 9px', color: entry.val ? 'var(--text)' : 'var(--subtle)', fontSize: 12.5,
                    fontFamily: 'var(--font-mono)', outline: 'none', cursor: 'pointer',
                  }}
                >
                  <option value="">— pick env var —</option>
                  {envVarKeys.map(k => <option key={k} value={k}>{k}</option>)}
                  {envVarKeys.length === 0 && <option disabled>No env vars — add in Settings → Env Vars</option>}
                </select>
              )}
              {/* Remove */}
              <button type="button" onClick={() => onRemove(i)} style={{
                background: 'none', border: 'none', color: '#ef4444', fontSize: 14,
                cursor: 'pointer', padding: '4px 6px', lineHeight: 1,
              }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Header entries editor ────────────────────────────────────────────────────

function HeaderEntriesEditor({
  entries, envVarKeys, onAdd, onRemove, onUpdate,
}: {
  entries: HeaderEntry[];
  envVarKeys: string[];
  onAdd: () => void;
  onRemove: (i: number) => void;
  onUpdate: (i: number, patch: Partial<HeaderEntry>) => void;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>Headers</label>
        <button type="button" onClick={onAdd} style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 5,
          color: 'var(--muted)', fontSize: 11, padding: '2px 10px', cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
        }}>+ Add</button>
      </div>

      {entries.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--subtle)', margin: 0, fontStyle: 'italic' }}>
          No headers — click + Add to include HTTP headers (e.g. Authorization).
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {entries.map((entry, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr auto', gap: 6, alignItems: 'center' }}>
                {/* Header name */}
                <input
                  value={entry.name}
                  onChange={e => onUpdate(i, { name: e.target.value })}
                  placeholder="Authorization"
                  style={{
                    background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                    padding: '6px 9px', color: 'var(--text)', fontSize: 12.5,
                    fontFamily: 'var(--font-mono)', outline: 'none',
                  }}
                />
                {/* Mode toggle */}
                <select
                  value={entry.mode}
                  onChange={e => onUpdate(i, { mode: e.target.value as 'value' | 'ref', val: '', prefix: '' })}
                  style={{
                    background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                    padding: '6px 8px', color: 'var(--muted)', fontSize: 11.5,
                    fontFamily: 'var(--font-sans)', cursor: 'pointer', outline: 'none',
                  }}
                >
                  <option value="value">Static value</option>
                  <option value="ref">From env var</option>
                </select>
                {/* Value or env var picker */}
                {entry.mode === 'value' ? (
                  <input
                    value={entry.val}
                    onChange={e => onUpdate(i, { val: e.target.value })}
                    placeholder={entry.name.toLowerCase() === 'authorization' ? 'Bearer sk-...' : 'value'}
                    style={{
                      background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                      padding: '6px 9px', color: 'var(--text)', fontSize: 12.5,
                      fontFamily: 'var(--font-mono)', outline: 'none',
                    }}
                  />
                ) : (
                  <select
                    value={entry.val}
                    onChange={e => onUpdate(i, { val: e.target.value })}
                    style={{
                      background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                      padding: '6px 9px', color: entry.val ? 'var(--text)' : 'var(--subtle)', fontSize: 12.5,
                      fontFamily: 'var(--font-mono)', outline: 'none', cursor: 'pointer',
                    }}
                  >
                    <option value="">— pick env var —</option>
                    {envVarKeys.map(k => <option key={k} value={k}>{k}</option>)}
                    {envVarKeys.length === 0 && <option disabled>No env vars — add in Settings → Env Vars</option>}
                  </select>
                )}
                {/* Remove */}
                <button type="button" onClick={() => onRemove(i)} style={{
                  background: 'none', border: 'none', color: '#ef4444', fontSize: 14,
                  cursor: 'pointer', padding: '4px 6px', lineHeight: 1,
                }}>×</button>
              </div>
              {/* Optional prefix for env var mode */}
              {entry.mode === 'ref' && (
                <div style={{ paddingLeft: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--subtle)', whiteSpace: 'nowrap' }}>Prefix (optional):</span>
                  <input
                    value={entry.prefix}
                    onChange={e => onUpdate(i, { prefix: e.target.value })}
                    placeholder='e.g. "Bearer "'
                    style={{
                      background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                      padding: '4px 9px', color: 'var(--text)', fontSize: 12,
                      fontFamily: 'var(--font-mono)', outline: 'none', width: 180,
                    }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--subtle)' }}>+ value of env var</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Server row ───────────────────────────────────────────────────────────────

function ServerRow({
  server, isLast, onEdit, onDelete, onToggle, onTest, testResult, canEdit,
}: {
  server: McpServer; isLast: boolean;
  onEdit: () => void; onDelete: () => void; onToggle: () => void; onTest: () => void;
  testResult?: { ok: boolean; message?: string; error?: string } | 'testing';
  canEdit: boolean;
}) {
  const cfg = server.config as unknown as Record<string, unknown>;
  const isTs = typeof cfg.tsSource === 'string';
  const preview = server.type === 'stdio'
    ? isTs
      ? '[TypeScript inline script]'
      : `${cfg.command} ${Array.isArray(cfg.args) ? (cfg.args as string[]).join(' ') : ''}`.trim()
    : String(cfg.url ?? '');

  const envCount = Object.keys((cfg.env as object) ?? {}).length + Object.keys((cfg.envRefs as object) ?? {}).length;

  return (
    <div style={{
      borderBottom: isLast ? 'none' : '1px solid var(--border)',
      opacity: server.enabled ? 1 : 0.55,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px',
        transition: 'background 0.12s',
      }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
      >
        {/* Type badge */}
        <span style={{
          fontSize: 10.5, fontFamily: 'var(--font-mono)', fontWeight: 500,
          background: 'var(--border)', color: 'var(--muted)',
          padding: '2px 8px', borderRadius: 5, flexShrink: 0, letterSpacing: '0.02em',
        }}>{isTs ? 'ts' : server.type}</span>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{server.name}</span>
            {!server.enabled && (
              <span style={{ fontSize: 10.5, color: 'var(--subtle)', background: 'var(--border)', padding: '1px 6px', borderRadius: 4 }}>
                disabled
              </span>
            )}
            {envCount > 0 && (
              <span style={{ fontSize: 10.5, color: 'var(--muted)', background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 4, border: '1px solid var(--border)' }}>
                {envCount} env var{envCount !== 1 ? 's' : ''}
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
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
          <ActionBtn onClick={onTest} color="var(--muted)" disabled={false}>
            {testResult === 'testing' ? 'Testing…' : 'Test'}
          </ActionBtn>
          <ActionBtn onClick={onToggle} color="var(--muted)" disabled={!canEdit}>
            {server.enabled ? 'Disable' : 'Enable'}
          </ActionBtn>
          {canEdit && <ActionBtn onClick={onEdit} color="var(--accent)">Edit</ActionBtn>}
          {canEdit && <ActionBtn onClick={onDelete} color="#ef4444">Delete</ActionBtn>}
        </div>
      </div>

      {/* Test result banner */}
      {testResult && testResult !== 'testing' && (
        <div style={{
          margin: '0 16px 10px', padding: '8px 12px', borderRadius: 7, fontSize: 12,
          background: testResult.ok ? 'rgba(5,150,105,0.08)' : 'rgba(239,68,68,0.08)',
          border: `1px solid ${testResult.ok ? 'rgba(5,150,105,0.25)' : 'rgba(239,68,68,0.25)'}`,
          color: testResult.ok ? '#059669' : '#ef4444',
        }}>
          {testResult.ok ? '✓ ' : '✗ '}{testResult.ok ? testResult.message : testResult.error}
        </div>
      )}
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
