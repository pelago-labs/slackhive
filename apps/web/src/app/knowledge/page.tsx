'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth-context';
import { ChevronDown, ChevronRight, FileText, BookOpen, Globe, GitBranch, Pencil, Trash2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

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
        <div
          onClick={() => setOpen(!open)}
          className="flex cursor-pointer items-center gap-1 pb-0.5 pt-1.5 font-mono text-2xs tracking-[0.02em] text-muted-foreground"
          style={{ paddingLeft: 6 + depth * 12, paddingRight: 6 }}
        >
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
      className={cn(
        'flex cursor-pointer items-center gap-1 overflow-hidden truncate whitespace-nowrap rounded-md py-1 pr-2 font-mono text-xs transition-colors',
        isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary',
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <FileText size={12} className="shrink-0" />
      <span className="overflow-hidden truncate whitespace-nowrap">{node.name.replace('.md', '')}</span>
    </div>
  );
}

function WikiTree({ articles, onSelect, selected }: { articles: WikiPage[]; onSelect: (path: string) => void; selected: string | null }) {
  const tree = buildTree(articles);
  return (
    <div className="flex-1 overflow-auto p-1.5">
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

  const isAdmin = role === 'admin' || role === 'superadmin';
  const isOwnerOrAdmin = (f: WikiFolder) => isAdmin || (canEdit && f.createdBy === username);

  useEffect(() => {
    // Deep-link: /knowledge?folder=<id> (e.g. from an agent's Wiki tab) auto-opens
    // that folder once the list loads. Read from window (not useSearchParams) so
    // the statically-prerendered page doesn't need a Suspense boundary.
    const initialFolderId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('folder') : null;
    fetch('/api/wiki-folders').then(r => r.json()).then((fs: WikiFolder[]) => {
      setFolders(fs);
      if (initialFolderId) {
        const found = fs.find(f => f.id === initialFolderId);
        if (found) openFolder(found);
        // Strip the param either way so a stale/invalid id doesn't linger in the
        // URL (and a refresh doesn't keep re-triggering). If not found, the user
        // simply lands on the folder grid.
        const url = new URL(window.location.href);
        url.searchParams.delete('folder');
        window.history.replaceState({}, '', url.toString());
      }
      // Per-folder counts for the landing cards (one /sources fetch each).
      fs.forEach(f => {
        fetch(`/api/wiki-folders/${f.id}/sources`).then(r => r.ok ? r.json() : []).then((srcs: WikiSource[]) => {
          const words = srcs.reduce((s, x) => s + (x.wordCount || 0), 0);
          const lastSynced = srcs.reduce<string | null>((m, x) => (x.lastSynced && (!m || x.lastSynced > m) ? x.lastSynced : m), null);
          setFolderStats(prev => ({ ...prev, [f.id]: { sources: srcs.length, words, lastSynced } }));
        }).catch(() => {});
      });
    }).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <div className="fade-up flex min-h-screen flex-col">
        {/* Header */}
        <div className="shrink-0 border-b border-border px-10 pt-7">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <h1 className="m-0 text-xl font-bold tracking-tight text-foreground">Knowledge Library</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {loading ? 'Loading…' : `${folders.length} shared wiki folder${folders.length !== 1 ? 's' : ''}`}
              </p>
            </div>
            {canEdit && (
              <Button onClick={() => { setFolderForm({ name: '', description: '' }); setShowNewFolder(true); }}>
                + New Folder
              </Button>
            )}
          </div>
          {/* Spacer to align with tab bar on agent pages */}
          <div className="h-px" />
        </div>

        {/* Folder grid */}
        <div className="px-10 py-7">
          {loading ? (
            <div className="text-base text-muted-foreground">Loading…</div>
          ) : folders.length === 0 ? (
            <div className="flex min-h-[300px] flex-col items-center justify-center gap-4 text-center">
              <div className="flex h-[60px] w-[60px] items-center justify-center rounded-2xl border border-border bg-secondary">
                <BookOpen size={28} className="text-muted-foreground" />
              </div>
              <div>
                <p className="m-0 mb-1 text-md font-semibold text-foreground">No knowledge folders yet</p>
                <p className="m-0 text-sm text-muted-foreground">{canEdit ? 'Create a folder to start building shared wikis for your agents.' : 'No knowledge folders have been created yet.'}</p>
              </div>
              {canEdit && <Button onClick={() => { setFolderForm({ name: '', description: '' }); setShowNewFolder(true); }}>Create First Folder</Button>}
            </div>
          ) : (
            <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
              {folders.map(f => (
                <div
                  key={f.id}
                  onClick={() => openFolder(f)}
                  className="fade-up cursor-pointer rounded-xl border border-border bg-card px-5 py-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-input hover:shadow-md"
                >
                  <div className="mb-2.5 flex items-start justify-between">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-foreground">
                      <BookOpen size={18} />
                    </div>
                    {folderStats[f.id] && (
                      <span className="rounded-full border border-border bg-secondary px-2.5 py-0.5 text-2xs font-semibold text-muted-foreground">
                        {folderStats[f.id].sources} source{folderStats[f.id].sources !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <div className="mb-1 text-base font-semibold tracking-tight text-foreground">{f.name}</div>
                  <p className="m-0 mb-3.5 line-clamp-2 min-h-[36px] overflow-hidden text-xs leading-relaxed text-muted-foreground">
                    {f.description || <span className="italic text-muted-foreground">No description</span>}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-2xs text-muted-foreground">
                    {(() => {
                      const st = folderStats[f.id];
                      if (!st) return <span>—</span>;
                      return (
                        <>
                          <span>{st.words >= 1000 ? `${(st.words / 1000).toFixed(1)}k` : st.words} words</span>
                          {st.lastSynced && <><span className="text-muted-foreground">·</span><span>synced {timeAgo(st.lastSynced)}</span></>}
                        </>
                      );
                    })()}
                    <span className="ml-auto">Owner: {f.createdBy}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Modals */}
        {showNewFolder && (
          <Modal title="New Knowledge Folder" onClose={() => setShowNewFolder(false)}>
            <label className={labelClass}>Name</label>
            <input className={inputClass} autoFocus value={folderForm.name} onChange={e => setFolderForm(p => ({ ...p, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && createFolder()} placeholder="e.g. Backend API Docs" />
            <label className={labelClass}>Description (optional)</label>
            <input className={inputClass} value={folderForm.description} onChange={e => setFolderForm(p => ({ ...p, description: e.target.value }))} placeholder="What this folder contains" />
            <ModalFooter onCancel={() => setShowNewFolder(false)} onSave={createFolder} saving={saving} saveLabel="Create Folder" disabled={!folderForm.name.trim()} />
          </Modal>
        )}
      </div>
    );
  }

  // ── Folder detail view (agent-page style) ─────────────────────────────────
  return (
    <div className="fade-up min-h-screen">

      {/* Top bar */}
      <div className="shrink-0 border-b border-border px-10 pt-7">
        {/* Breadcrumb */}
        <div className="mb-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <button onClick={() => setSelected(null)} className="cursor-pointer border-none bg-none p-0 text-xs text-muted-foreground">Knowledge Library</button>
          <span className="text-muted-foreground">/</span>
          <span className="text-foreground">{selected.name}</span>
        </div>

        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="m-0 text-lg font-semibold tracking-tight text-foreground">{selected.name}</h1>
            {selected.description && <p className="mt-1 text-sm text-muted-foreground">{selected.description}</p>}
            <div className="mt-1 text-2xs text-muted-foreground">Owner: <span className="font-medium text-muted-foreground">{selected.createdBy}</span></div>
          </div>
          {canManageSelected && (
            <div className="flex shrink-0 items-center gap-2">
              {/* Edit icon */}
              <button
                title="Edit folder"
                onClick={() => { setFolderForm({ name: selected.name, description: selected.description ?? '' }); setEditingFolder(selected); }}
                disabled={folderIsBuilding}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Pencil size={14} />
              </button>

              {/* Build Wiki split button */}
              <div className="relative">
                <div className="flex overflow-hidden rounded-md">
                  <Button
                    onClick={() => buildFolder(false)}
                    disabled={folderIsBuilding}
                    className="rounded-none border-r border-white/20"
                  >
                    {folderIsBuilding ? 'Building…' : 'Build Wiki'}
                  </Button>
                  <Button
                    onClick={() => setShowBuildDropdown(v => !v)}
                    disabled={folderIsBuilding}
                    className="rounded-none px-2.5"
                  >
                    <ChevronDown size={14} />
                  </Button>
                </div>
                {showBuildDropdown && !folderIsBuilding && (
                  <div className="absolute right-0 top-full z-[100] mt-1 min-w-[200px] overflow-hidden rounded-md border border-border bg-card shadow-md">
                    <button onClick={() => buildFolder(false)} className="block w-full cursor-pointer border-none bg-none px-4 py-2.5 text-left text-sm text-foreground hover:bg-secondary">
                      Build pending / stale
                    </button>
                    <button onClick={() => buildFolder(true)} className="block w-full cursor-pointer border-none bg-none px-4 py-2.5 text-left text-sm text-red hover:bg-secondary">
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
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-red disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex gap-0 overflow-x-auto">
          {(['sources', 'wiki'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => switchTab(tab)}
              className={cn(
                'cursor-pointer border-none bg-none px-3.5 py-2.5 font-sans text-sm transition-colors',
                detailTab === tab ? 'tab-active font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
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
      <div className="px-10 py-7">

        {/* ── Sources tab ── */}
        {detailTab === 'sources' && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Knowledge Sources</div>
              {canManageSelected && <Button variant="outline" size="sm" onClick={openAddSource}>+ Add Source</Button>}
            </div>
            {sourcesLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : sources.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                {canManageSelected ? 'No sources yet. Add a URL, file, or Git repo, then click Build Wiki.' : 'No sources added yet.'}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {sources.map(s => {
                  const isSyncing = syncStatus[s.id] === 'building' || s.status === 'building';
                  const disabled = folderIsBuilding;
                  const iconBtnClass = cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-secondary',
                    disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
                  );
                  return (
                    <div key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-3 shadow-sm">
                      {/* Left: info */}
                      <div className="min-w-0 flex-1">
                        {/* Row 1: type icon + name */}
                        <div className="mb-1 flex items-center gap-1.5">
                          <span className="flex shrink-0 text-muted-foreground">{SOURCE_TYPE_ICON[s.type]}</span>
                          <span className="overflow-hidden truncate whitespace-nowrap text-sm font-semibold text-foreground">{s.name}</span>
                        </div>
                        {/* Row 2: url/path */}
                        <div className="mb-1.5 overflow-hidden truncate whitespace-nowrap font-mono text-2xs text-muted-foreground">
                          {s.url || s.repoUrl || (s.content ? `${s.content.slice(0, 80)}…` : '—')}
                        </div>
                        {/* Row 3: status dot + word count + last synced */}
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="flex items-center gap-1.5">
                            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[s.status] ?? '#a3a3a3' }} />
                            <span className="text-2xs font-medium" style={{ color: STATUS_COLOR[s.status] ?? '#a3a3a3' }}>{s.status}</span>
                          </span>
                          {s.wordCount > 0 && (
                            <span className="text-2xs text-muted-foreground">{s.wordCount.toLocaleString()} words</span>
                          )}
                          {s.lastSynced && (
                            <span className="text-2xs text-muted-foreground">synced {timeAgo(s.lastSynced)}</span>
                          )}
                        </div>
                      </div>
                      {/* Right: icon actions */}
                      {canManageSelected && (
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            title={isSyncing ? 'Syncing…' : 'Sync source'}
                            onClick={() => !isSyncing && !disabled && syncSource(s.id)}
                            disabled={disabled}
                            className={iconBtnClass}
                            style={{ color: isSyncing ? STATUS_COLOR.building : undefined }}
                          >
                            <RefreshCw size={13} className={cn(isSyncing && 'animate-spin')} />
                          </button>
                          <button
                            title="Edit source"
                            onClick={() => openEditSource(s)}
                            disabled={disabled}
                            className={cn(iconBtnClass, 'text-muted-foreground')}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            title="Delete source"
                            onClick={() => deleteSource(s.id, s.name)}
                            disabled={disabled}
                            className={cn(iconBtnClass, 'text-red')}
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
          wikiLoading ? <div className="text-sm text-muted-foreground">Loading…</div>
          : wikiPages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              No wiki pages built yet.{canManageSelected && ' Add sources then click Build Wiki.'}
            </div>
          ) : (
            <div>
              <div className="mb-3 flex items-center gap-1.5">
                <BookOpen size={14} className="text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground">Wiki</span>
                <span className="text-xs text-muted-foreground">{wikiPages.length} articles</span>
              </div>
              <div className="flex h-[480px] gap-3.5">
                {/* Sidebar — file tree */}
                <div className="flex w-[220px] shrink-0 flex-col overflow-auto rounded-lg border border-border bg-card">
                  <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
                    <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Articles</span>
                    <span className="text-2xs text-muted-foreground">{wikiPages.length}</span>
                  </div>
                  <WikiTree articles={wikiPages} onSelect={viewArticle} selected={selectedArticle} />
                </div>

                {/* Main — article content */}
                <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
                  {selectedArticle ? (
                    <>
                      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2.5">
                        <FileText size={13} className="text-muted-foreground" />
                        <span className="font-mono text-xs font-medium text-foreground">{selectedArticle}</span>
                      </div>
                      <div className="flex-1 overflow-auto px-4 py-4">
                        {loadingArticle ? (
                          <div className="text-xs text-muted-foreground">Loading…</div>
                        ) : (
                          <pre className="m-0 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground">{articleContent}</pre>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2">
                      <BookOpen size={28} className="text-muted-foreground" />
                      <p className="m-0 text-sm text-muted-foreground">Select an article to view</p>
                      <p className="m-0 text-2xs text-muted-foreground">Browse the folder tree on the left</p>
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
          <label className={labelClass}>Name</label>
          <input className={inputClass} autoFocus value={folderForm.name} onChange={e => setFolderForm(p => ({ ...p, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && saveEditFolder()} />
          <label className={labelClass}>Description</label>
          <input className={inputClass} value={folderForm.description} onChange={e => setFolderForm(p => ({ ...p, description: e.target.value }))} placeholder="What this folder contains" />
          <ModalFooter onCancel={() => setEditingFolder(null)} onSave={saveEditFolder} saving={saving} saveLabel="Save" disabled={!folderForm.name.trim()} />
        </Modal>
      )}

      {/* ── Add / Edit Source Modal ── */}
      {showSourceModal && (
        <Modal title={editingSource ? 'Edit Source' : 'Add Source'} onClose={() => { setShowSourceModal(false); setEditingSource(null); }}>
          <label className={labelClass}>Type</label>
          <select className={inputClass} value={sourceForm.type} onChange={e => setSourceForm(p => ({ ...p, type: e.target.value }))} disabled={!!editingSource}>
            <option value="url">URL</option>
            <option value="file">File</option>
            <option value="repo">Git Repository</option>
          </select>
          <label className={labelClass}>Name</label>
          <input className={inputClass} autoFocus value={sourceForm.name} onChange={e => setSourceForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. API Reference" />

          {sourceForm.type === 'url' && (
            <>
              <label className={labelClass}>URL</label>
              <input className={inputClass} value={sourceForm.url} onChange={e => setSourceForm(p => ({ ...p, url: e.target.value }))} placeholder="https://docs.example.com" />
            </>
          )}

          {sourceForm.type === 'file' && (
            <>
              <label className={labelClass}>Content</label>
              <div className="mb-1.5 flex items-center gap-2">
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={fileUploading} className="shrink-0 cursor-pointer rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-foreground">
                  {fileUploading ? 'Reading…' : 'Upload file'}
                </button>
                <span className="text-2xs text-muted-foreground">
                  {sourceForm.content ? `${sourceForm.content.length.toLocaleString()} chars` : 'or paste below'}
                </span>
              </div>
              <input ref={fileInputRef} type="file" accept=".txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.rst,.ts,.js,.py,.go,.rb,.java,.c,.cpp,.h,.pdf" className="hidden" onChange={handleFileSelect} />
              <textarea className={cn(inputClass, 'min-h-[140px] resize-y font-mono text-xs')} value={sourceForm.content} onChange={e => setSourceForm(p => ({ ...p, content: e.target.value }))} placeholder="Paste content here, or upload a file above…" />
            </>
          )}

          {sourceForm.type === 'repo' && (
            <>
              <label className={labelClass}>Repository URL</label>
              <input className={inputClass} value={sourceForm.repoUrl} onChange={e => setSourceForm(p => ({ ...p, repoUrl: e.target.value }))} placeholder="https://github.com/org/repo" />
              <label className={labelClass}>Branch</label>
              <input className={inputClass} value={sourceForm.branch} onChange={e => setSourceForm(p => ({ ...p, branch: e.target.value }))} placeholder="main" />
              <label className={labelClass}>PAT env var (private repos only)</label>
              <select className={inputClass} value={sourceForm.patEnvRef} onChange={e => setSourceForm(p => ({ ...p, patEnvRef: e.target.value }))}>
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
    <div className="mx-10 mt-4 rounded-lg border border-blue/20 bg-blue/[0.07] px-4 py-3.5 text-sm">
      {/* Top row: what's happening */}
      <div className="mb-2.5 flex items-center gap-2.5">
        <span className="inline-block h-2 w-2 rounded-full bg-blue" style={{ animation: 'pulse 1.5s ease-in-out infinite' }} />
        <span className="font-medium text-foreground">
          {progress?.sourceName
            ? `Building wiki for ${progress.sourceName}`
            : (progress?.step ?? 'Building…')}
        </span>
        {elapsed && <span className="ml-auto text-xs text-muted-foreground">Elapsed: {elapsed}</span>}
      </div>

      {/* Source progress bar */}
      {sourcesTotal > 1 && (
        <div className="mb-2">
          <div className="mb-1 flex justify-between text-2xs text-muted-foreground">
            <span>Source {sourceIdx + 1} of {sourcesTotal}</span>
            {eta && <span>ETA {eta}</span>}
          </div>
          <div className="h-1 overflow-hidden rounded bg-border">
            <div className="h-full rounded bg-blue transition-[width] duration-500" style={{ width: `${sourcePct}%` }} />
          </div>
        </div>
      )}

      {/* Chunk progress */}
      {chunksTotal > 1 && (
        <div className="mb-2">
          <div className="mb-1 flex justify-between text-2xs text-muted-foreground">
            <span>Chunk {chunkIdx + 1} of {chunksTotal} {chunkElapsed ? `(${chunkElapsed} on this chunk)` : ''}</span>
            <span className="font-mono text-2xs">
              Each chunk ≈ 100k chars of source code
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded bg-border">
            <div className="h-full rounded bg-blue/50 transition-[width] duration-500" style={{ width: `${Math.round(((chunkIdx) / chunksTotal) * 100)}%` }} />
          </div>
        </div>
      )}

      {/* Detail step */}
      {progress?.step && (
        <div className="font-mono text-2xs text-muted-foreground">
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
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="max-h-[90vh] w-[460px] max-w-[92vw] overflow-y-auto rounded-xl border border-border bg-card px-7 pb-6 pt-7 shadow-lg">
        <div className="mb-5 text-md font-bold text-foreground">{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ModalFooter({ onCancel, onSave, saving, saveLabel, disabled }: { onCancel: () => void; onSave: () => void; saving: boolean; saveLabel: string; disabled?: boolean }) {
  return (
    <div className="mt-5 flex justify-end gap-2">
      <Button variant="outline" onClick={onCancel}>Cancel</Button>
      <Button onClick={onSave} disabled={saving || disabled}>{saving ? 'Saving…' : saveLabel}</Button>
    </div>
  );
}

const labelClass = 'mb-1.5 mt-3.5 block text-xs font-semibold text-muted-foreground';
const inputClass = 'box-border w-full rounded-md border border-input bg-secondary px-2.5 py-2 text-sm text-foreground outline-none';
