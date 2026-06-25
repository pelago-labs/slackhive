'use client';

/**
 * @fileoverview Settings → MCP Catalog page.
 * Global MCP server catalog — add, edit, enable/disable, delete, test.
 * Supports stdio, SSE, HTTP, and inline TypeScript transports.
 *
 * @module web/settings/mcps/page
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import type { McpServer, McpServerType } from '@slackhive/shared';
// Use the client-safe subpath, NOT the '@slackhive/shared' barrel: the barrel re-exports
// server/DB code AND the ~430KB persona catalog, none of which the CJS build tree-shakes
// out of the client bundle. The subpath (see the package's exports map) is the pure
// templates module, keeping this page's bundle light.
import { MCP_TEMPLATES } from '@slackhive/shared/mcp-templates';
import { useAuth } from '@/lib/auth-context';
import { Plug, Library, Search, X, Check, Loader2, Plus, ListFilter, MoreHorizontal, Terminal, Globe, Radio, Power, Trash2, ExternalLink, Info } from 'lucide-react';
import { Portal } from '@/lib/portal';
import { parseMcpJson, serializeMcpJson } from '@/lib/mcp-json';
import type { McpServerConfig } from '@slackhive/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { PageShell } from '@/components/patterns';

/** Shared field-control classes — inputs / textareas / selects in this page. */
const CONTROL_CLASS = 'w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-ring placeholder:text-muted-foreground';
/** Compact control used inside the env-var / header grid rows. */
const SMALL_CONTROL_CLASS = 'rounded-md border border-input bg-secondary px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-ring placeholder:text-muted-foreground';

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

/** Default JSON template — Cursor/Claude Desktop shape. Shown when opening "Add MCP Server". */
const DEFAULT_JSON_TEMPLATE = `{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": {
        "API_KEY": "\${env:MY_API_KEY}"
      }
    }
  }
}`;

// ─── Page ────────────────────────────────────────────────────────────────────

