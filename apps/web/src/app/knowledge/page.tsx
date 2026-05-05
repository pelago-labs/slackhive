'use client';

import { useEffect, useState, useRef } from 'react';
import { useAuth } from '@/lib/auth-context';

interface WikiFolder {
  id: string;
  name: string;
  description?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface WikiSource {
  id: string;
  folderId: string;
  type: 'url' | 'file' | 'repo';
  name: string;
  url?: string;
  repoUrl?: string;
  branch?: string;
  patEnvRef?: string;
  content?: string;
  status: 'pending' | 'building' | 'compiled' | 'error';
  wordCount: number;
  lastSynced?: string;
  createdAt: string;
}

const STATUS_COLOR: Record<string, string> = {
  compiled: '#059669',
  building: '#d97706',
  pending:  '#a3a3a3',
  error:    '#dc2626',
};

export default function KnowledgePage() {
  const { canEdit } = useAuth();
  const [folders, setFolders] = useState<WikiFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<WikiFolder | null>(null);
  const [sources, setSources] = useState<WikiSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [folderForm, setFolderForm] = useState({ name: '', description: '' });
  const [sourceForm, setSourceForm] = useState({ type: 'url', name: '', url: '', repoUrl: '', branch: 'main', patEnvRef: '', content: '' });
  const [saving, setSaving] = useState(false);
  const [buildStatus, setBuildStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch('/api/wiki-folders').then(r => r.json()).then(setFolders).finally(() => setLoading(false));
  }, []);

  function selectFolder(f: WikiFolder) {
    setSelected(f);
    setSourcesLoading(true);
    fetch(`/api/wiki-folders/${f.id}/sources`).then(r => r.json()).then(setSources).finally(() => setSourcesLoading(false));
  }

