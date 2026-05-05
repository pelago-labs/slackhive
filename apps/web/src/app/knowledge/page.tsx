'use client';

import { useEffect, useState } from 'react';
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
  content?: string;
  status: 'pending' | 'building' | 'compiled' | 'error';
  wordCount: number;
  lastSynced?: string;
}

interface WikiPage {
  path: string;
  title: string;
  size: number;
}

const STATUS_COLOR: Record<string, string> = {
  compiled: '#059669',
  building: '#d97706',
  pending:  '#a3a3a3',
  error:    '#dc2626',
};

export default function KnowledgePage() {
  const { canEdit, username, role } = useAuth();
  const [folders, setFolders]               = useState<WikiFolder[]>([]);
  const [loading, setLoading]               = useState(true);
  const [selected, setSelected]             = useState<WikiFolder | null>(null);
  const [detailTab, setDetailTab]           = useState<'sources' | 'wiki'>('sources');
  const [sources, setSources]               = useState<WikiSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [wikiPages, setWikiPages]           = useState<WikiPage[]>([]);
  const [wikiLoading, setWikiLoading]       = useState(false);
  const [wikiArticle, setWikiArticle]       = useState<{ path: string; content: string } | null>(null);
  const [showNewFolder, setShowNewFolder]   = useState(false);
  const [showAddSource, setShowAddSource]   = useState(false);
  const [editingFolder, setEditingFolder]   = useState<WikiFolder | null>(null);
  const [folderForm, setFolderForm]         = useState({ name: '', description: '' });
  const [sourceForm, setSourceForm]         = useState({ type: 'url', name: '', url: '', repoUrl: '', branch: 'main', patEnvRef: '', content: '' });
  const [saving, setSaving]                 = useState(false);
  const [buildStatus, setBuildStatus]       = useState<Record<string, string>>({});
  const [envVarKeys, setEnvVarKeys]         = useState<string[]>([]);

  // Fetch accessible env var keys (filtered by ownership client-side)
  useEffect(() => {
    fetch('/api/env-vars').then(r => r.json()).then((rows: { key: string; createdBy: string }[]) => {
      const isAdmin = role === 'admin' || role === 'superadmin';
      const accessible = isAdmin ? rows : rows.filter(r => r.createdBy === username);
      setEnvVarKeys(accessible.map(r => r.key));
    }).catch(() => {});
  }, [username, role]);

  const isOwnerOrAdmin = (f: WikiFolder) =>
    (role === 'admin' || role === 'superadmin') || (canEdit && f.createdBy === username);

  useEffect(() => {
    fetch('/api/wiki-folders').then(r => r.json()).then(setFolders).finally(() => setLoading(false));
  }, []);

  function selectFolder(f: WikiFolder) {
    setSelected(f);
    setWikiArticle(null);
    setDetailTab('sources');
    setSourcesLoading(true);
    setSources([]);
    fetch(`/api/wiki-folders/${f.id}/sources`).then(r => r.json()).then(setSources).finally(() => setSourcesLoading(false));
  }

  function switchTab(tab: 'sources' | 'wiki') {
    setDetailTab(tab);
    setWikiArticle(null);
    if (tab === 'wiki' && selected) {
      setWikiLoading(true);
      setWikiPages([]);
      fetch(`/api/wiki-folders/${selected.id}/wiki`).then(r => r.json()).then(d => setWikiPages(d.pages ?? [])).finally(() => setWikiLoading(false));
    }
  }

  async function loadWikiArticle(page: WikiPage) {
    if (!selected) return;
    const r = await fetch(`/api/wiki-folders/${selected.id}/wiki?path=${encodeURIComponent(page.path)}`);
    const d = await r.json();
    setWikiArticle({ path: page.path, content: d.content ?? '' });
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

  async function saveEditFolder() {
    if (!editingFolder || !folderForm.name.trim()) return;
    setSaving(true);
    const r = await fetch(`/api/wiki-folders/${editingFolder.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderForm.name.trim(), description: folderForm.description }),
    });
    const updated = await r.json();
    setFolders(prev => prev.map(f => f.id === updated.id ? updated : f).sort((a, b) => a.name.localeCompare(b.name)));
    if (selected?.id === updated.id) setSelected(updated);
    setEditingFolder(null);
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
    }
    setBuildStatus(prev => ({ ...prev, [selected!.id]: '' }));
  }

  const canManageSelected = selected ? isOwnerOrAdmin(selected) : false;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }} className="fade-up">

      {/* ── Folder list ──────────────────────────────────────────────────── */}
      <div style={{
        width: 260, flexShrink: 0, borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: 'var(--surface-2)',
      }}>
        <div style={{ padding: '18px 14px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Knowledge Library</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Shared wiki folders</div>
          </div>
          {canEdit && (
            <button onClick={() => { setFolderForm({ name: '', description: '' }); setShowNewFolder(true); }} style={{
              background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 6, padding: '4px 9px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
            }}>+ New</button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
          {loading ? (
            <div style={{ padding: '20px 8px', color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>Loading…</div>
          ) : folders.length === 0 ? (
            <div style={{ padding: '24px 8px', color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
              No folders yet.{canEdit && <><br /><span style={{ fontSize: 12 }}>Create one to get started.</span></>}
            </div>
          ) : folders.map(f => (
            <div key={f.id}
              onClick={() => selectFolder(f)}
              style={{
                padding: '9px 10px', borderRadius: 7, cursor: 'pointer', marginBottom: 1,
                background: selected?.id === f.id ? 'var(--surface-3)' : 'transparent',
                border: selected?.id === f.id ? '1px solid var(--border)' : '1px solid transparent',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>{f.name}</div>
              {f.description && <div style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.description}</div>}
              <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 3 }}>by {f.createdBy}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Detail pane ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--surface)' }}>
        {!selected ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)', fontSize: 14 }}>
            Select a folder to manage its sources
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{ padding: '20px 28px 0', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>{selected.name}</h2>
                  {selected.description && <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--muted)' }}>{selected.description}</p>}
                  <div style={{ fontSize: 11.5, color: 'var(--subtle)', marginTop: 4 }}>
                    Owner: <span style={{ color: 'var(--muted)', fontWeight: 500 }}>{selected.createdBy}</span>
                  </div>
                </div>
                {canManageSelected && (
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button
                      onClick={() => { setFolderForm({ name: selected.name, description: selected.description ?? '' }); setEditingFolder(selected); }}
                      style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 12px', fontSize: 12.5, cursor: 'pointer' }}
                    >Edit</button>
                    <button
                      onClick={buildFolder}
                      disabled={buildStatus[selected.id] === 'building'}
                      style={{
                        background: 'var(--accent)', color: '#fff', border: 'none',
                        borderRadius: 7, padding: '7px 14px', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
                        opacity: buildStatus[selected.id] === 'building' ? 0.6 : 1,
                      }}
                    >
                      {buildStatus[selected.id] === 'building' ? 'Building…' : 'Build Wiki'}
                    </button>
                    <button
                      onClick={() => deleteFolder(selected.id)}
                      style={{ background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 12px', fontSize: 12.5, cursor: 'pointer' }}
                    >Delete</button>
                  </div>
                )}
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', gap: 0 }}>
                {(['sources', 'wiki'] as const).map(tab => (
                  <button key={tab} onClick={() => switchTab(tab)} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: '7px 16px', fontSize: 13, fontWeight: detailTab === tab ? 600 : 400,
                    color: detailTab === tab ? 'var(--text)' : 'var(--muted)',
                    borderBottom: `2px solid ${detailTab === tab ? 'var(--accent)' : 'transparent'}`,
                    marginBottom: -1,
                  }}>
                    {tab === 'sources' ? `Sources (${sources.length})` : 'Built Wiki'}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, overflow: 'auto', padding: '20px 28px' }}>
              {detailTab === 'sources' && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--subtle)', textTransform: 'uppercase' }}>
                      Knowledge Sources
                    </div>
                    {canManageSelected && (
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
                      border: '1px dashed var(--border)', borderRadius: 10, padding: '32px',
                      textAlign: 'center', color: 'var(--muted)', fontSize: 13,
                    }}>
                      {canManageSelected ? 'No sources yet. Add a URL, file, or Git repo, then click Build Wiki.' : 'No sources added yet.'}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {sources.map(s => (
                        <div key={s.id} style={{
                          background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10,
                          padding: '13px 15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                              <span style={{
                                fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase',
                                background: 'var(--surface-3)', color: 'var(--muted)', padding: '2px 6px', borderRadius: 4,
                              }}>{s.type}</span>
                              <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{s.name}</span>
                              <span style={{ fontSize: 11.5, color: STATUS_COLOR[s.status] ?? '#a3a3a3', fontWeight: 500 }}>{s.status}</span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--subtle)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                              {s.url || s.repoUrl || (s.content ? `${s.content.slice(0, 80)}…` : '—')}
                            </div>
                            {s.wordCount > 0 && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>{s.wordCount.toLocaleString()} words</div>}
                          </div>
                          {canManageSelected && (
                            <button onClick={() => deleteSource(s.id)} style={{
                              background: 'transparent', border: 'none', color: 'var(--muted)',
                              fontSize: 18, cursor: 'pointer', padding: '0 4px', lineHeight: 1, flexShrink: 0,
                            }}>×</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {detailTab === 'wiki' && (
                wikiLoading ? (
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
                ) : wikiPages.length === 0 ? (
                  <div style={{
                    border: '1px dashed var(--border)', borderRadius: 10, padding: '32px',
                    textAlign: 'center', color: 'var(--muted)', fontSize: 13,
                  }}>
                    No wiki pages built yet.{canManageSelected && ' Add sources then click Build Wiki.'}
                  </div>
                ) : wikiArticle ? (
                  <div>
                    <button onClick={() => setWikiArticle(null)} style={{
                      background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer',
                      fontSize: 13, padding: '0 0 14px', display: 'flex', alignItems: 'center', gap: 4,
                    }}>← All pages</button>
                    <pre style={{
                      background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10,
                      padding: '20px', fontSize: 12.5, lineHeight: 1.7, overflowX: 'auto',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)',
                      fontFamily: 'var(--font-mono)',
                    }}>{wikiArticle.content}</pre>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--subtle)', textTransform: 'uppercase', marginBottom: 8 }}>
                      {wikiPages.length} page{wikiPages.length !== 1 ? 's' : ''}
                    </div>
                    {wikiPages.map(p => (
                      <button key={p.path} onClick={() => loadWikiArticle(p)} style={{
                        background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 9,
                        padding: '11px 14px', textAlign: 'left', cursor: 'pointer', display: 'flex',
                        alignItems: 'center', justifyContent: 'space-between',
                      }}>
                        <div>
                          <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>{p.title}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--subtle)', fontFamily: 'var(--font-mono)' }}>{p.path}</div>
                        </div>
                        <span style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0 }}>{Math.round(p.size / 1024 * 10) / 10} KB</span>
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
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
            onKeyDown={e => e.key === 'Enter' && createFolder()}
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

      {/* ── Edit Folder Modal ─────────────────────────────────────────────── */}
      {editingFolder && (
        <Modal title="Edit Folder" onClose={() => setEditingFolder(null)}>
          <label style={labelStyle}>Name</label>
          <input
            style={inputStyle} autoFocus
            value={folderForm.name} onChange={e => setFolderForm(p => ({ ...p, name: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && saveEditFolder()}
          />
          <label style={labelStyle}>Description</label>
          <input
            style={inputStyle}
            value={folderForm.description} onChange={e => setFolderForm(p => ({ ...p, description: e.target.value }))}
            placeholder="What this folder contains"
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
            <button onClick={() => setEditingFolder(null)} style={cancelBtnStyle}>Cancel</button>
            <button onClick={saveEditFolder} disabled={saving || !folderForm.name.trim()} style={primaryBtnStyle}>
              {saving ? 'Saving…' : 'Save'}
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
              <select style={inputStyle} value={sourceForm.patEnvRef} onChange={e => setSourceForm(p => ({ ...p, patEnvRef: e.target.value }))}>
                <option value="">— None (public repo) —</option>
                {envVarKeys.map(k => <option key={k} value={k}>{k}</option>)}
                {envVarKeys.length === 0 && <option disabled>No accessible env vars</option>}
              </select>
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
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'var(--surface)', borderRadius: 14, padding: '28px 28px 24px',
        width: 440, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        border: '1px solid var(--border)',
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
  fontSize: 13.5, color: 'var(--text)', background: 'var(--surface-2)', outline: 'none',
};
const cancelBtnStyle: React.CSSProperties = {
  background: 'transparent', border: '1px solid var(--border)', borderRadius: 7,
  padding: '8px 16px', fontSize: 13, cursor: 'pointer', color: 'var(--text)',
};
const primaryBtnStyle: React.CSSProperties = {
  background: 'var(--accent)', color: '#fff', border: 'none',
  borderRadius: 7, padding: '8px 18px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};
