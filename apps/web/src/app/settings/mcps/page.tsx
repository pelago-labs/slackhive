/**
 * @fileoverview Settings → MCP Servers page.
 *
 * The global MCP catalog management page. Administrators add, edit, enable,
 * disable, and delete MCP servers here. These servers are then available
 * for any agent to use when creating or configuring agents.
 *
 * Supports all three MCP transport types:
 * - stdio  — Local subprocess (most common, e.g., node/python servers)
 * - sse    — Remote Server-Sent Events endpoint
 * - http   — Remote HTTP endpoint
 *
 * @module web/settings/mcps/page
 */

'use client';

import { useState, useEffect } from 'react';
import type { McpServer, McpServerType } from '@slack-agent-team/shared';

// =============================================================================
// Types
// =============================================================================

interface McpFormState {
  name: string;
  type: McpServerType;
  description: string;
  enabled: boolean;
  // stdio fields
  command: string;
  args: string;       // comma-separated string for UI
  env: string;        // JSON string for UI
  // sse/http fields
  url: string;
  headers: string;    // JSON string for UI
}

const DEFAULT_FORM: McpFormState = {
  name: '',
  type: 'stdio',
  description: '',
  enabled: true,
  command: '',
  args: '',
  env: '{}',
  url: '',
  headers: '{}',
};

// =============================================================================
// Component
// =============================================================================

/**
 * Settings page for managing the global MCP server catalog.
 * Renders a list of existing servers and a form to add new ones.
 *
 * @returns {JSX.Element} The MCP settings page.
 */