export default function McpSettingsPage() {
  const { canEdit, username, role } = useAuth();
  const [servers, setServers]       = useState<McpServer[]>([]);
  const [serverSearch, setServerSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'stdio' | 'sse' | 'http'>('all');
  const [sortBy, setSortBy]         = useState<'newest' | 'oldest' | 'name'>('newest');
  const [loading, setLoading]       = useState(true);
  const [form, setForm]             = useState<McpFormState>(DEFAULT_FORM);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [showForm, setShowForm]     = useState(false);
  const [envVarKeys, setEnvVarKeys] = useState<string[]>([]);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message?: string; error?: string; tools?: string[] } | 'testing'>>({});
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

  // JSON-mode state (the default entry point — mirrors Cursor/Claude Desktop/VS Code UX)
  const [jsonMode, setJsonMode] = useState(true);
  const [jsonInput, setJsonInput] = useState('');
  const [envInline, setEnvInline] = useState<{ key: string; value: string; saving: boolean } | null>(null);

  const saveMissingEnvVar = async () => {
    if (!envInline || !envInline.value) return;
    setEnvInline({ ...envInline, saving: true });
    try {
      const r = await fetch('/api/env-vars', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: envInline.key, value: envInline.value }),
      });
      if (!r.ok) { const b = await r.json(); throw new Error(b.error ?? 'Failed'); }
      const rows = await fetch('/api/env-vars').then(r => r.json()) as { key: string }[];
      setEnvVarKeys(rows.map(r => r.key));
      setEnvInline(null);
    } catch (err) {
      setEnvInline({ ...envInline, saving: false });
      setError((err as Error).message);
    }
  };

  useEffect(() => { load(); }, []);

  // Handle OAuth callback redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth') === 'success' && params.get('state')) {
      const state = params.get('state')!;
      // Fetch the stored token and auto-install
      fetch(`/api/settings?key=oauth_token:${state}`).catch(() => {});
      (async () => {
        try {
          const r = await fetch('/api/settings');
          const settings = await r.json();
          const tokenData = settings[`oauth_token:${state}`];
          if (tokenData) {
            const parsed = JSON.parse(tokenData);
            // Install the MCP with the OAuth token
            await fetch('/api/mcps/templates', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ templateId: parsed.templateId, envValues: { __OAUTH_ACCESS_TOKEN: parsed.accessToken } }),
            });
            await load();
          }
        } catch { /* ignore */ }
        // Clean URL
        window.history.replaceState({}, '', '/settings/mcps');
      })();
    }
  }, []);
  useEffect(() => {
    if (showForm && formRef.current) {
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showForm, editingId]);
  useEffect(() => {
    // Load available env var keys for the ref dropdown
    fetch('/api/env-vars').then(r => r.json()).then((rows: { key: string }[]) => setEnvVarKeys(rows.map(r => r.key))).catch(() => {});
  }, []);

  // CLI-detected MCPs — only relevant when the active backend is Claude Code
  // (Codex doesn't read Claude's CLI config), so we gate the section on it.
  const [cliMcps, setCliMcps] = useState<any[]>([]);
  const [backend, setBackend] = useState<string>('claude');

  useEffect(() => {
    fetch('/api/mcps/detected').then(r => r.json()).then(d => setCliMcps(d.detected ?? [])).catch(() => {});
    fetch('/api/settings').then(r => r.json()).then((s: Record<string, string>) => setBackend(s.agentBackend || 'claude')).catch(() => {});
  }, []);

  const isClaudeBackend = backend === 'claude';

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/mcps');
      setServers(await r.json());
    } finally { setLoading(false); }
  };

  // ─── Template library ──────────────────────────────────────────────────────

  // Detected MCPs from Claude CLI
  const [detectedNames, setDetectedNames] = useState<Set<string>>(new Set());

  const loadTemplates = async () => {
    try {
      const [templatesRes, detectedRes] = await Promise.all([
        fetch('/api/mcps/templates'),
        fetch('/api/mcps/detected'),
      ]);
      const data = await templatesRes.json();
      setTemplates(data.templates);
      setCategories(data.categories);
      // Mark already-installed servers
      const installed = new Set(servers.map(s => s.name));
      setInstalledIds(installed as Set<string>);
      // Mark detected MCPs from Claude CLI
      try {
        const det = await detectedRes.json();
        const names = new Set<string>((det.detected ?? []).map((d: any) => d.name));
        setDetectedNames(names);
      } catch { /* ignore */ }
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
    // Show config step if: has env vars, is OAuth, or has optional paths
    const needsConfig = template.auth === 'oauth' || template.envKeys.length > 0;
    if (needsConfig && !selectedTemplate) {
      setSelectedTemplate(template);
      setTemplateEnvValues({});
      return;
    }

    // For OAuth: pass the pasted token as a special env value
    const envValues = { ...templateEnvValues };
    if (template.auth === 'oauth' && envValues.__oauth_token) {
      envValues['__OAUTH_ACCESS_TOKEN'] = envValues.__oauth_token;
      delete envValues.__oauth_token;
    }

    setInstallingTemplate(template.id);
    try {
      const r = await fetch('/api/mcps/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: template.id, envValues }),
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
      if (f.args.trim()) cfg.args = parseArgsField(f.args);
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

  // Args field accepts either a JSON array (`["-y","pkg,with,commas"]`) or a
  // comma-separated string (legacy). JSON wins when it parses to a string[].
  const parseArgsField = (raw: string): string[] => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.every(a => typeof a === 'string')) return parsed;
      } catch { /* fall through to comma-split */ }
    }
    return raw.split(',').map(a => a.trim()).filter(Boolean);
  };

  const entriesToEnv = (entries: EnvEntry[]) =>
    Object.fromEntries(entries.filter(e => e.mode === 'value' && e.key).map(e => [e.key, e.val]));

  const entriesToRefs = (entries: EnvEntry[]) =>
    Object.fromEntries(entries.filter(e => e.mode === 'ref' && e.key && e.val).map(e => [e.key, e.val]));

  // API type is always 'stdio' for typescript
  const apiType = (uiType: UiTransportType): McpServerType =>
    uiType === 'typescript' ? 'stdio' : uiType;

  // Infer UI transport type from a raw config row.
  const inferUiType = (cfg: Record<string, unknown>): UiTransportType => {
    if (typeof cfg.tsSource === 'string') return 'typescript';
    if (typeof cfg.url === 'string') return cfg.type === 'http' ? 'http' : 'sse';
    return 'stdio';
  };

  /**
   * Decompose an McpServerConfig into the form fields the granular editor
   * needs. Shared by handleEdit (loading a saved server) and toggleMode
   * (switching from JSON view to form view).
   *
   * @param cfg      Raw config record (an McpServerConfig cast to Record).
   * @param argStyle How to render args: 'comma' for the legacy form-mode
   *                 input, 'json' for the JSON-array placeholder shown after
   *                 a JSON→form toggle.
   */
  const configToFormState = (cfg: Record<string, unknown>, argStyle: 'comma' | 'json'): Pick<
    McpFormState,
    'uiType' | 'command' | 'args' | 'envEntries' | 'tsSource' | 'url' | 'headerEntries'
  > => {
    const uiType = inferUiType(cfg);
    const envObj = (cfg.env as Record<string, string>) ?? {};
    const envRefsObj = (cfg.envRefs as Record<string, string>) ?? {};
    const envEntries: EnvEntry[] = [
      ...Object.entries(envObj).map(([k, v]) => ({ key: k, mode: 'value' as const, val: v })),
      ...Object.entries(envRefsObj).map(([k, v]) => ({ key: k, mode: 'ref' as const, val: v })),
    ];
    const headersObj = (cfg.headers as Record<string, string>) ?? {};
    const headerEntries: HeaderEntry[] = Object.entries(headersObj).map(([name, rawVal]) => {
      if (envRefsObj[name] !== undefined) {
        return { name, mode: 'ref' as const, val: envRefsObj[name], prefix: rawVal };
      }
      return { name, mode: 'value' as const, val: rawVal, prefix: '' };
    });
    const args = Array.isArray(cfg.args)
      ? (argStyle === 'json' ? JSON.stringify(cfg.args) : (cfg.args as string[]).join(', '))
      : '';
    return {
      uiType,
      command: (cfg.command as string) ?? '',
      args,
      envEntries,
      tsSource: uiType === 'typescript' ? (cfg.tsSource as string) : DEFAULT_FORM.tsSource,
      url: (cfg.url as string) ?? '',
      headerEntries,
    };
  };

  // ─── Handlers ───────────────────────────────────────────────────────────────

  // Live-parse the JSON textarea — drives the inline status line + Save enable
  const jsonParse = useMemo(
    () => (jsonMode ? parseMcpJson(jsonInput) : null),
    [jsonMode, jsonInput],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      if (!form.description.trim()) throw new Error('Description is required — please fill it in before saving.');
      let body: Record<string, unknown>;
      if (jsonMode) {
        if (!jsonParse || !jsonParse.ok) throw new Error(jsonParse && !jsonParse.ok ? jsonParse.error : 'Invalid JSON');
        const { name: parsedName, config } = jsonParse;
        // Bare shape (no mcpServers wrapper) has parsedName === null — fall back
        // to the Name input shown inline in that case.
        const finalName = parsedName ?? form.name.trim();
        if (!finalName) throw new Error('Name is required — add it in the Name field below or wrap your JSON in `{ "mcpServers": { "<name>": { ... } } }`.');
        const c = config as unknown as Record<string, unknown>;
        const type: McpServerType = typeof c.url === 'string' ? (c.type === 'http' ? 'http' : 'sse') : 'stdio';
        body = {
          name: finalName,
          type,
          description: form.description || undefined,
          enabled: form.enabled,
          config,
        };
      } else {
        body = {
          name: form.name,
          type: apiType(form.uiType),
          description: form.description || undefined,
          enabled: form.enabled,
          config: buildConfig(form),
        };
      }
      const r = await fetch(editingId ? `/api/mcps/${editingId}` : '/api/mcps', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
      const result = await r.json() as { ok: boolean; message?: string; error?: string; tools?: string[] };
      setTestResults(prev => ({ ...prev, [server.id]: result }));
    } catch {
      setTestResults(prev => ({ ...prev, [server.id]: { ok: false, error: 'Request failed' } }));
    }
  };

  const handleEdit = (server: McpServer) => {
    const cfg = server.config as unknown as Record<string, unknown>;
    const isTs = typeof cfg.tsSource === 'string';
    // typescript has no sensible JSON representation — force form mode
    setJsonMode(!isTs);
    setJsonInput(isTs ? '' : serializeMcpJson(server.name, server.config as McpServerConfig));
    setForm({
      name: server.name,
      description: server.description ?? '',
      enabled: server.enabled,
      ...configToFormState(cfg, 'comma'),
    });
    setEditingId(server.id);
    setShowForm(true);
  };

  const resetForm = () => {
    setForm(DEFAULT_FORM);
    setEditingId(null);
    setShowForm(false);
    setError('');
    setJsonMode(true);
    setJsonInput(DEFAULT_JSON_TEMPLATE);
  };

  const openAddForm = () => {
    setForm(DEFAULT_FORM);
    setEditingId(null);
    setError('');
    setJsonMode(true);
    setJsonInput(DEFAULT_JSON_TEMPLATE);
    setShowForm(true);
  };

  /** Switch between form ↔ JSON. Re-seed the target view from the source view's state. */
  const toggleMode = () => {
    if (jsonMode) {
      // JSON → form: parse current JSON and populate form fields
      const parsed = parseMcpJson(jsonInput);
      if (!parsed.ok) { setError(parsed.error); return; }
      const cfg = parsed.config as unknown as Record<string, unknown>;
      setForm(prev => ({
        ...prev,
        name: form.name || parsed.name || '',
        ...configToFormState(cfg, 'json'),
      }));
      setJsonMode(false);
      setError('');
    } else {
      // form → JSON: rebuild JSON text from the current form state
      if (form.uiType === 'typescript') { setError('TypeScript transport has no JSON form — stay in form mode.'); return; }
      const cfg = buildConfig(form) as McpServerConfig;
      setJsonInput(serializeMcpJson(form.name || 'server', cfg));
      setJsonMode(true);
      setError('');
    }
  };

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

  const visibleServers = useMemo(() => {
    const q = serverSearch.toLowerCase();
    return servers
      .filter(s => typeFilter === 'all' || s.type === typeFilter)
      .filter(s => !q || s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
      .sort((a, b) => sortBy === 'name'
        ? a.name.localeCompare(b.name)
        : sortBy === 'oldest'
          ? +new Date(a.createdAt) - +new Date(b.createdAt)
          : +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [servers, serverSearch, typeFilter, sortBy]);

  const detectedAvailable = cliMcps.filter(d => !servers.find(s => s.name === d.name));

  const selectClass = 'cursor-pointer rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring';

  return (
    <PageShell>
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Settings</div>
          <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">
            MCP Catalog
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Discover, test, and manage MCP servers for your agents.
          </p>
        </div>
        {canEdit && !showForm && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={openLibrary}><Library size={14} /> Browse Library</Button>
            <Button onClick={openAddForm}><Plus size={15} /> Custom Server</Button>
          </div>
        )}
      </div>

      {/* Toolbar — search · type filter · sort */}
      {!showForm && servers.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-0 flex-[1_1_260px]">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input type="text" placeholder="Search MCP servers…" value={serverSearch} onChange={e => setServerSearch(e.target.value)}
              className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm text-foreground outline-none focus:border-ring placeholder:text-muted-foreground" />
          </div>
          <div className="relative">
            <ListFilter size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as 'all' | 'stdio' | 'sse' | 'http')} className={cn(selectClass, 'pl-8')}>
              <option value="all">All Types</option>
              <option value="stdio">STDIO</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
            </select>
          </div>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as 'newest' | 'oldest' | 'name')} className={selectClass}>
            <option value="newest">Sort: Newest</option>
            <option value="oldest">Sort: Oldest</option>
            <option value="name">Sort: Name</option>
          </select>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2.5 rounded-xl border border-border py-12 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          Loading tools…
        </div>
      ) : servers.length === 0 && !showForm ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
          <div className="mb-2.5 flex justify-center"><Plug size={28} className="text-border" /></div>
          <p className="mb-1 text-md font-medium text-muted-foreground">No MCP servers yet</p>
          <p className="mb-4 text-sm">Add tools like GitHub, Notion, Figma, and 50+ more from the library.</p>
          {canEdit && <div className="flex justify-center gap-2">
            <Button onClick={openLibrary}><Library size={14} /> Browse Library</Button>
            <Button variant="outline" onClick={openAddForm}>Add Custom</Button>
          </div>}
        </div>
      ) : !showForm && (
        <>
          {/* Installed section */}
          <div className="mb-3">
            <div className="text-sm font-semibold text-foreground">
              Installed Servers <span className="font-medium text-muted-foreground">· {visibleServers.length}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">These servers are available to all agents in your workspace.</p>
          </div>
          {visibleServers.length === 0 ? (
            <div className="mb-6 rounded-xl border border-dashed border-border p-7 text-center text-sm text-muted-foreground">
              No servers match your filters.
            </div>
          ) : (
            <div className="mb-6 overflow-hidden rounded-xl border border-border bg-card">
              {visibleServers.map((server, i, arr) => (
                <ServerRow
                  key={server.id} server={server}
                  isLast={i === arr.length - 1}
                  onEdit={() => handleEdit(server)}
                  onDelete={() => handleDelete(server.id)}
                  onToggle={() => handleToggle(server)}
                  onTest={() => handleTest(server)}
                  onDismissTest={() => setTestResults(prev => { const n = { ...prev }; delete n[server.id]; return n; })}
                  testResult={testResults[server.id]}
                  canEdit={canEdit}
                  canMutate={canEdit && (role === 'admin' || role === 'superadmin' || server.createdBy === username)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Detected from Claude Code CLI — Claude backend only */}
      {isClaudeBackend && detectedAvailable.length > 0 && !showForm && (
        <div className="mt-2">
          <div className="mb-3">
            <div className="text-sm font-semibold text-foreground">
              Discovered from Claude Code <span className="font-medium text-muted-foreground">· {detectedAvailable.length}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">These servers were detected in your environment. Add to the catalog to use them with agents.</p>
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {detectedAvailable.map((d, i, arr) => {
              const tpl = MCP_TEMPLATES.find(t => t.id === d.name || t.name.toLowerCase() === d.name.toLowerCase());
              const TypeIcon = d.type === 'http' ? Globe : d.type === 'sse' ? Radio : Terminal;
              return (
                <div key={d.name} className={cn('flex items-center gap-3 px-4 py-3', i < arr.length - 1 && 'border-b border-border')}>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-foreground">
                    {tpl?.logo ? (
                      <img className="icon-adaptive rounded-sm opacity-80" src={`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${tpl.logo}.svg`}
                        alt="" width={18} height={18}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    ) : <TypeIcon size={17} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{d.name}</span>
                      <span className="rounded-md border border-border bg-secondary px-1.5 py-px font-mono text-2xs font-semibold tracking-wide text-muted-foreground">{String(d.type).toUpperCase()}</span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">{d.url || d.command}</p>
                  </div>
                  <span className="shrink-0 rounded bg-blue/10 px-1.5 py-0.5 text-2xs font-semibold text-blue">CLI</span>
                  {canEdit && (
                    <Button size="sm" onClick={async () => {
                      const config = d.url ? { url: d.url } : { command: d.command, args: [] };
                      await fetch('/api/mcps', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: d.name, type: d.type === 'http' ? 'http' : d.type === 'sse' ? 'sse' : 'stdio', config, enabled: true }),
                      });
                      setCliMcps(prev => prev.filter(m => m.name !== d.name));
                      await load();
                    }}>Add to Catalog</Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      {!showForm && !loading && (
        <div className="mt-7 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Info size={14} className="text-muted-foreground" />
          Learn more about MCP servers and how to integrate them with your agents.
          <a href="https://slackhive.mintlify.app" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground no-underline">
            View Documentation <ExternalLink size={12} />
          </a>
        </div>
      )}

      {/* Add/Edit form */}
      {showForm && (
        <div ref={formRef} className="mt-1 rounded-xl border border-border bg-card p-7">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="m-0 text-md font-semibold text-foreground">
              {editingId ? 'Edit Server' : 'Add MCP Server'}
            </h2>
            <button onClick={resetForm} className="text-lg text-muted-foreground hover:text-foreground">×</button>
          </div>

          {error && (
            <div className="mb-4 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
          )}

          {form.uiType !== 'typescript' && (
            <div className="mb-5 flex border-b border-border">
              {([
                { id: 'json', label: 'JSON', active: jsonMode },
                { id: 'form', label: 'Form', active: !jsonMode },
              ] as const).map(tab => (
                <button key={tab.id} type="button"
                  onClick={() => { if (tab.active) return; toggleMode(); }}
                  className={cn(
                    '-mb-px border-b-2 px-4 py-2 text-sm font-medium',
                    tab.active ? 'cursor-default border-primary text-foreground' : 'cursor-pointer border-transparent text-muted-foreground',
                  )}>{tab.label}</button>
              ))}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {jsonMode ? (
              <>
                <FField label="Config JSON *" className="mb-1.5"
                  hint={<>Paste a Cursor / Claude Desktop / VS Code config. Use <code className="rounded-sm bg-primary/15 px-1 py-px font-mono">{'${env:NAME}'}</code> for secrets — pulled from your <a href="/settings/env-vars" className="text-primary no-underline">env vars</a> at runtime.</>}>
                  <textarea value={jsonInput} onChange={e => setJsonInput(e.target.value)}
                    rows={Math.max(10, Math.min(24, (jsonInput.match(/\n/g)?.length ?? 0) + 2))}
                    required spellCheck={false} {...inputStyle(true)} />
                </FField>
                <div className="mb-3.5 min-h-[18px] text-xs">
                  {jsonParse && jsonParse.ok ? (
                    <span className="text-primary">
                      ✓ Valid config{jsonParse.name ? ` for "${jsonParse.name}"` : ''}
                      {jsonParse.warnings.length > 0 && (
                        <span className="ml-2 text-muted-foreground">· {jsonParse.warnings.join(' ')}</span>
                      )}
                    </span>
                  ) : jsonParse && !jsonParse.ok ? (
                    <span className="text-destructive">
                      ⚠ {jsonParse.error}{jsonParse.line ? ` (line ${jsonParse.line})` : ''}
                    </span>
                  ) : null}
                </div>

                {/* Env ref resolution: show which ${env:NAME} refs are wired up to the platform env-var store. */}
                {jsonParse && jsonParse.ok && (() => {
                  const refs = ((jsonParse.config as unknown as Record<string, unknown>).envRefs as Record<string, string> | undefined) ?? {};
                  const refNames = Array.from(new Set(Object.values(refs)));
                  if (refNames.length === 0) return null;
                  const known = new Set(envVarKeys);
                  const missing = refNames.filter(n => !known.has(n));
                  return (
                    <div className="mb-3.5 rounded-md border border-border bg-secondary px-3 py-2.5">
                      <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.03em] text-muted-foreground">
                        Env vars referenced
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {refNames.map(name => {
                          const found = known.has(name);
                          const clickable = !found;
                          return (
                            <span key={name}
                              onClick={clickable ? () => setEnvInline({ key: name, value: '', saving: false }) : undefined}
                              title={clickable ? 'Click to add value' : 'Found in env vars'}
                              className={cn(
                                'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-xs',
                                found ? 'border-green/25 bg-green/10 text-green' : 'border-destructive/25 bg-destructive/10 text-destructive',
                                clickable ? 'cursor-pointer' : 'cursor-default',
                              )}>
                              {found ? <Check size={11} /> : <X size={11} />}
                              {name}
                            </span>
                          );
                        })}
                      </div>
                      {envInline && missing.includes(envInline.key) && (
                        <div className="mt-2.5 flex items-center gap-1.5">
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {envInline.key} =
                          </span>
                          <input autoFocus type="password"
                            value={envInline.value}
                            onChange={e => setEnvInline({ ...envInline, value: e.target.value })}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveMissingEnvVar(); } }}
                            placeholder="secret value"
                            {...inputStyle(true)} />
                          <Button type="button" size="sm" className="shrink-0" onClick={saveMissingEnvVar}
                            disabled={envInline.saving || !envInline.value}>{envInline.saving ? 'Saving…' : 'Save'}</Button>
                          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setEnvInline(null)}>Cancel</Button>
                        </div>
                      )}
                      {missing.length > 0 && !envInline && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          Click a red chip to set its value.
                        </div>
                      )}
                    </div>
                  );
                })()}
                {/* Bare-shape paste: no `mcpServers` wrapper → prompt for a name rather than erroring at save. */}
                {jsonParse && jsonParse.ok && jsonParse.name === null && (
                  <FField label="Name *" required className="mb-3.5"
                    hint="Your JSON has no `mcpServers` wrapper — give the server a name here.">
                    <input value={form.name} onChange={e => f('name', e.target.value)}
                      placeholder="redshift-mcp" required {...inputStyle()} />
                  </FField>
                )}
                <FField label="Description *" required className="mb-3.5">
                  <input value={form.description} onChange={e => f('description', e.target.value)}
                    placeholder="What does this MCP server provide?" required {...inputStyle()} />
                </FField>
              </>
            ) : (
              <>
            <div className="mb-3.5 grid grid-cols-2 gap-3.5">
              <FField label="Name *" required>
                <input value={form.name} onChange={e => f('name', e.target.value)} placeholder="redshift-mcp"
                  required {...inputStyle()} />
                <small className="mt-1 block text-2xs text-muted-foreground">
                  Tool pattern: <code className="font-mono">mcp__name__tool</code>
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

            <FField label="Description" className="mb-3.5">
              <input value={form.description} onChange={e => f('description', e.target.value)}
                placeholder="What does this MCP server provide?" {...inputStyle()} />
            </FField>

            {/* stdio fields */}
            {form.uiType === 'stdio' && (
              <>
                <FField label="Command *" className="mb-3.5">
                  <input value={form.command} onChange={e => f('command', e.target.value)}
                    placeholder="node" required {...inputStyle(true)} />
                </FField>
                <FField label="Arguments" hint="JSON array or comma-separated. JSON preserves commas inside args." className="mb-3.5">
                  <input value={form.args} onChange={e => f('args', e.target.value)}
                    placeholder='["-y", "@pkg/name"] or -y, @pkg/name' {...inputStyle(true)} />
                </FField>
                <EnvEntriesEditor entries={form.envEntries} envVarKeys={envVarKeys}
                  onAdd={addEnvEntry} onRemove={removeEnvEntry} onUpdate={updateEnvEntry} />
              </>
            )}

            {/* TypeScript inline script */}
            {form.uiType === 'typescript' && (
              <>
                <FField label="TypeScript Source *" className="mb-3.5"
                  hint="The runner saves this to disk and executes it with tsx. Must implement the MCP stdio protocol.">
                  <textarea value={form.tsSource} onChange={e => f('tsSource', e.target.value)}
                    rows={14} required {...inputStyle(true)} />
                </FField>
                <EnvEntriesEditor entries={form.envEntries} envVarKeys={envVarKeys}
                  onAdd={addEnvEntry} onRemove={removeEnvEntry} onUpdate={updateEnvEntry} />
              </>
            )}

            {/* SSE / HTTP fields */}
            {(form.uiType === 'sse' || form.uiType === 'http') && (
              <>
                <FField label="URL *" className="mb-3.5">
                  <input value={form.url} onChange={e => f('url', e.target.value)}
                    placeholder="https://mcp.example.com/sse" required type="url" {...inputStyle(true)} />
                </FField>
                <HeaderEntriesEditor
                  entries={form.headerEntries} envVarKeys={envVarKeys}
                  onAdd={addHeaderEntry} onRemove={removeHeaderEntry} onUpdate={updateHeaderEntry}
                />
              </>
            )}

              </>
            )}

            <label className="mb-5 flex cursor-pointer items-center gap-2.5">
              <input type="checkbox" checked={form.enabled} onChange={e => f('enabled', e.target.checked)}
                className="h-3.5 w-3.5 accent-primary" />
              <span className="text-sm text-muted-foreground">
                Enabled — available for agents to use
              </span>
            </label>

            {(() => {
              const jsonInvalid = jsonMode && !(jsonParse && jsonParse.ok);
              const bareWithoutName = !!(jsonMode && jsonParse && jsonParse.ok && jsonParse.name === null && !form.name.trim());
              const submitDisabled = saving || jsonInvalid || bareWithoutName;
              return (
            <div className="flex gap-2.5">
              <Button type="submit" disabled={submitDisabled}>{saving ? 'Saving…' : editingId ? 'Update Server' : 'Add Server'}</Button>
              <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
            </div>
              );
            })()}
          </form>
        </div>
      )}

      {/* ─── Template Library Modal ─────────────────────────────────────────── */}
      {showLibrary && (
        <Portal><div className="fixed inset-0 z-[1000] flex items-center justify-center p-10">
          <div className="fixed inset-0 bg-black/50" onClick={() => { setShowLibrary(false); setSelectedTemplate(null); }} />
          <div className="relative flex h-full max-h-full w-full max-w-[720px] flex-col rounded-2xl border border-border bg-background shadow-lg">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-border px-6 pb-4 pt-5">
              <div>
                <h2 className="m-0 text-lg font-semibold text-foreground">
                  MCP Server Library
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {templates.length} pre-configured servers — click to add
                </p>
              </div>
              <button onClick={() => { setShowLibrary(false); setSelectedTemplate(null); }} className="p-1 text-muted-foreground hover:text-foreground"><X size={18} /></button>
            </div>

            {/* Search + category filter */}
            <div className="flex items-center gap-2.5 border-b border-border px-6 py-3">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search servers..."
                  value={templateSearch}
                  onChange={e => setTemplateSearch(e.target.value)}
                  className="w-full rounded-md border border-input bg-secondary py-1.5 pl-8 pr-2.5 text-sm text-foreground outline-none focus:border-ring placeholder:text-muted-foreground"
                />
              </div>
              <select
                value={selectedCategory ?? ''}
                onChange={e => setSelectedCategory(e.target.value || null)}
                className="cursor-pointer rounded-md border border-input bg-secondary px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-ring"
              >
                <option value="">All Categories</option>
                {Object.entries(categories).map(([key, cat]) => (
                  <option key={key} value={key}>{cat.label}</option>
                ))}
              </select>
            </div>

            {/* Template list */}
            <div className="flex-1 overflow-y-auto px-6 pb-6 pt-2">
              {selectedTemplate ? (
                /* Configuration step */
                <div className="py-4">
                  <button onClick={() => { setSelectedTemplate(null); setTemplateEnvValues({}); }} className="mb-3 text-xs text-muted-foreground hover:text-foreground">&larr; Back to library</button>

                  {/* Header */}
                  <div className="mb-1 flex items-center gap-2.5">
                    {selectedTemplate.logo && <img className="icon-adaptive rounded-sm opacity-80" src={`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${selectedTemplate.logo}.svg`} alt="" width={22} height={22} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
                    <h3 className="m-0 text-md font-semibold text-foreground">{selectedTemplate.name}</h3>
                    {selectedTemplate.auth === 'oauth' && <span className="rounded bg-blue/10 px-1.5 py-0.5 text-2xs font-semibold text-blue">OAuth</span>}
                    {selectedTemplate.auth === 'none' && <span className="rounded bg-secondary px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">No auth</span>}
                  </div>
                  <p className="mb-4 text-sm text-muted-foreground">{selectedTemplate.description}</p>

                  {/* Docs link */}
                  {selectedTemplate.docsUrl && (
                    <a href={selectedTemplate.docsUrl} target="_blank" rel="noopener noreferrer" className="mb-4 inline-flex items-center gap-1.5 text-xs text-blue no-underline">Setup guide &rarr;</a>
                  )}

                  {/* OAuth flow */}
                  {selectedTemplate.auth === 'oauth' && (
                    <div className="mb-4 rounded-lg border border-border bg-secondary px-4 py-4">
                      <OAuthConnectSection template={selectedTemplate} />

                      {/* Paste token */}
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">
                          Paste access token <span className="font-normal text-muted-foreground">(optional if already authenticated via CLI)</span>
                        </label>
                        <input
                          type="password"
                          placeholder="Paste token after authorizing..."
                          value={templateEnvValues['__oauth_token'] || ''}
                          onChange={e => setTemplateEnvValues(prev => ({ ...prev, __oauth_token: e.target.value }))}
                          className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-ring placeholder:text-muted-foreground"
                        />
                      </div>
                    </div>
                  )}

                  {/* Env var fields (for auth: 'env' templates) */}
                  {selectedTemplate.auth !== 'oauth' && selectedTemplate.envKeys.length > 0 && (
                    <div className="mb-4 flex flex-col gap-3">
                      {selectedTemplate.envKeys.map((env: any) => (
                        <div key={env.key}>
                          <label className="mb-1 block text-xs font-medium text-muted-foreground">
                            {env.label} {env.required && <span className="text-destructive">*</span>}
                          </label>
                          <input
                            type={env.key.toLowerCase().includes('password') || env.key.toLowerCase().includes('secret') || env.key.toLowerCase().includes('token') || env.key.toLowerCase().includes('key') ? 'password' : 'text'}
                            placeholder={env.placeholder || env.key}
                            value={templateEnvValues[env.key] || ''}
                            onChange={e => setTemplateEnvValues(prev => ({ ...prev, [env.key]: e.target.value }))}
                            className="w-full rounded-md border border-input bg-secondary px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-ring placeholder:text-muted-foreground"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* No auth — just add */}
                  {selectedTemplate.auth === 'none' && selectedTemplate.envKeys.length === 0 && (
                    <p className="mb-3 text-xs text-muted-foreground">
                      No configuration needed — this tool runs locally.
                    </p>
                  )}

                  {/* Add button */}
                  <Button
                    onClick={() => installTemplate(selectedTemplate)}
                    disabled={installingTemplate === selectedTemplate.id}
                  >
                    {installingTemplate === selectedTemplate.id
                      ? <><Loader2 size={14} className="animate-spin" /> Installing...</>
                      : 'Add to Catalog'}
                  </Button>
                </div>
              ) : (
                /* Template grid */
                <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5 pt-2">
                  {filteredTemplates.map(t => {
                    const isInstalled = installedIds.has(t.id);
                    const isDetected = detectedNames.has(t.id) || detectedNames.has(t.name.toLowerCase());
                    const isInstalling = installingTemplate === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => !isInstalled && installTemplate(t)}
                        disabled={isInstalled || isInstalling}
                        className={cn(
                          'flex items-start gap-2.5 rounded-lg border border-border p-3 text-left transition-colors',
                          isInstalled ? 'cursor-default bg-secondary opacity-60' : 'cursor-pointer bg-card hover:border-primary hover:ring-1 hover:ring-primary',
                        )}
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                          {t.logo ? (
                            <img
                              className="icon-adaptive rounded-sm opacity-80"
                              src={`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${t.logo}.svg`}
                              alt={t.name}
                              width={20} height={20}
                              onError={e => {
                                const el = e.target as HTMLImageElement;
                                el.style.display = 'none';
                                el.parentElement!.querySelector('span')!.style.display = 'flex';
                              }}
                            />
                          ) : null}
                          <span
                            className="h-6 w-6 items-center justify-center rounded-md bg-border text-xs font-bold text-muted-foreground"
                            style={{ display: t.logo ? 'none' : 'flex' }}
                          >{t.name.charAt(0)}</span>
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1 text-sm font-semibold text-foreground">
                            {t.name}
                            {isInstalled && <Check size={13} className="text-green" />}
                            {!isInstalled && isDetected && isClaudeBackend && <span className="rounded bg-blue/10 px-1 py-px text-[9px] font-semibold text-blue">CLI</span>}
                          </div>
                          <div className="mt-0.5 overflow-hidden text-ellipsis text-2xs leading-snug text-muted-foreground [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [display:-webkit-box]">
                            {t.description}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <span className={cn(
                              'rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em]',
                              t.official ? 'bg-green/10 text-green' : 'bg-amber/10 text-amber',
                            )}>
                              {t.official ? '✓ Official' : 'Community'}
                            </span>
                            <span className="text-2xs uppercase tracking-[0.05em] text-muted-foreground">
                              {t.auth === 'oauth' ? 'OAuth' : t.transport === 'http' ? 'Remote' : 'Local'}
                            </span>
                            {t.docsUrl && (
                              <a href={t.docsUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                                className="text-2xs text-blue no-underline">Docs</a>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {filteredTemplates.length === 0 && !selectedTemplate && (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  No servers match your search.
                </div>
              )}
            </div>
          </div>
        </div></Portal>
      )}
    </PageShell>
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
    <div className="mb-3.5">
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Environment Variables</label>
        <button type="button" onClick={onAdd} className="rounded-md border border-border px-2.5 py-0.5 text-2xs text-muted-foreground hover:bg-accent">+ Add</button>
      </div>

      <p className="mb-2 rounded-md border border-primary/20 bg-primary/[0.07] px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
        Use <code className="rounded-sm bg-primary/15 px-1 py-px font-mono text-2xs">{'${env:MY_SECRET}'}</code> in your config to reference a secret from your{' '}
        <a href="/settings/env-vars" className="text-primary no-underline">env vars</a>.
        {' '}Raw values here are injected directly into the subprocess — store API keys in env vars instead.
      </p>

      {entries.length === 0 ? (
        <p className="m-0 text-xs italic text-muted-foreground">
          No env vars — click + Add to inject variables into the subprocess.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
              {/* Key */}
              <input
                value={entry.key}
                onChange={e => onUpdate(i, { key: e.target.value })}
                placeholder="KEY_NAME"
                className={SMALL_CONTROL_CLASS}
              />
              {/* Mode toggle */}
              <select
                value={entry.mode}
                onChange={e => onUpdate(i, { mode: e.target.value as 'value' | 'ref', val: '' })}
                className={cn(SMALL_CONTROL_CLASS, 'cursor-pointer font-sans text-muted-foreground')}
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
                  className={SMALL_CONTROL_CLASS}
                />
              ) : (
                <select
                  value={entry.val}
                  onChange={e => onUpdate(i, { val: e.target.value })}
                  className={cn(SMALL_CONTROL_CLASS, 'cursor-pointer', !entry.val && 'text-muted-foreground')}
                >
                  <option value="">— pick env var —</option>
                  {envVarKeys.map(k => <option key={k} value={k}>{k}</option>)}
                  {entry.val && !envVarKeys.includes(entry.val) && <option value={entry.val}>{entry.val}</option>}
                  {envVarKeys.length === 0 && !entry.val && <option disabled>No env vars — add in Settings → Env Vars</option>}
                </select>
              )}
              {/* Remove */}
              <button type="button" onClick={() => onRemove(i)} className="px-1.5 py-1 leading-none text-destructive hover:opacity-80">×</button>
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
    <div className="mb-3.5">
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Headers</label>
        <button type="button" onClick={onAdd} className="rounded-md border border-border px-2.5 py-0.5 text-2xs text-muted-foreground hover:bg-accent">+ Add</button>
      </div>

      {entries.length === 0 ? (
        <p className="m-0 text-xs italic text-muted-foreground">
          No headers — click + Add to include HTTP headers (e.g. Authorization).
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
                {/* Header name */}
                <input
                  value={entry.name}
                  onChange={e => onUpdate(i, { name: e.target.value })}
                  placeholder="Authorization"
                  className={SMALL_CONTROL_CLASS}
                />
                {/* Mode toggle */}
                <select
                  value={entry.mode}
                  onChange={e => onUpdate(i, { mode: e.target.value as 'value' | 'ref', val: '', prefix: '' })}
                  className={cn(SMALL_CONTROL_CLASS, 'cursor-pointer font-sans text-muted-foreground')}
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
                    className={SMALL_CONTROL_CLASS}
                  />
                ) : (
                  <select
                    value={entry.val}
                    onChange={e => onUpdate(i, { val: e.target.value })}
                    className={cn(SMALL_CONTROL_CLASS, 'cursor-pointer', !entry.val && 'text-muted-foreground')}
                  >
                    <option value="">— pick env var —</option>
                    {envVarKeys.map(k => <option key={k} value={k}>{k}</option>)}
                    {entry.val && !envVarKeys.includes(entry.val) && <option value={entry.val}>{entry.val}</option>}
                    {envVarKeys.length === 0 && !entry.val && <option disabled>No env vars — add in Settings → Env Vars</option>}
                  </select>
                )}
                {/* Remove */}
                <button type="button" onClick={() => onRemove(i)} className="px-1.5 py-1 leading-none text-destructive hover:opacity-80">×</button>
              </div>
              {/* Optional prefix for env var mode */}
              {entry.mode === 'ref' && (
                <div className="flex items-center gap-1.5 pl-0.5">
                  <span className="whitespace-nowrap text-2xs text-muted-foreground">Prefix (optional):</span>
                  <input
                    value={entry.prefix}
                    onChange={e => onUpdate(i, { prefix: e.target.value })}
                    placeholder='e.g. "Bearer "'
                    className={cn(SMALL_CONTROL_CLASS, 'w-[180px]')}
                  />
                  <span className="text-2xs text-muted-foreground">+ value of env var</span>
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
  server, isLast, onEdit, onDelete, onToggle, onTest, onDismissTest, testResult, canEdit, canMutate,
}: {
  server: McpServer; isLast: boolean;
  onEdit: () => void; onDelete: () => void; onToggle: () => void; onTest: () => void;
  onDismissTest: () => void;
  testResult?: { ok: boolean; message?: string; error?: string; tools?: string[] } | 'testing';
  canEdit: boolean;
  canMutate: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Match against template for logo
  const tpl = MCP_TEMPLATES.find(t => t.id === server.name || t.name.toLowerCase() === server.name.toLowerCase());

  const cfg = server.config as unknown as Record<string, unknown>;
  const isTs = typeof cfg.tsSource === 'string';
  const preview = server.type === 'stdio'
    ? isTs
      ? '[TypeScript inline script]'
      : `${cfg.command} ${Array.isArray(cfg.args) ? (cfg.args as string[]).join(' ') : ''}`.trim()
    : String(cfg.url ?? '');

  const envCount = Object.keys((cfg.env as object) ?? {}).length + Object.keys((cfg.envRefs as object) ?? {}).length;
  const TypeIcon = server.type === 'http' ? Globe : server.type === 'sse' ? Radio : Terminal;

  const badgeClass = 'whitespace-nowrap rounded-md border border-border bg-secondary px-1.5 py-px font-mono text-2xs font-semibold leading-normal tracking-[0.03em] text-muted-foreground';

  return (
    <div className={cn(!isLast && 'border-b border-border')} style={{ opacity: server.enabled ? 1 : 0.6 }}>
      <div className="flex items-start gap-3 px-4 py-3.5">
        {/* Avatar — template logo or transport icon */}
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-foreground">
          {tpl?.logo ? (
            <img className="icon-adaptive rounded-sm opacity-90" src={`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${tpl.logo}.svg`}
              alt="" width={20} height={20}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          ) : <TypeIcon size={19} />}
        </span>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-foreground">{server.name}</span>
            <span className={badgeClass}>MCP</span>
            <span className={badgeClass}>{isTs ? 'TS' : server.type.toUpperCase()}</span>
            {envCount > 0 && <span className={badgeClass}>{envCount} env var{envCount !== 1 ? 's' : ''}</span>}
          </div>
          {server.description && (
            <p className="mt-1.5 truncate text-xs text-muted-foreground">{server.description}</p>
          )}
          <p className="mt-1 truncate font-mono text-2xs text-muted-foreground">{preview}</p>
          <p className="mt-1 text-2xs text-muted-foreground">
            Added by <span className="font-medium">{server.createdBy}</span>
          </p>
        </div>

        {/* Actions + status */}
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="relative flex items-center gap-1.5">
            <ActionBtn onClick={onTest} disabled={false}>
              {testResult === 'testing' ? 'Testing…' : 'Test'}
            </ActionBtn>
            {canEdit && <ActionBtn onClick={onEdit} tone="foreground" disabled={!canMutate}>Edit</ActionBtn>}
            {canEdit && (
              <>
                <button onClick={() => setMenuOpen(o => !o)} disabled={!canMutate} className="inline-flex h-7 w-[30px] items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"><MoreHorizontal size={15} /></button>
                {menuOpen && (
                  <>
                    <div onClick={() => setMenuOpen(false)} className="fixed inset-0 z-20" />
                    <div className="absolute right-0 top-full z-[21] mt-1.5 min-w-[150px] rounded-lg border border-border bg-card p-1.5 shadow-md">
                      <button onClick={() => { setMenuOpen(false); onToggle(); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-accent"><Power size={13} /> {server.enabled ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => { setMenuOpen(false); onDelete(); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-red hover:bg-accent"><Trash2 size={13} /> Delete</button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
          <span className={cn('inline-flex items-center gap-1.5 text-2xs', server.enabled ? 'font-semibold text-green' : 'text-muted-foreground')}>
            <span className={cn('h-1.5 w-1.5 rounded-full', server.enabled ? 'bg-green' : 'bg-muted-foreground')} />
            {server.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      </div>

      {/* Test result banner */}
      {testResult && testResult !== 'testing' && (
        <div className={cn(
          'relative mx-4 mb-2.5 rounded-md border px-3 py-2 pr-7 text-xs',
          testResult.ok ? 'border-green/25 bg-green/[0.08] text-green' : 'border-destructive/25 bg-destructive/[0.08] text-destructive',
        )}>
          {testResult.ok ? '✓ ' : '✗ '}{testResult.ok ? testResult.message : testResult.error}
          {testResult.ok && testResult.tools && testResult.tools.length > 0 && (
            <div className="mt-1.5 break-all font-mono text-2xs leading-relaxed text-muted-foreground">
              {testResult.tools.join(', ')}
            </div>
          )}
          <button
            onClick={onDismissTest}
            aria-label="Dismiss test result"
            className="absolute right-1.5 top-1 h-5 w-5 p-0 leading-none text-inherit opacity-60 hover:opacity-100"
          >×</button>
        </div>
      )}
    </div>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────────

/**
 * OAuth connect section — auto-detects if provider supports OAuth discovery.
 * Shows "Connect" button for providers with discovery (Notion, Linear, Asana).
 * Shows CLI command for others (Figma, Stripe).
 */
function OAuthConnectSection({ template }: { template: any }) {
  const [checking, setChecking] = useState(false);
  const [oauthSupported, setOauthSupported] = useState<boolean | null>(null);

  // Check once on mount if this provider supports OAuth discovery
  useEffect(() => {
    setChecking(true);
    fetch('/api/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpUrl: template.url, templateId: template.id }),
    })
      .then(r => r.json())
      .then(data => setOauthSupported(!!data.authUrl))
      .catch(() => setOauthSupported(false))
      .finally(() => setChecking(false));
  }, [template.id]);

  if (checking) {
    return <p className="text-xs text-muted-foreground">Checking connection method...</p>;
  }

  if (oauthSupported) {
    // Provider supports OAuth — show Connect button
    return (
      <div className="mb-3.5">
        <Button
          onClick={() => {
            fetch('/api/oauth/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mcpUrl: template.url, templateId: template.id }),
            })
              .then(r => r.json())
              .then(data => { if (data.authUrl) window.open(data.authUrl, '_blank'); });
          }}
        >Connect {template.name}</Button>
        <p className="mt-1.5 text-2xs text-muted-foreground">
          Opens {template.name} authorization page. After approving, you&apos;ll be redirected back.
        </p>
      </div>
    );
  }

  // No OAuth discovery — show CLI command
  return (
    <div className="mb-3.5">
      <p className="mb-2 text-xs text-muted-foreground">
        Authenticate via Claude Code CLI:
      </p>
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 font-mono text-2xs text-muted-foreground">
        <code className="truncate">claude mcp add --transport http {template.id} {template.url}</code>
        <button onClick={() => navigator.clipboard.writeText(`claude mcp add --transport http ${template.id} ${template.url}`)} className="shrink-0 font-sans text-2xs text-muted-foreground hover:text-foreground">Copy</button>
      </div>
      <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
        Run in terminal, authorize in browser, then paste token below or add directly.
      </p>
    </div>
  );
}

function FField({ label, hint, children, className, required: req }: {
  label: string; hint?: React.ReactNode; children: React.ReactNode;
  className?: string; required?: boolean;
}) {
  return (
    <div className={className}>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}{req && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-2xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function inputStyle(mono = false): { className: string } {
  return {
    className: cn(CONTROL_CLASS, 'resize-y', mono && 'font-mono'),
  };
}

function ActionBtn({ children, onClick, tone = 'muted', disabled }: {
  children: React.ReactNode; onClick: () => void; tone?: 'muted' | 'foreground'; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} className={cn(
      'rounded-md px-2 py-0.5 text-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40',
      tone === 'foreground' ? 'text-foreground' : 'text-muted-foreground',
    )}>{children}</button>
  );
}
