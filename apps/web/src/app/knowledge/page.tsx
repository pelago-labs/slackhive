'use client';

import { useEffect, useRef, useState } from 'react';
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
}

interface WikiPage { path: string; title: string; size: number; }

const STATUS_COLOR: Record<string, string> = {
  compiled: '#059669', building: '#d97706', pending: '#a3a3a3', error: '#dc2626',
};
const EMPTY_SOURCE_FORM = { type: 'url', name: '', url: '', repoUrl: '', branch: 'main', patEnvRef: '', content: '' };

export default function KnowledgePage() {
  const { canEdit, username, role } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [folders, setFolders]                 = useState<WikiFolder[]>([]);
  const [loading, setLoading]                 = useState(true);
  const [selected, setSelected]               = useState<WikiFolder | null>(null);
  const [detailTab, setDetailTab]             = useState<'sources' | 'wiki'>('sources');
  const [sources, setSources]                 = useState<WikiSource[]>([]);
  const [sourcesLoading, setSourcesLoading]   = useState(false);
  const [wikiPages, setWikiPages]             = useState<WikiPage[]>([]);
  const [wikiLoading, setWikiLoading]         = useState(false);
  const [wikiArticle, setWikiArticle]         = useState<{ path: string; content: string } | null>(null);
  const [showNewFolder, setShowNewFolder]     = useState(false);
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [editingSource, setEditingSource]     = useState<WikiSource | null>(null);
  const [editingFolder, setEditingFolder]     = useState<WikiFolder | null>(null);
  const [folderForm, setFolderForm]           = useState({ name: '', description: '' });
  const [sourceForm, setSourceForm]           = useState({ ...EMPTY_SOURCE_FORM });
  const [fileUploading, setFileUploading]     = useState(false);
  const [saving, setSaving]                   = useState(false);
  const [buildStatus, setBuildStatus]         = useState<Record<string, string>>({});
  const [envVarKeys, setEnvVarKeys]           = useState<string[]>([]);

  const isAdmin = role === 'admin' || role === 'superadmin';
  const isOwnerOrAdmin = (f: WikiFolder) => isAdmin || (canEdit && f.createdBy === username);

  useEffect(() => {
    fetch('/api/wiki-folders').then(r => r.json()).then(setFolders).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch('/api/env-vars').then(r => r.json()).then((rows: { key: string; createdBy: string }[]) => {
      setEnvVarKeys((isAdmin ? rows : rows.filter(r => r.createdBy === username)).map(r => r.key));
    }).catch(() => {});
  }, [username, role]);

  function openFolder(f: WikiFolder) {
    setSelected(f); setWikiArticle(null); setDetailTab('sources');
    setSourcesLoading(true); setSources([]);
    fetch(`/api/wiki-folders/${f.id}/sources`).then(r => r.json()).then(setSources).finally(() => setSourcesLoading(false));
  }

  function switchTab(tab: 'sources' | 'wiki') {
    setDetailTab(tab); setWikiArticle(null);
    if (tab === 'wiki' && selected) {
      setWikiLoading(true); setWikiPages([]);
      fetch(`/api/wiki-folders/${selected.id}/wiki`).then(r => r.json()).then(d => setWikiPages(d.pages ?? [])).finally(() => setWikiLoading(false));
    }
  }

  async function loadWikiArticle(page: WikiPage) {
    if (!selected) return;
    const r = await fetch(`/api/wiki-folders/${selected.id}/wiki?path=${encodeURIComponent(page.path)}`);
    setWikiArticle({ path: page.path, content: (await r.json()).content ?? '' });
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setFileUploading(true);
    const text = await file.text().catch(() => '');
    setSourceForm(p => ({ ...p, type: 'file', name: p.name || file.name.replace(/\.[^.]+$/, ''), content: text }));
    setFileUploading(false); e.target.value = '';
  }

  async function createFolder() {
    if (!folderForm.name.trim()) return;
    setSaving(true);
    const folder = await fetch('/api/wiki-folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(folderForm) }).then(r => r.json());
    setFolders(prev => [...prev, folder].sort((a, b) => a.name.localeCompare(b.name)));
    setFolderForm({ name: '', description: '' }); setShowNewFolder(false); setSaving(false);
  }

  async function saveEditFolder() {
    if (!editingFolder || !folderForm.name.trim()) return;
    setSaving(true);
    const updated = await fetch(`/api/wiki-folders/${editingFolder.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: folderForm.name.trim(), description: folderForm.description }) }).then(r => r.json());
    setFolders(prev => prev.map(f => f.id === updated.id ? updated : f).sort((a, b) => a.name.localeCompare(b.name)));
    if (selected?.id === updated.id) setSelected(updated);
    setEditingFolder(null); setSaving(false);
  }

  async function deleteFolder(id: string) {
    if (!confirm('Delete this folder and all its sources? This cannot be undone.')) return;
    await fetch(`/api/wiki-folders/${id}`, { method: 'DELETE' });
    setFolders(prev => prev.filter(f => f.id !== id));
    if (selected?.id === id) setSelected(null);
  }

  function openAddSource() { setEditingSource(null); setSourceForm({ ...EMPTY_SOURCE_FORM }); setShowSourceModal(true); }
  function openEditSource(s: WikiSource) {
    setEditingSource(s);
    setSourceForm({ type: s.type, name: s.name, url: s.url ?? '', repoUrl: s.repoUrl ?? '', branch: s.branch ?? 'main', patEnvRef: s.patEnvRef ?? '', content: s.content ?? '' });
    setShowSourceModal(true);
  }

  async function saveSource() {
    if (!selected || !sourceForm.name.trim()) return;
    setSaving(true);
    const body: Record<string, string> = { type: sourceForm.type, name: sourceForm.name.trim() };
    if (sourceForm.type === 'url') body.url = sourceForm.url;
    if (sourceForm.type === 'file') body.content = sourceForm.content;
    if (sourceForm.type === 'repo') { body.repoUrl = sourceForm.repoUrl; body.branch = sourceForm.branch; if (sourceForm.patEnvRef) body.patEnvRef = sourceForm.patEnvRef; }

    if (editingSource) {
      const updated = await fetch(`/api/wiki-folders/${selected.id}/sources/${editingSource.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
      setSources(prev => prev.map(s => s.id === updated.id ? updated : s));
    } else {
      const source = await fetch(`/api/wiki-folders/${selected.id}/sources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
      setSources(prev => [...prev, source]);
    }
    setShowSourceModal(false); setEditingSource(null); setSaving(false);
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
    if (!r.ok) { const e = await r.json(); alert(e.error ?? 'Build failed'); }
    setBuildStatus(prev => ({ ...prev, [selected!.id]: '' }));
  }

  const canManageSelected = selected ? isOwnerOrAdmin(selected) : false;

  // ── Folder list view ──────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }} className="fade-up">
        {/* Header */}
        <div style={{ padding: '28px 40px 0', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.03em' }}>Knowledge Library</h1>
              <p style={{ margin: '5px 0 0', fontSize: 13, color: 'var(--muted)' }}>
                {loading ? 'Loading…' : `${folders.length} shared wiki folder${folders.length !== 1 ? 's' : ''}`}
              </p>
            </div>
            {canEdit && (
              <button onClick={() => { setFolderForm({ name: '', description: '' }); setShowNewFolder(true); }} style={primaryBtnStyle}>
                + New Folder
              </button>
            )}
          </div>
          {/* Spacer to align with tab bar on agent pages */}
          <div style={{ height: 1 }} />
        </div>

        {/* Folder grid */}
        <div style={{ padding: '28px 40px' }}>
          {loading ? (
            <div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</div>
          ) : folders.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300, gap: 16, textAlign: 'center' }}>
              <div style={{ width: 60, height: 60, borderRadius: 16, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>📚</div>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>No knowledge folders yet</p>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{canEdit ? 'Create a folder to start building shared wikis for your agents.' : 'No knowledge folders have been created yet.'}</p>
              </div>
              {canEdit && <button onClick={() => { setFolderForm({ name: '', description: '' }); setShowNewFolder(true); }} style={primaryBtnStyle}>Create First Folder</button>}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
              {folders.map(f => (
                <div
                  key={f.id}
                  onClick={() => openFolder(f)}
                  className="fade-up"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 22px', cursor: 'pointer', transition: 'box-shadow 0.2s, transform 0.2s, border-color 0.2s', boxShadow: 'var(--shadow-sm)' }}
                  onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.boxShadow = 'var(--shadow-md)'; el.style.transform = 'translateY(-2px)'; el.style.borderColor = 'var(--border-2)'; }}
                  onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.boxShadow = 'var(--shadow-sm)'; el.style.transform = 'translateY(0)'; el.style.borderColor = 'var(--border)'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>📁</div>
                  </div>
                  <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text)', marginBottom: 4, letterSpacing: '-0.01em' }}>{f.name}</div>
                  <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, minHeight: 36, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {f.description || <span style={{ fontStyle: 'italic', color: 'var(--subtle)' }}>No description</span>}
                  </p>
                  <div style={{ paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 11.5, color: 'var(--subtle)' }}>
                    Owner: {f.createdBy}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Modals */}
        {showNewFolder && (
          <Modal title="New Knowledge Folder" onClose={() => setShowNewFolder(false)}>
            <label style={labelStyle}>Name</label>
            <input style={inputStyle} autoFocus value={folderForm.name} onChange={e => setFolderForm(p => ({ ...p, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && createFolder()} placeholder="e.g. Backend API Docs" />
            <label style={labelStyle}>Description (optional)</label>
            <input style={inputStyle} value={folderForm.description} onChange={e => setFolderForm(p => ({ ...p, description: e.target.value }))} placeholder="What this folder contains" />
            <ModalFooter onCancel={() => setShowNewFolder(false)} onSave={createFolder} saving={saving} saveLabel="Create Folder" disabled={!folderForm.name.trim()} />
          </Modal>
        )}
      </div>
    );
  }

  // ── Folder detail view (agent-page style) ─────────────────────────────────
  return (
    <div style={{ minHeight: '100vh' }} className="fade-up">

      {/* Top bar */}
      <div style={{ padding: '28px 40px 0', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {/* Breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, fontSize: 12, color: 'var(--muted)' }}>
          <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 12, padding: 0 }}>Knowledge Library</button>
          <span style={{ color: 'var(--subtle)' }}>/</span>
          <span style={{ color: 'var(--text)' }}>{selected.name}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.02em' }}>{selected.name}</h1>
            {selected.description && <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--muted)' }}>{selected.description}</p>}
            <div style={{ fontSize: 11.5, color: 'var(--subtle)', marginTop: 4 }}>Owner: <span style={{ fontWeight: 500, color: 'var(--muted)' }}>{selected.createdBy}</span></div>
          </div>
          {canManageSelected && (
            <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
              <button onClick={() => { setFolderForm({ name: selected.name, description: selected.description ?? '' }); setEditingFolder(selected); }} style={outlineBtnStyle}>Edit</button>
              <button onClick={buildFolder} disabled={buildStatus[selected.id] === 'building'} style={{ ...primaryBtnStyle, opacity: buildStatus[selected.id] === 'building' ? 0.6 : 1 }}>
                {buildStatus[selected.id] === 'building' ? 'Building…' : 'Build Wiki'}
              </button>
              <button onClick={() => deleteFolder(selected.id)} style={outlineBtnStyle}>Delete</button>
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 0, overflowX: 'auto' }}>
          {(['sources', 'wiki'] as const).map(tab => (
            <button key={tab} onClick={() => switchTab(tab)} className={detailTab === tab ? 'tab-active' : ''} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '10px 14px', fontSize: 13, color: detailTab === tab ? 'var(--text)' : 'var(--muted)', fontWeight: detailTab === tab ? 500 : 400, transition: 'color 0.15s', fontFamily: 'var(--font-sans)' }}>
              {tab === 'sources' ? `Sources (${sources.length})` : 'Built Wiki'}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ padding: '28px 40px' }}>

        {/* ── Sources tab ── */}
        {detailTab === 'sources' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--subtle)', textTransform: 'uppercase' }}>Knowledge Sources</div>
              {canManageSelected && <button onClick={openAddSource} style={outlineBtnStyle}>+ Add Source</button>}
            </div>
            {sourcesLoading ? (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
            ) : sources.length === 0 ? (
              <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: '40px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                {canManageSelected ? 'No sources yet. Add a URL, file, or Git repo, then click Build Wiki.' : 'No sources added yet.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sources.map(s => (
                  <div key={s.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, boxShadow: 'var(--shadow-sm)' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', background: 'var(--surface-2)', color: 'var(--muted)', padding: '2px 7px', borderRadius: 4 }}>{s.type}</span>
                        <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{s.name}</span>
                        <span style={{ fontSize: 11.5, color: STATUS_COLOR[s.status] ?? '#a3a3a3', fontWeight: 500 }}>{s.status}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--subtle)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                        {s.url || s.repoUrl || (s.content ? `${s.content.slice(0, 90)}…` : '—')}
                      </div>
                      {s.wordCount > 0 && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>{s.wordCount.toLocaleString()} words</div>}
                    </div>
                    {canManageSelected && (
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button onClick={() => openEditSource(s)} style={{ ...outlineBtnStyle, fontSize: 12, padding: '4px 10px' }}>Edit</button>
                        <button onClick={() => deleteSource(s.id)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}>×</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Built Wiki tab ── */}
        {detailTab === 'wiki' && (
          wikiLoading ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
          : wikiPages.length === 0 ? (
            <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: '40px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
              No wiki pages built yet.{canManageSelected && ' Add sources then click Build Wiki.'}
            </div>
          ) : wikiArticle ? (
            <div>
              <button onClick={() => setWikiArticle(null)} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, padding: '0 0 16px', display: 'block' }}>← All pages</button>
              <pre style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '20px', fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)', fontFamily: 'var(--font-mono)', margin: 0 }}>{wikiArticle.content}</pre>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--subtle)', textTransform: 'uppercase', marginBottom: 14 }}>{wikiPages.length} page{wikiPages.length !== 1 ? 's' : ''}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {wikiPages.map(p => (
                  <button key={p.path} onClick={() => loadWikiArticle(p)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '13px 16px', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: 'var(--shadow-sm)' }}>
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>{p.title}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--subtle)', fontFamily: 'var(--font-mono)' }}>{p.path}</div>
                    </div>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0, marginLeft: 12 }}>{Math.round(p.size / 1024 * 10) / 10} KB</span>
                  </button>
                ))}
              </div>
            </>
          )
        )}
      </div>

      {/* ── Edit Folder Modal ── */}
      {editingFolder && (
        <Modal title="Edit Folder" onClose={() => setEditingFolder(null)}>
          <label style={labelStyle}>Name</label>
          <input style={inputStyle} autoFocus value={folderForm.name} onChange={e => setFolderForm(p => ({ ...p, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && saveEditFolder()} />
          <label style={labelStyle}>Description</label>
          <input style={inputStyle} value={folderForm.description} onChange={e => setFolderForm(p => ({ ...p, description: e.target.value }))} placeholder="What this folder contains" />
          <ModalFooter onCancel={() => setEditingFolder(null)} onSave={saveEditFolder} saving={saving} saveLabel="Save" disabled={!folderForm.name.trim()} />
        </Modal>
      )}

      {/* ── Add / Edit Source Modal ── */}
      {showSourceModal && (
        <Modal title={editingSource ? 'Edit Source' : 'Add Source'} onClose={() => { setShowSourceModal(false); setEditingSource(null); }}>
          <label style={labelStyle}>Type</label>
          <select style={inputStyle} value={sourceForm.type} onChange={e => setSourceForm(p => ({ ...p, type: e.target.value }))} disabled={!!editingSource}>
            <option value="url">URL</option>
            <option value="file">File</option>
            <option value="repo">Git Repository</option>
          </select>
          <label style={labelStyle}>Name</label>
          <input style={inputStyle} autoFocus value={sourceForm.name} onChange={e => setSourceForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. API Reference" />

          {sourceForm.type === 'url' && (
            <>
              <label style={labelStyle}>URL</label>
              <input style={inputStyle} value={sourceForm.url} onChange={e => setSourceForm(p => ({ ...p, url: e.target.value }))} placeholder="https://docs.example.com" />
            </>
          )}

          {sourceForm.type === 'file' && (
            <>
              <label style={labelStyle}>Content</label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={fileUploading} style={{ background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--text)', flexShrink: 0 }}>
                  {fileUploading ? 'Reading…' : '📎 Upload file'}
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {sourceForm.content ? `${sourceForm.content.length.toLocaleString()} chars` : 'or paste below'}
                </span>
              </div>
              <input ref={fileInputRef} type="file" accept=".txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.rst,.ts,.js,.py,.go,.rb,.java,.c,.cpp,.h" style={{ display: 'none' }} onChange={handleFileSelect} />
              <textarea style={{ ...inputStyle, minHeight: 140, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }} value={sourceForm.content} onChange={e => setSourceForm(p => ({ ...p, content: e.target.value }))} placeholder="Paste content here, or upload a file above…" />
            </>
          )}

          {sourceForm.type === 'repo' && (
            <>
              <label style={labelStyle}>Repository URL</label>
              <input style={inputStyle} value={sourceForm.repoUrl} onChange={e => setSourceForm(p => ({ ...p, repoUrl: e.target.value }))} placeholder="https://github.com/org/repo" />
              <label style={labelStyle}>Branch</label>
              <input style={inputStyle} value={sourceForm.branch} onChange={e => setSourceForm(p => ({ ...p, branch: e.target.value }))} placeholder="main" />
              <label style={labelStyle}>PAT env var (private repos only)</label>
              <select style={inputStyle} value={sourceForm.patEnvRef} onChange={e => setSourceForm(p => ({ ...p, patEnvRef: e.target.value }))}>
                <option value="">— None (public repo) —</option>
                {envVarKeys.map(k => <option key={k} value={k}>{k}</option>)}
                {envVarKeys.length === 0 && <option disabled>No accessible env vars</option>}
              </select>
            </>
          )}

          <ModalFooter onCancel={() => { setShowSourceModal(false); setEditingSource(null); }} onSave={saveSource} saving={saving} saveLabel={editingSource ? 'Save Changes' : 'Add Source'} disabled={!sourceForm.name.trim()} />
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--surface)', borderRadius: 14, padding: '28px 28px 24px', width: 460, maxWidth: '92vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 20 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function ModalFooter({ onCancel, onSave, saving, saveLabel, disabled }: { onCancel: () => void; onSave: () => void; saving: boolean; saveLabel: string; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 22 }}>
      <button onClick={onCancel} style={cancelBtnStyle}>Cancel</button>
      <button onClick={onSave} disabled={saving || disabled} style={{ ...primaryBtnStyle, opacity: (saving || disabled) ? 0.5 : 1 }}>{saving ? 'Saving…' : saveLabel}</button>
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5, marginTop: 14 };
const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 10px', fontSize: 13.5, color: 'var(--text)', background: 'var(--surface-2)', outline: 'none' };
const cancelBtnStyle: React.CSSProperties = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 16px', fontSize: 13, cursor: 'pointer', color: 'var(--text)' };
const primaryBtnStyle: React.CSSProperties = { background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13.5, fontWeight: 500, cursor: 'pointer' };
const outlineBtnStyle: React.CSSProperties = { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 14px', fontSize: 13, cursor: 'pointer' };