export default function McpSettingsPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<McpFormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Load all MCP servers on mount
  useEffect(() => {
    fetchServers();
  }, []);

  async function fetchServers() {
    setLoading(true);
    try {
      const res = await fetch('/api/mcps');
      const data = await res.json();
      setServers(data);
    } catch {
      setError('Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Builds the config JSONB from the form state based on the selected transport type.
   */
  function buildConfig(f: McpFormState): object {
    if (f.type === 'stdio') {
      const config: Record<string, unknown> = { command: f.command };
      if (f.args.trim()) {
        config.args = f.args.split(',').map((a) => a.trim()).filter(Boolean);
      }
      try {
        const env = JSON.parse(f.env);
        if (Object.keys(env).length > 0) config.env = env;
      } catch { /* ignore invalid JSON */ }
      return config;
    } else {
      const config: Record<string, unknown> = { url: f.url };
      try {
        const headers = JSON.parse(f.headers);
        if (Object.keys(headers).length > 0) config.headers = headers;
      } catch { /* ignore */ }
      return config;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const payload = {
      name: form.name,
      type: form.type,
      description: form.description || undefined,
      enabled: form.enabled,
      config: buildConfig(form),
    };

    try {
      const url = editingId ? `/api/mcps/${editingId}` : '/api/mcps';
      const method = editingId ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? 'Request failed');
      }

      setForm(DEFAULT_FORM);
      setEditingId(null);
      await fetchServers();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this MCP server from the catalog? Agents using it will need to be reloaded.')) return;
    await fetch(`/api/mcps/${id}`, { method: 'DELETE' });
    await fetchServers();
  }

  async function handleToggleEnabled(server: McpServer) {
    await fetch(`/api/mcps/${server.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !server.enabled }),
    });
    await fetchServers();
  }

  function handleEdit(server: McpServer) {
    setEditingId(server.id);
    const cfg = server.config as Record<string, unknown>;
    setForm({
      name: server.name,
      type: server.type,
      description: server.description ?? '',
      enabled: server.enabled,
      command: (cfg.command as string) ?? '',
      args: Array.isArray(cfg.args) ? (cfg.args as string[]).join(', ') : '',
      env: cfg.env ? JSON.stringify(cfg.env, null, 2) : '{}',
      url: (cfg.url as string) ?? '',
      headers: cfg.headers ? JSON.stringify(cfg.headers, null, 2) : '{}',
    });
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">MCP Servers</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage the global MCP server catalog. Any agent can use these servers.
        </p>
      </div>

      {/* Existing servers list */}
      <div className="mb-10">
        <h2 className="text-lg font-semibold text-gray-700 mb-4">
          Catalog ({servers.length} server{servers.length !== 1 ? 's' : ''})
        </h2>

        {loading ? (
          <p className="text-gray-400 text-sm">Loading...</p>
        ) : servers.length === 0 ? (
          <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center text-gray-400">
            <p className="font-medium">No MCP servers yet</p>
            <p className="text-sm mt-1">Add your first server using the form below.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {servers.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                onEdit={() => handleEdit(server)}
                onDelete={() => handleDelete(server.id)}
                onToggle={() => handleToggleEnabled(server)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add / Edit form */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-800 mb-6">
          {editingId ? 'Edit MCP Server' : 'Add MCP Server'}
        </h2>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Name + Type */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="redshift-mcp"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
              <p className="mt-1 text-xs text-gray-400">Used in tool names: mcp__{'{name}'}__{'{tool}'}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type *</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as McpServerType })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="stdio">stdio (local subprocess)</option>
                <option value="sse">SSE (remote, Server-Sent Events)</option>
                <option value="http">HTTP (remote, HTTP transport)</option>
              </select>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="What does this MCP server provide?"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Transport-specific fields */}
          {form.type === 'stdio' ? (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Command *</label>
                <input
                  type="text"
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder="node"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Arguments</label>
                <input
                  type="text"
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                  placeholder="/path/to/server.js, --flag"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-xs text-gray-400">Comma-separated arguments</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Environment Variables (JSON)</label>
                <textarea
                  value={form.env}
                  onChange={(e) => setForm({ ...form, env: e.target.value })}
                  rows={4}
                  placeholder={'{\n  "DATABASE_URL": "postgresql://..."\n}'}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">URL *</label>
                <input
                  type="url"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://mcp.example.com/sse"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Headers (JSON)</label>
                <textarea
                  value={form.headers}
                  onChange={(e) => setForm({ ...form, headers: e.target.value })}
                  rows={3}
                  placeholder={'{\n  "Authorization": "Bearer ..."\n}'}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          {/* Enabled toggle */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="enabled"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="h-4 w-4 text-blue-600 rounded"
            />
            <label htmlFor="enabled" className="text-sm text-gray-700">
              Enabled (available for agents to use)
            </label>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : editingId ? 'Update Server' : 'Add Server'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => { setEditingId(null); setForm(DEFAULT_FORM); }}
                className="px-5 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

/**
 * Card component for a single MCP server in the catalog list.
 *
 * @param {{ server: McpServer; onEdit: () => void; onDelete: () => void; onToggle: () => void }} props
 * @returns {JSX.Element}
 */
function ServerCard({
  server,
  onEdit,
  onDelete,
  onToggle,
}: {
  server: McpServer;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const cfg = server.config as Record<string, unknown>;

  return (
    <div className={`border rounded-lg p-4 flex items-start gap-4 ${server.enabled ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50'}`}>
      {/* Type badge */}
      <span className="mt-0.5 px-2 py-0.5 text-xs rounded font-mono bg-gray-100 text-gray-600 whitespace-nowrap">
        {server.type}
      </span>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900">{server.name}</span>
          {!server.enabled && (
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">disabled</span>
          )}
        </div>
        {server.description && (
          <p className="text-sm text-gray-500 mt-0.5">{server.description}</p>
        )}
        <p className="text-xs text-gray-400 mt-1 font-mono truncate">
          {server.type === 'stdio'
            ? `${cfg.command} ${Array.isArray(cfg.args) ? (cfg.args as string[]).join(' ') : ''}`
            : String(cfg.url)}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button onClick={onToggle} className="text-xs text-gray-500 hover:text-gray-700 underline">
          {server.enabled ? 'Disable' : 'Enable'}
        </button>
        <button onClick={onEdit} className="text-xs text-blue-500 hover:text-blue-700 underline">
          Edit
        </button>
        <button onClick={onDelete} className="text-xs text-red-500 hover:text-red-700 underline">
          Delete
        </button>
      </div>
    </div>
  );
}