  async function createFolder() {
    if (!folderForm.name.trim()) return;
    setSaving(true);
    const r = await fetch('/api/wiki-folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(folderForm) });
    const folder = await r.json();
    setFolders(prev => [...prev, folder].sort((a, b) => a.name.localeCompare(b.name)));
    setFolderForm({ name: '', description: '' });
    setShowNewFolder(false);
    setSaving(false);
  }

  async function deleteFolder(id: string) {
    if (!confirm('Delete this folder and all its sources? This cannot be undone.')) return;
    await fetch(`/api/wiki-folders/${id}`, { method: 'DELETE' });
    setFolders(prev => prev.filter(f => f.id !== id));
    if (selected?.id === id) setSelected(null);
  }

  async function addSource() {
    if (!selected || !sourceForm.name.trim()) return;
    setSaving(true);
    const body: Record<string, string> = { type: sourceForm.type, name: sourceForm.name };
    if (sourceForm.type === 'url') body.url = sourceForm.url;
    if (sourceForm.type === 'file') body.content = sourceForm.content;
    if (sourceForm.type === 'repo') { body.repoUrl = sourceForm.repoUrl; body.branch = sourceForm.branch; if (sourceForm.patEnvRef) body.patEnvRef = sourceForm.patEnvRef; }
    const r = await fetch(`/api/wiki-folders/${selected.id}/sources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const source = await r.json();
    setSources(prev => [...prev, source]);
    setSourceForm({ type: 'url', name: '', url: '', repoUrl: '', branch: 'main', patEnvRef: '', content: '' });
    setShowAddSource(false);
    setSaving(false);
  }

  async function deleteSource(id: string) {
    if (!selected) return;
    await fetch(`/api/wiki-folders/${selected.id}/sources/${id}`, { method: 'DELETE' });
    setSources(prev => prev.filter(s => s.id !== id));
  }

  async function buildFolder() {
    if (!selected) return;
    setBuildStatus(prev => ({ ...prev, [selected.id]: 'building' }));
    const r = await fetch(`/api/wiki-folders/${selected.id}/build`, { method: 'POST' });
    if (!r.ok) {
      const e = await r.json();
      alert(e.error ?? 'Build failed');
      setBuildStatus(prev => ({ ...prev, [selected!.id]: '' }));
    }
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }} className="fade-up">

      {/* ── Folder list ─────────────────────────────────────────────────── */}
      <div style={{
        width: 280, flexShrink: 0, borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '20px 16px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Knowledge Library</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Shared wiki folders</div>
          </div>
          {canEdit && (
            <button onClick={() => setShowNewFolder(true)} style={{
              background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
            }}>+ New</button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
          {loading ? (
            <div style={{ padding: '20px 8px', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
          ) : folders.length === 0 ? (
            <div style={{ padding: '20px 8px', color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
              No folders yet.{canEdit && ' Create one to get started.'}
            </div>
          ) : folders.map(f => (
            <div key={f.id}
              onClick={() => selectFolder(f)}
              style={{
                padding: '10px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 2,
                background: selected?.id === f.id ? 'var(--accent-soft, rgba(99,102,241,0.08))' : 'transparent',
                border: selected?.id === f.id ? '1px solid var(--accent-border, rgba(99,102,241,0.2))' : '1px solid transparent',
                transition: 'background 0.15s',
              }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>{f.name}</div>
              {f.description && <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.description}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* ── Detail pane ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '28px 32px' }}>
        {!selected ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)', fontSize: 14 }}>
            Select a folder to manage its sources
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>{selected.name}</h2>
                {selected.description && <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>{selected.description}</p>}
                <div style={{ fontSize: 11.5, color: 'var(--subtle)', marginTop: 6 }}>Created by {selected.createdBy}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {canEdit && (
                  <>
                    <button
                      onClick={buildFolder}
                      disabled={buildStatus[selected.id] === 'building'}
                      style={{
                        background: 'var(--accent)', color: '#fff', border: 'none',
                        borderRadius: 7, padding: '8px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                        opacity: buildStatus[selected.id] === 'building' ? 0.6 : 1,
                      }}
                    >
                      {buildStatus[selected.id] === 'building' ? 'Building…' : 'Build Wiki'}
                    </button>
                    <button
                      onClick={() => deleteFolder(selected.id)}
                      style={{
                        background: 'transparent', color: '#dc2626', border: '1px solid #fca5a5',
                        borderRadius: 7, padding: '8px 14px', fontSize: 13, cursor: 'pointer',
                      }}
                    >Delete</button>
                  </>
                )}
              </div>
            </div>

            {/* Sources */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--subtle)', textTransform: 'uppercase' }}>
                Sources ({sources.length})
              </div>
              {canEdit && (
                <button onClick={() => setShowAddSource(true)} style={{
                  background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)',
                  borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                }}>+ Add Source</button>
              )}
            </div>

            {sourcesLoading ? (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
            ) : sources.length === 0 ? (
              <div style={{
                border: '1px dashed var(--border)', borderRadius: 10, padding: '28px',
                textAlign: 'center', color: 'var(--muted)', fontSize: 13,
              }}>
                No sources yet. Add a URL, file, or Git repo to get started.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sources.map(s => (
                  <div key={s.id} style={{
                    background: '#fff', border: '1px solid var(--border)', borderRadius: 10,
                    padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{
                          fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase',
                          background: 'var(--surface-2)', color: 'var(--muted)', padding: '2px 6px', borderRadius: 4,
                        }}>{s.type}</span>
                        <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{s.name}</span>
                        <span style={{ fontSize: 11.5, color: STATUS_COLOR[s.status] ?? '#a3a3a3', fontWeight: 500 }}>{s.status}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--subtle)', fontFamily: 'var(--font-mono)' }}>
                        {s.url || s.repoUrl || (s.content ? `${s.content.slice(0, 60)}…` : '—')}
                      </div>
                      {s.wordCount > 0 && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>{s.wordCount.toLocaleString()} words</div>}
                    </div>
                    {canEdit && (
                      <button onClick={() => deleteSource(s.id)} style={{
                        background: 'transparent', border: 'none', color: '#dc2626',
                        fontSize: 18, cursor: 'pointer', padding: '0 4px', lineHeight: 1,
                      }}>×</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── New Folder Modal ─────────────────────────────────────────────── */}
      {showNewFolder && (
        <Modal title="New Knowledge Folder" onClose={() => setShowNewFolder(false)}>
          <label style={labelStyle}>Name</label>
          <input
            style={inputStyle} autoFocus
            value={folderForm.name} onChange={e => setFolderForm(p => ({ ...p, name: e.target.value }))}
            placeholder="e.g. Backend API Docs"
          />
          <label style={labelStyle}>Description (optional)</label>
          <input
            style={inputStyle}
            value={folderForm.description} onChange={e => setFolderForm(p => ({ ...p, description: e.target.value }))}
            placeholder="What this folder contains"
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
            <button onClick={() => setShowNewFolder(false)} style={cancelBtnStyle}>Cancel</button>
            <button onClick={createFolder} disabled={saving || !folderForm.name.trim()} style={primaryBtnStyle}>
              {saving ? 'Creating…' : 'Create Folder'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Add Source Modal ─────────────────────────────────────────────── */}
      {showAddSource && (
        <Modal title="Add Source" onClose={() => setShowAddSource(false)}>
          <label style={labelStyle}>Type</label>
          <select style={inputStyle} value={sourceForm.type} onChange={e => setSourceForm(p => ({ ...p, type: e.target.value }))}>
            <option value="url">URL</option>
            <option value="file">File (paste content)</option>
            <option value="repo">Git Repository</option>
          </select>
          <label style={labelStyle}>Name</label>
          <input style={inputStyle} value={sourceForm.name} onChange={e => setSourceForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. API Reference" />
          {sourceForm.type === 'url' && (
            <>
              <label style={labelStyle}>URL</label>
              <input style={inputStyle} value={sourceForm.url} onChange={e => setSourceForm(p => ({ ...p, url: e.target.value }))} placeholder="https://docs.example.com" />
            </>
          )}
          {sourceForm.type === 'file' && (
            <>
              <label style={labelStyle}>Content</label>
              <textarea style={{ ...inputStyle, minHeight: 120, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                value={sourceForm.content} onChange={e => setSourceForm(p => ({ ...p, content: e.target.value }))}
                placeholder="Paste your content here…" />
            </>
          )}
          {sourceForm.type === 'repo' && (
            <>
              <label style={labelStyle}>Repository URL</label>
              <input style={inputStyle} value={sourceForm.repoUrl} onChange={e => setSourceForm(p => ({ ...p, repoUrl: e.target.value }))} placeholder="https://github.com/org/repo" />
              <label style={labelStyle}>Branch</label>
              <input style={inputStyle} value={sourceForm.branch} onChange={e => setSourceForm(p => ({ ...p, branch: e.target.value }))} placeholder="main" />
              <label style={labelStyle}>PAT env var (for private repos, optional)</label>
              <input style={inputStyle} value={sourceForm.patEnvRef} onChange={e => setSourceForm(p => ({ ...p, patEnvRef: e.target.value }))} placeholder="GITHUB_PAT" />
            </>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
            <button onClick={() => setShowAddSource(false)} style={cancelBtnStyle}>Cancel</button>
            <button onClick={addSource} disabled={saving || !sourceForm.name.trim()} style={primaryBtnStyle}>
              {saving ? 'Adding…' : 'Add Source'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: '#fff', borderRadius: 14, padding: '28px 28px 24px',
        width: 440, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 20 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5, marginTop: 14 };
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  border: '1px solid var(--border)', borderRadius: 7, padding: '8px 10px',
  fontSize: 13.5, color: 'var(--text)', background: 'var(--surface-1, #fff)', outline: 'none',
};
const cancelBtnStyle: React.CSSProperties = {
  background: 'transparent', border: '1px solid var(--border)', borderRadius: 7,
  padding: '8px 16px', fontSize: 13, cursor: 'pointer', color: 'var(--text)',
};
const primaryBtnStyle: React.CSSProperties = {
  background: 'var(--accent)', color: '#fff', border: 'none',
  borderRadius: 7, padding: '8px 18px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};
