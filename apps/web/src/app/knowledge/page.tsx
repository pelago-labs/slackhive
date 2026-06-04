'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth-context';
import { ChevronDown, ChevronRight, FileText, BookOpen, Download, Globe, GitBranch, Pencil, Trash2, RefreshCw } from 'lucide-react';

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
  status: 'pending' | 'building' | 'compiled' | 'stale' | 'error';
  wordCount: number;
  lastSynced?: string;
}

interface WikiPage { path: string; title: string; size: number; }

interface BuildProgress {
  status: string;
  step?: string;
  buildStartedAt?: string;
  sourceName?: string;
  sourceIdx?: number;
  sourcesTotal?: number;
  chunkIdx?: number;
  chunksTotal?: number;
  chunkStartedAt?: string;
  articlesWritten?: number;
  pages?: number;
  words?: number;
  error?: string;
  message?: string;
}

// ─── Wiki Tree ────────────────────────────────────────────────────────────────
type TreeNode = { name: string; path?: string; title?: string; size?: number; children: TreeNode[] };

function buildTree(articles: WikiPage[]): TreeNode[] {
  const root: TreeNode = { name: '', children: [] };
  for (const article of articles) {
    const parts = article.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      let child = node.children.find(c => c.name === part);
      if (!child) {
        child = isFile
          ? { name: part, path: article.path, title: article.title, size: article.size, children: [] }
          : { name: part, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const aIsFolder = a.children.length > 0 && !a.path;
      const bIsFolder = b.children.length > 0 && !b.path;
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(root.children);
  return root.children;
}

const FOLDER_LABELS: Record<string, string> = { concepts: 'Concepts', entities: 'Entities', flows: 'Flows', modules: 'Modules' };

function WikiTreeNode({ node, depth, onSelect, selected }: { node: TreeNode; depth: number; onSelect: (path: string) => void; selected: string | null }) {
  const [open, setOpen] = useState(true);
  const isFolder = !node.path && node.children.length > 0;
  const label = isFolder ? (FOLDER_LABELS[node.name] || node.name) : (node.title || node.name.replace('.md', ''));
  const isActive = node.path === selected;

  if (isFolder) {
    return (
      <div>
        <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', padding: `6px 6px 2px ${6 + depth * 12}px`, fontSize: 10.5, color: 'var(--subtle)', fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}>
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {label}/
        </div>
        {open && node.children.map(child => (
          <WikiTreeNode key={child.path || child.name} node={child} depth={depth + 1} onSelect={onSelect} selected={selected} />
        ))}
      </div>
    );
  }

  return (
    <div
      onClick={() => node.path && onSelect(node.path)}
      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: `4px 8px 4px ${8 + depth * 12}px`, borderRadius: 6, cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-mono)', background: isActive ? 'rgba(59,130,246,0.12)' : 'transparent', color: isActive ? 'var(--accent)' : 'var(--muted)', transition: 'background 0.12s, color 0.12s', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
      onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <FileText size={12} style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name.replace('.md', '')}</span>
    </div>
  );
}

function WikiTree({ articles, onSelect, selected }: { articles: WikiPage[]; onSelect: (path: string) => void; selected: string | null }) {
  const tree = buildTree(articles);
  return (
    <div style={{ padding: '6px', flex: 1, overflow: 'auto' }}>
      {tree.map(node => (
        <WikiTreeNode key={node.path || node.name} node={node} depth={0} onSelect={onSelect} selected={selected} />
      ))}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  compiled: '#059669', stale: '#d97706', building: '#2563eb', pending: '#a3a3a3', error: '#dc2626',
};

const SOURCE_TYPE_ICON: Record<string, React.ReactNode> = {
  url:  <Globe size={13} />,
  file: <FileText size={13} />,
  repo: <GitBranch size={13} />,
};

const timeAgo = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const EMPTY_SOURCE_FORM = { type: 'url', name: '', url: '', repoUrl: '', branch: 'main', patEnvRef: '', content: '' };

export default function KnowledgePage() {
  const { canEdit, username, role } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollAbortRef = useRef(false);

  useEffect(() => {
    pollAbortRef.current = false;
    return () => { pollAbortRef.current = true; };
  }, []);

  const [folders, setFolders]                 = useState<WikiFolder[]>([]);
  const [folderStats, setFolderStats]         = useState<Record<string, { sources: number; words: number; lastSynced: string | null }>>({});
  const [loading, setLoading]                 = useState(true);
  const [selected, setSelected]               = useState<WikiFolder | null>(null);
  const [detailTab, setDetailTab]             = useState<'sources' | 'wiki'>('sources');
  const [sources, setSources]                 = useState<WikiSource[]>([]);
  const [sourcesLoading, setSourcesLoading]   = useState(false);
  const [wikiPages, setWikiPages]             = useState<WikiPage[]>([]);
  const [wikiLoading, setWikiLoading]         = useState(false);
  const [selectedArticle, setSelectedArticle] = useState<string | null>(null);
  const [articleContent, setArticleContent]   = useState('');
  const [loadingArticle, setLoadingArticle]   = useState(false);
  const [showNewFolder, setShowNewFolder]     = useState(false);
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [editingSource, setEditingSource]     = useState<WikiSource | null>(null);
  const [editingFolder, setEditingFolder]     = useState<WikiFolder | null>(null);
  const [folderForm, setFolderForm]           = useState({ name: '', description: '' });
  const [sourceForm, setSourceForm]           = useState({ ...EMPTY_SOURCE_FORM });
  const [fileUploading, setFileUploading]     = useState(false);
  const [saving, setSaving]                       = useState(false);
  const [buildStatus, setBuildStatus]             = useState<Record<string, string>>({});
  const [buildProgress, setBuildProgress]         = useState<Record<string, BuildProgress>>({});
  const [showBuildDropdown, setShowBuildDropdown] = useState(false);
  const [syncStatus, setSyncStatus]               = useState<Record<string, string>>({});
  const [envVarKeys, setEnvVarKeys]               = useState<string[]>([]);
  const [downloading, setDownloading]             = useState(false);

  const isAdmin = role === 'admin' || role === 'superadmin';
  const isOwnerOrAdmin = (f: WikiFolder) => isAdmin || (canEdit && f.createdBy === username);

  useEffect(() => {
    fetch('/api/wiki-folders').then(r => r.json()).then((fs: WikiFolder[]) => {
      setFolders(fs);
      // Per-folder counts for the landing cards (one /sources fetch each).
      fs.forEach(f => {
        fetch(`/api/wiki-folders/${f.id}/sources`).then(r => r.ok ? r.json() : []).then((srcs: WikiSource[]) => {
          const words = srcs.reduce((s, x) => s + (x.wordCount || 0), 0);
          const lastSynced = srcs.reduce<string | null>((m, x) => (x.lastSynced && (!m || x.lastSynced > m) ? x.lastSynced : m), null);
          setFolderStats(prev => ({ ...prev, [f.id]: { sources: srcs.length, words, lastSynced } }));
        }).catch(() => {});
      });
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch('/api/env-vars').then(r => r.json()).then((rows: { key: string; createdBy: string }[]) => {
      setEnvVarKeys((isAdmin ? rows : rows.filter(r => r.createdBy === username)).map(r => r.key));
    }).catch(() => {});
  }, [username, role]);

  function openFolder(f: WikiFolder) {
    setSelected(f); setSelectedArticle(null); setDetailTab('sources');
    setSourcesLoading(true); setSources([]);
    fetch(`/api/wiki-folders/${f.id}/sources`).then(r => r.json()).then(setSources).finally(() => setSourcesLoading(false));
    // Resume progress polling if a build is already in progress
    fetch(`/api/wiki-folders/${f.id}/build`).then(r => r.json()).then((p: BuildProgress) => {
      if (p?.status === 'building') {
        setBuildStatus(prev => ({ ...prev, [f.id]: 'building' }));
        setBuildProgress(prev => ({ ...prev, [f.id]: p }));
        const resumePoll = async () => {
          if (pollAbortRef.current) return;
          const latest: BuildProgress = await fetch(`/api/wiki-folders/${f.id}/build`).then(r => r.json()).catch(() => null);
          if (pollAbortRef.current) return;
          if (!latest || latest.status === 'done' || latest.status === 'error' || latest.status === 'idle') {
            setBuildStatus(prev => ({ ...prev, [f.id]: latest?.status === 'error' ? 'error' : '' }));
            setBuildProgress(prev => ({ ...prev, [f.id]: latest ?? {} }));
            fetch(`/api/wiki-folders/${f.id}/sources`).then(r => r.json()).then(setSources).catch(() => {});
            return;
          }
          setBuildProgress(prev => ({ ...prev, [f.id]: latest }));
          setTimeout(resumePoll, 3000);
        };
        setTimeout(resumePoll, 3000);
      }
    }).catch(() => {});
  }

  function switchTab(tab: 'sources' | 'wiki') {
    setDetailTab(tab); setSelectedArticle(null);
    if (tab === 'wiki' && selected) {
      setWikiLoading(true); setWikiPages([]);
      fetch(`/api/wiki-folders/${selected.id}/wiki`).then(r => r.json()).then(d => setWikiPages(d.pages ?? [])).finally(() => setWikiLoading(false));
    }
  }

  async function viewArticle(articlePath: string) {
    if (!selected) return;
    setSelectedArticle(articlePath);
    setLoadingArticle(true);
    try {
      const r = await fetch(`/api/wiki-folders/${selected.id}/wiki?path=${encodeURIComponent(articlePath)}`);
      const data = await r.json();
      setArticleContent(data.content ?? '');
    } catch { setArticleContent('Failed to load article.'); }
    finally { setLoadingArticle(false); }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

    if (isPdf) {
      if (file.size > 10 * 1024 * 1024) { alert('PDF is too large. Maximum size is 10 MB.'); e.target.value = ''; return; }
      setFileUploading(true);
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/parse-pdf', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) { alert(data.error ?? 'Failed to parse PDF.'); return; }
        setSourceForm(p => ({ ...p, type: 'file', name: p.name || file.name.replace(/\.pdf$/i, ''), content: data.text }));
      } finally { setFileUploading(false); e.target.value = ''; }
      return;
    }

    if (file.size > 2 * 1024 * 1024) { alert('File is too large. Maximum size is 2 MB.'); e.target.value = ''; return; }
    // Reject other binary formats
    const BINARY_TYPES = /^application\/(zip|octet-stream|msword|vnd\.|x-executable)/;
    if (file.type && BINARY_TYPES.test(file.type)) {
      alert('Binary files are not supported. Please upload a plain text, Markdown, or PDF file.');
      e.target.value = ''; return;
    }
    setFileUploading(true);
    const text = await file.text().catch(() => '');
    if (!text.trim()) { alert('The file appears to be empty or could not be read as text.'); setFileUploading(false); e.target.value = ''; return; }
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
    const folder = folders.find(f => f.id === id);
    if (!confirm(`Delete "${folder?.name ?? 'this folder'}"?\n\nThis will permanently delete the folder and all its sources. This cannot be undone.`)) return;
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
      const r = await fetch(`/api/wiki-folders/${selected.id}/sources/${editingSource.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const updated = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(`Save failed: ${updated.error ?? `HTTP ${r.status}`}`);
        setSaving(false);
        return;
      }
      setSources(prev => prev.map(s => s.id === updated.id ? updated : s));
    } else {
      const r = await fetch(`/api/wiki-folders/${selected.id}/sources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const source = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(`Add failed: ${source.error ?? `HTTP ${r.status}`}`);
        setSaving(false);
        return;
      }
      setSources(prev => [...prev, source]);
    }
    setShowSourceModal(false); setEditingSource(null); setSaving(false);
  }

  async function deleteSource(id: string, name: string) {
    if (!selected) return;
    if (!confirm(`Delete source "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/wiki-folders/${selected.id}/sources/${id}`, { method: 'DELETE' });
    setSources(prev => prev.filter(s => s.id !== id));
  }

  async function buildFolder(scratch = false) {
    if (!selected) return;
    setShowBuildDropdown(false);
    const folderId = selected.id;
    setBuildStatus(prev => ({ ...prev, [folderId]: 'building' }));
    setBuildProgress(prev => ({ ...prev, [folderId]: { status: 'building', step: scratch ? 'Clearing wiki…' : 'Starting…' } }));
    const r = await fetch(`/api/wiki-folders/${folderId}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scratch }) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.error ?? 'Build failed'); setBuildStatus(prev => ({ ...prev, [folderId]: '' })); return; }
    const { requestId } = await r.json();
    // Poll indefinitely until done or error
    const poll = async () => {
      if (pollAbortRef.current) return;
      const p: BuildProgress = await fetch(`/api/wiki-folders/${folderId}/build?requestId=${requestId}`).then(x => x.json()).catch(() => null);
      if (pollAbortRef.current) return;
      if (!p || p.status === 'done' || p.status === 'error' || p.status === 'idle') {
        setBuildStatus(prev => ({ ...prev, [folderId]: p?.status === 'error' ? 'error' : '' }));
        setBuildProgress(prev => ({ ...prev, [folderId]: p ?? {} }));
        fetch(`/api/wiki-folders/${folderId}/sources`).then(x => x.json()).then(setSources).catch(() => {});
        return;
      }
      setBuildProgress(prev => ({ ...prev, [folderId]: p }));
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 2000);
  }

  async function syncSource(sourceId: string) {
    if (!selected) return;
    const folderId = selected.id;
    setSyncStatus(prev => ({ ...prev, [sourceId]: 'building' }));
    const r = await fetch(`/api/wiki-folders/${folderId}/sources/${sourceId}/sync`, { method: 'POST' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.error ?? 'Sync failed'); setSyncStatus(prev => ({ ...prev, [sourceId]: '' })); return; }
    const { requestId } = await r.json();
    const poll = async () => {
      if (pollAbortRef.current) return;
      const p = await fetch(`/api/wiki-folders/${folderId}/sources/${sourceId}/sync?requestId=${requestId}`).then(x => x.json()).catch(() => null);
      if (pollAbortRef.current) return;
      if (!p || p.status === 'done' || p.status === 'error' || p.status === 'idle') {
        setSyncStatus(prev => ({ ...prev, [sourceId]: '' }));
        fetch(`/api/wiki-folders/${folderId}/sources`).then(x => x.json()).then(setSources).catch(() => {});
        return;
      }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 2000);
  }

  const canManageSelected = selected ? isOwnerOrAdmin(selected) : false;

  const anySourceBuilding = sources.some(s => s.status === 'building') || syncStatus && Object.values(syncStatus).some(v => v === 'building');
  const folderIsBuilding = buildStatus[selected?.id ?? ''] === 'building' || anySourceBuilding;

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
              <div style={{ width: 60, height: 60, borderRadius: 16, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <BookOpen size={28} style={{ color: 'var(--border-2)' }} />
              </div>
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
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--text)' }}>
                      <BookOpen size={18} />
                    </div>
                    {folderStats[f.id] && (
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 99, padding: '2px 9px' }}>
                        {folderStats[f.id].sources} source{folderStats[f.id].sources !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text)', marginBottom: 4, letterSpacing: '-0.01em' }}>{f.name}</div>
                  <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, minHeight: 36, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {f.description || <span style={{ fontStyle: 'italic', color: 'var(--subtle)' }}>No description</span>}
                  </p>
                  <div style={{ paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--subtle)' }}>
                    {(() => {
                      const st = folderStats[f.id];
                      if (!st) return <span>—</span>;
                      return (
                        <>
                          <span>{st.words >= 1000 ? `${(st.words / 1000).toFixed(1)}k` : st.words} words</span>
                          {st.lastSynced && <><span style={{ color: 'var(--border-2)' }}>·</span><span>synced {timeAgo(st.lastSynced)}</span></>}
                        </>
                      );
                    })()}
                    <span style={{ marginLeft: 'auto' }}>Owner: {f.createdBy}</span>
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
              {/* Edit icon */}
              <button
                title="Edit folder"
                onClick={() => { setFolderForm({ name: selected.name, description: selected.description ?? '' }); setEditingFolder(selected); }}
                disabled={folderIsBuilding}
                style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, cursor: folderIsBuilding ? 'not-allowed' : 'pointer', opacity: folderIsBuilding ? 0.4 : 1, color: 'var(--muted)', flexShrink: 0 }}
              >
                <Pencil size={14} />
              </button>

              {/* Build Wiki split button */}
              <div style={{ position: 'relative' }}>
                <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden' }}>
                  <button
                    onClick={() => buildFolder(false)}
                    disabled={folderIsBuilding}
                    style={{ ...primaryBtnStyle, borderRadius: 0, borderRight: '1px solid rgba(255,255,255,0.2)', opacity: folderIsBuilding ? 0.6 : 1 }}
                  >
                    {folderIsBuilding ? 'Building…' : 'Build Wiki'}
                  </button>
                  <button
                    onClick={() => setShowBuildDropdown(v => !v)}
                    disabled={folderIsBuilding}
                    style={{ ...primaryBtnStyle, borderRadius: 0, padding: '9px 10px', opacity: folderIsBuilding ? 0.6 : 1 }}
                  >
                    <ChevronDown size={14} />
                  </button>
                </div>
                {showBuildDropdown && !folderIsBuilding && (
                  <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-md)', zIndex: 100, minWidth: 200, overflow: 'hidden' }}>
                    <button onClick={() => buildFolder(false)} style={{ display: 'block', width: '100%', background: 'none', border: 'none', padding: '10px 16px', textAlign: 'left', fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
                      Build pending / stale
                    </button>
                    <button onClick={() => buildFolder(true)} style={{ display: 'block', width: '100%', background: 'none', border: 'none', padding: '10px 16px', textAlign: 'left', fontSize: 13, color: 'var(--red)', cursor: 'pointer' }}>
                      Rebuild from scratch
                    </button>
                  </div>
                )}
              </div>

              {/* Delete icon */}
              <button
                title="Delete folder"
                onClick={() => deleteFolder(selected.id)}
                disabled={folderIsBuilding}
                style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, cursor: folderIsBuilding ? 'not-allowed' : 'pointer', opacity: folderIsBuilding ? 0.4 : 1, color: 'var(--red)', flexShrink: 0 }}
              >
                <Trash2 size={14} />
              </button>
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

      {/* Build progress panel */}
      {folderIsBuilding && selected && (
        <BuildProgressPanel progress={buildProgress[selected.id]} />
      )}

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
                {sources.map(s => {
                  const isSyncing = syncStatus[s.id] === 'building' || s.status === 'building';
                  const disabled = folderIsBuilding;
                  const iconBtn = (color = 'var(--muted)'): React.CSSProperties => ({
                    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
                    color, flexShrink: 0,
                  });
                  return (
                    <div key={s.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, boxShadow: 'var(--shadow-sm)' }}>
                      {/* Left: info */}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {/* Row 1: type icon + name */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                          <span style={{ color: 'var(--muted)', flexShrink: 0, display: 'flex' }}>{SOURCE_TYPE_ICON[s.type]}</span>
                          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                        </div>
                        {/* Row 2: url/path */}
                        <div style={{ fontSize: 11.5, color: 'var(--subtle)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 6 }}>
                          {s.url || s.repoUrl || (s.content ? `${s.content.slice(0, 80)}…` : '—')}
                        </div>
                        {/* Row 3: status dot + word count + last synced */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_COLOR[s.status] ?? '#a3a3a3', flexShrink: 0, display: 'inline-block' }} />
                            <span style={{ fontSize: 11.5, color: STATUS_COLOR[s.status] ?? '#a3a3a3', fontWeight: 500 }}>{s.status}</span>
                          </span>
                          {s.wordCount > 0 && (
                            <span style={{ fontSize: 11.5, color: 'var(--subtle)' }}>{s.wordCount.toLocaleString()} words</span>
                          )}
                          {s.lastSynced && (
                            <span style={{ fontSize: 11.5, color: 'var(--subtle)' }}>synced {timeAgo(s.lastSynced)}</span>
                          )}
                        </div>
                      </div>
                      {/* Right: icon actions */}
                      {canManageSelected && (
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                          <button
                            title={isSyncing ? 'Syncing…' : 'Sync source'}
                            onClick={() => !isSyncing && !disabled && syncSource(s.id)}
                            disabled={disabled}
                            style={iconBtn(isSyncing ? STATUS_COLOR.building : 'var(--muted)')}
                          >
                            <RefreshCw size={13} style={isSyncing ? { animation: 'spin 1s linear infinite' } : undefined} />
                          </button>
                          <button
                            title="Edit source"
                            onClick={() => openEditSource(s)}
                            disabled={disabled}
                            style={iconBtn()}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            title="Delete source"
                            onClick={() => deleteSource(s.id, s.name)}
                            disabled={disabled}
                            style={iconBtn('var(--red)')}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
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
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                <BookOpen size={14} style={{ color: 'var(--muted)' }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Wiki</span>
                <span style={{ fontSize: 12, color: 'var(--subtle)' }}>{wikiPages.length} articles</span>
              </div>
              <div style={{ display: 'flex', gap: 14, height: 480 }}>
                {/* Sidebar — file tree */}
                <div style={{ width: 220, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Articles</span>
                    <span style={{ fontSize: 10, color: 'var(--subtle)' }}>{wikiPages.length}</span>
                  </div>
                  <WikiTree articles={wikiPages} onSelect={viewArticle} selected={selectedArticle} />
                </div>

                {/* Main — article content */}
                <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  {selectedArticle ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                        <FileText size={13} style={{ color: 'var(--muted)' }} />
                        <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>{selectedArticle}</span>
                      </div>
                      <div style={{ flex: 1, padding: '16px 18px', overflow: 'auto' }}>
                        {loadingArticle ? (
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading…</div>
                        ) : (
                          <pre style={{ margin: 0, fontSize: 12.5, lineHeight: 1.7, color: 'var(--text)', fontFamily: 'var(--font-sans)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{articleContent}</pre>
                        )}
                      </div>
                    </>
                  ) : (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
                      <BookOpen size={28} style={{ color: 'var(--border-2)' }} />
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Select an article to view</p>
                      <p style={{ margin: 0, fontSize: 11, color: 'var(--subtle)' }}>Browse the folder tree on the left</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
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
                  {fileUploading ? 'Reading…' : 'Upload file'}
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {sourceForm.content ? `${sourceForm.content.length.toLocaleString()} chars` : 'or paste below'}
                </span>
              </div>
              <input ref={fileInputRef} type="file" accept=".txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.rst,.ts,.js,.py,.go,.rb,.java,.c,.cpp,.h,.pdf" style={{ display: 'none' }} onChange={handleFileSelect} />
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

// ─── Build Progress Panel ─────────────────────────────────────────────────────

function BuildProgressPanel({ progress }: { progress?: BuildProgress }) {
  const [elapsed, setElapsed] = useState('');
  const [chunkElapsed, setChunkElapsed] = useState('');

  useEffect(() => {
    const tick = () => {
      if (progress?.buildStartedAt) {
        const secs = Math.floor((Date.now() - new Date(progress.buildStartedAt).getTime()) / 1000);
        setElapsed(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);
      }
      if (progress?.chunkStartedAt) {
        const secs = Math.floor((Date.now() - new Date(progress.chunkStartedAt).getTime()) / 1000);
        setChunkElapsed(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [progress?.buildStartedAt, progress?.chunkStartedAt]);

  const sourceIdx = progress?.sourceIdx ?? 0;
  const sourcesTotal = progress?.sourcesTotal ?? 1;
  const chunkIdx = progress?.chunkIdx ?? 0;
  const chunksTotal = progress?.chunksTotal ?? 1;
  const sourcePct = sourcesTotal > 0 ? Math.round(((sourceIdx + (chunksTotal > 1 ? chunkIdx / chunksTotal : 0)) / sourcesTotal) * 100) : 0;

  // ETA: extrapolate from chunk timing if available
  let eta = '';
  if (progress?.chunkStartedAt && chunksTotal > 1) {
    const chunkSecs = (Date.now() - new Date(progress.chunkStartedAt).getTime()) / 1000;
    const remainingChunks = (chunksTotal - chunkIdx - 1) + (sourcesTotal - sourceIdx - 1) * chunksTotal;
    if (chunkSecs > 5 && remainingChunks > 0) {
      const etaSecs = Math.round(chunkSecs * remainingChunks);
      eta = etaSecs < 60 ? `~${etaSecs}s` : `~${Math.floor(etaSecs / 60)}m`;
    }
  }

  return (
    <div style={{
      margin: '16px 40px 0', padding: '14px 18px',
      background: 'rgba(37,99,235,0.07)', border: '1px solid rgba(37,99,235,0.2)',
      borderRadius: 10, fontSize: 13,
    }}>
      {/* Top row: what's happening */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#2563eb', animation: 'pulse 1.5s ease-in-out infinite' }} />
        <span style={{ fontWeight: 500, color: 'var(--text)' }}>
          {progress?.sourceName
            ? `Building wiki for ${progress.sourceName}`
            : (progress?.step ?? 'Building…')}
        </span>
        {elapsed && <span style={{ marginLeft: 'auto', color: 'var(--subtle)', fontSize: 12 }}>Elapsed: {elapsed}</span>}
      </div>

      {/* Source progress bar */}
      {sourcesTotal > 1 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>
            <span>Source {sourceIdx + 1} of {sourcesTotal}</span>
            {eta && <span>ETA {eta}</span>}
          </div>
          <div style={{ height: 4, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${sourcePct}%`, background: '#2563eb', borderRadius: 4, transition: 'width 0.5s' }} />
          </div>
        </div>
      )}

      {/* Chunk progress */}
      {chunksTotal > 1 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>
            <span>Chunk {chunkIdx + 1} of {chunksTotal} {chunkElapsed ? `(${chunkElapsed} on this chunk)` : ''}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              Each chunk ≈ 100k chars of source code
            </span>
          </div>
          <div style={{ height: 4, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round(((chunkIdx) / chunksTotal) * 100)}%`, background: 'rgba(37,99,235,0.5)', borderRadius: 4, transition: 'width 0.5s' }} />
          </div>
        </div>
      )}

      {/* Detail step */}
      {progress?.step && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
          {progress.step}
          {progress.articlesWritten ? ` · ${progress.articlesWritten} articles written so far` : ''}
        </div>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--surface)', borderRadius: 14, padding: '28px 28px 24px', width: 460, maxWidth: '92vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 20 }}>{title}</div>
        {children}
      </div>
    </div>,
    document.body,
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
const primaryBtnStyle: React.CSSProperties = { background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer' };
const outlineBtnStyle: React.CSSProperties = { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 14px', fontSize: 13, cursor: 'pointer' };
