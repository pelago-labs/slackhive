'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ChevronDown, ChevronRight, FileText, BookOpen, Globe, GitBranch, Pencil, Trash2, RefreshCw, Search, Layers3, FileStack, Clock3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { MetricCard } from '@/components/patterns';

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
          className="flex cursor-pointer items-center gap-1 rounded-md pb-0.5 pt-1.5 font-mono text-2xs tracking-[0.02em] text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
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
        'flex cursor-pointer items-center gap-1 overflow-hidden truncate whitespace-nowrap rounded-md py-1.5 pr-2 font-mono text-xs transition-colors',
        isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
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
    <div className="flex-1 overflow-auto p-2">
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

function LibraryStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }): React.JSX.Element {
  return <MetricCard icon={icon} label={label} value={value} className="p-3" />;
}

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
  const [folderSearch, setFolderSearch]           = useState('');

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
  const visibleFolders = folders.filter(f => {
    const q = folderSearch.trim().toLowerCase();
    return !q || f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q) || f.createdBy.toLowerCase().includes(q);
  });
  const libraryStats = folders.reduce((acc, f) => {
    const st = folderStats[f.id];
    acc.sources += st?.sources ?? 0;
    acc.words += st?.words ?? 0;
    if (st?.lastSynced && (!acc.lastSynced || st.lastSynced > acc.lastSynced)) acc.lastSynced = st.lastSynced;
    return acc;
  }, { sources: 0, words: 0, lastSynced: null as string | null });

  // ── Folder list view ──────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div className="fade-up min-h-screen">
        {/* Header */}
        <div className="border-b border-border bg-background/80 px-6 py-6">
          <div>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="m-0 text-xl font-semibold tracking-normal text-foreground">Knowledge Library</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {loading ? 'Loading…' : `${folders.length} shared wiki folder${folders.length !== 1 ? 's' : ''} for agent context and retrieval.`}
                </p>
              </div>
              {canEdit && (
                <Button onClick={() => { setFolderForm({ name: '', description: '' }); setShowNewFolder(true); }}>
                  + New Folder
                </Button>
              )}
            </div>

            {!loading && folders.length > 0 && (
              <div className="mt-5 grid gap-3 md:grid-cols-3">
                <LibraryStat icon={<Layers3 size={15} />} label="Folders" value={folders.length.toLocaleString()} />
                <LibraryStat icon={<FileStack size={15} />} label="Sources" value={libraryStats.sources.toLocaleString()} />
                <LibraryStat icon={<Clock3 size={15} />} label="Last sync" value={libraryStats.lastSynced ? timeAgo(libraryStats.lastSynced) : 'No syncs'} />
              </div>
            )}
          </div>
        </div>

        {/* Folder grid */}
        <div className="px-6 py-6">
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
            <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="relative min-w-[260px] max-w-[420px] flex-1">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={folderSearch}
                  onChange={e => setFolderSearch(e.target.value)}
                  placeholder="Search folders..."
                  className="pl-9"
                />
              </div>
              <div className="text-xs text-muted-foreground">{visibleFolders.length} visible</div>
            </div>
            <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
              {visibleFolders.map(f => (
                <div
                  key={f.id}
                  onClick={() => openFolder(f)}
                  className="fade-up group cursor-pointer rounded-xl border border-border bg-card p-4 shadow-card transition-[border-color,box-shadow,background-color] hover:border-ring/35 hover:bg-secondary/30 hover:shadow-md"
                >
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground">
                      <BookOpen size={17} />
                    </div>
                    {folderStats[f.id] && (
                      <span className="rounded-md border border-border bg-secondary px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                        {folderStats[f.id].sources} source{folderStats[f.id].sources !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <div className="mb-1 text-sm font-semibold tracking-normal text-foreground">{f.name}</div>
                  <p className="m-0 mb-4 line-clamp-2 min-h-[36px] overflow-hidden text-xs leading-relaxed text-muted-foreground">
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
            {visibleFolders.length === 0 && (
              <div className="rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
                No folders match your search.
              </div>
            )}
            </>
          )}
        </div>

        {/* Modals */}
        {showNewFolder && (
          <Modal title="New Knowledge Folder" onClose={() => setShowNewFolder(false)}>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="folder-name">Name</Label>
                <Input id="folder-name" autoFocus value={folderForm.name} onChange={e => setFolderForm(p => ({ ...p, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && createFolder()} placeholder="e.g. Backend API Docs" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="folder-description">Description</Label>
                <Input id="folder-description" value={folderForm.description} onChange={e => setFolderForm(p => ({ ...p, description: e.target.value }))} placeholder="What this folder contains" />
              </div>
            </div>
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
      <div className="shrink-0 border-b border-border bg-background/80 px-6 pt-6">
        <div>
        {/* Breadcrumb */}
        <div className="mb-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <button onClick={() => setSelected(null)} className="cursor-pointer border-none bg-none p-0 text-xs text-muted-foreground">Knowledge Library</button>
          <span className="text-muted-foreground">/</span>
          <span className="text-foreground">{selected.name}</span>
        </div>

        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="m-0 text-xl font-semibold tracking-normal text-foreground">{selected.name}</h1>
            {selected.description && <p className="mt-1 text-sm text-muted-foreground">{selected.description}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
              <span>Owner: <span className="font-medium text-foreground">{selected.createdBy}</span></span>
              <span className="text-border">·</span>
              <span>{sources.length} source{sources.length === 1 ? '' : 's'}</span>
              <span className="text-border">·</span>
              <span>{wikiPages.length} article{wikiPages.length === 1 ? '' : 's'}</span>
            </div>
          </div>
          {canManageSelected && (
            <div className="flex shrink-0 items-center gap-2">
              {/* Edit icon */}
              <button
                title="Edit folder"
                onClick={() => { setFolderForm({ name: selected.name, description: selected.description ?? '' }); setEditingFolder(selected); }}
                disabled={folderIsBuilding}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
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
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-red hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex gap-0">
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
      </div>

      {/* Build progress panel */}
      {folderIsBuilding && selected && (
        <BuildProgressPanel progress={buildProgress[selected.id]} />
      )}

      {/* Tab content */}
      <div className="px-6 py-6">

        {/* ── Sources tab ── */}
        {detailTab === 'sources' && (
          <>
            <section className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-secondary/45 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                  <FileStack size={15} />
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    Knowledge sources
                    <span className="rounded-md border border-border bg-card px-1.5 py-px text-2xs font-medium text-muted-foreground">{sources.length}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">Raw inputs compiled into this folder&apos;s generated wiki.</p>
                </div>
              </div>
              {canManageSelected && <Button variant="outline" size="sm" onClick={openAddSource}>+ Add Source</Button>}
            </div>
            {sourcesLoading ? (
              <div className="px-4 py-8 text-sm text-muted-foreground">Loading…</div>
            ) : sources.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                {canManageSelected ? 'No sources yet. Add a URL, file, or Git repo, then click Build Wiki.' : 'No sources added yet.'}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {sources.map(s => {
                  const isSyncing = syncStatus[s.id] === 'building' || s.status === 'building';
                  const disabled = folderIsBuilding;
                  const iconBtnClass = cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground',
                    disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-secondary hover:text-foreground',
                  );
                  return (
                    <div key={s.id} className="grid gap-3 px-4 py-3.5 transition-colors hover:bg-secondary/35 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                      {/* Left: info */}
                      <div className="min-w-0">
                        {/* Row 1: type icon + name */}
                        <div className="mb-1 flex items-center gap-2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground">{SOURCE_TYPE_ICON[s.type]}</span>
                          <span className="overflow-hidden truncate whitespace-nowrap text-sm font-semibold text-foreground">{s.name}</span>
                          <span className="rounded-md border border-border bg-secondary px-1.5 py-px font-mono text-2xs font-semibold uppercase text-muted-foreground">{s.type}</span>
                        </div>
                        {/* Row 2: url/path */}
                        <div className="mb-1.5 max-w-[700px] overflow-hidden truncate whitespace-nowrap font-mono text-2xs text-muted-foreground">
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
                        <div className="flex shrink-0 items-center justify-end gap-1.5">
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
            </section>
          </>
        )}

        {/* ── Built Wiki tab ── */}
        {detailTab === 'wiki' && (
          wikiLoading ? <div className="text-sm text-muted-foreground">Loading…</div>
          : wikiPages.length === 0 ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground shadow-card">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground">
                <BookOpen size={20} />
              </div>
              <p className="m-0 text-sm font-semibold text-foreground">No wiki pages built yet</p>
              <p className="m-0 mt-1 text-xs text-muted-foreground">{canManageSelected ? 'Add sources, then build the wiki to generate articles.' : 'This folder has not been built yet.'}</p>
            </div>
          ) : (
            <section className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
              <div className="flex items-center justify-between border-b border-border bg-secondary/45 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                    <BookOpen size={15} />
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-foreground">Built wiki</div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{wikiPages.length} generated article{wikiPages.length === 1 ? '' : 's'}</p>
                  </div>
                </div>
              </div>
              <div className="grid min-h-[560px] md:grid-cols-[280px_minmax(0,1fr)]">
                {/* Sidebar — file tree */}
                <div className="flex min-h-[320px] flex-col overflow-hidden border-b border-border bg-card md:border-b-0 md:border-r">
                  <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
                    <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Articles</span>
                    <span className="text-2xs text-muted-foreground">{wikiPages.length}</span>
                  </div>
                  <WikiTree articles={wikiPages} onSelect={viewArticle} selected={selectedArticle} />
                </div>

                {/* Main — article content */}
                <div className="flex min-w-0 flex-col overflow-hidden bg-card">
                  {selectedArticle ? (
                    <>
                      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
                        <FileText size={13} className="text-muted-foreground" />
                        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs font-medium text-foreground">{selectedArticle}</span>
                      </div>
                      <div className="flex-1 overflow-auto px-6 py-5">
                        {loadingArticle ? (
                          <div className="text-xs text-muted-foreground">Loading…</div>
                        ) : (
                          <pre className="m-0 max-w-[820px] whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">{articleContent}</pre>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground">
                        <BookOpen size={24} />
                      </div>
                      <p className="m-0 text-sm font-semibold text-foreground">Select an article</p>
                      <p className="m-0 max-w-[260px] text-xs text-muted-foreground">Choose a generated page from the article tree to inspect the compiled knowledge.</p>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )
        )}
      </div>

      {/* ── Edit Folder Modal ── */}
      {editingFolder && (
        <Modal title="Edit Folder" onClose={() => setEditingFolder(null)}>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-folder-name">Name</Label>
              <Input id="edit-folder-name" autoFocus value={folderForm.name} onChange={e => setFolderForm(p => ({ ...p, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && saveEditFolder()} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-folder-description">Description</Label>
              <Input id="edit-folder-description" value={folderForm.description} onChange={e => setFolderForm(p => ({ ...p, description: e.target.value }))} placeholder="What this folder contains" />
            </div>
          </div>
          <ModalFooter onCancel={() => setEditingFolder(null)} onSave={saveEditFolder} saving={saving} saveLabel="Save" disabled={!folderForm.name.trim()} />
        </Modal>
      )}

      {/* ── Add / Edit Source Modal ── */}
      {showSourceModal && (
        <Modal title={editingSource ? 'Edit source' : 'Add source'} subtitle={editingSource ? 'Update this source metadata or content. Source type cannot be changed after creation.' : 'Add a URL, file, or repository for the wiki builder to compile.'} onClose={() => { setShowSourceModal(false); setEditingSource(null); }}>
          <div className="mb-5 grid grid-cols-3 gap-2 rounded-lg border border-border bg-secondary p-1">
            {([
              { id: 'url', label: 'URL', icon: <Globe size={14} /> },
              { id: 'file', label: 'File', icon: <FileText size={14} /> },
              { id: 'repo', label: 'Repo', icon: <GitBranch size={14} /> },
            ] as const).map(t => {
              const active = sourceForm.type === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={!!editingSource}
                  onClick={() => setSourceForm(p => ({ ...p, type: t.id }))}
                  className={cn(
                    'inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors',
                    active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    editingSource && !active && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {t.icon}{t.label}
                </button>
              );
            })}
          </div>

          <FormBlock title="Identity" description="Use a short, scannable name. This appears in source lists and build progress.">
            <div className="space-y-1.5 pt-3">
              <Label htmlFor="source-name">Name</Label>
              <Input id="source-name" autoFocus value={sourceForm.name} onChange={e => setSourceForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. API Reference" />
            </div>
          </FormBlock>

          {sourceForm.type === 'url' && (
            <FormBlock title="Web page" description="Use a public page or documentation URL. The builder will fetch and summarize the content.">
              <div className="space-y-1.5 pt-3">
                <Label htmlFor="source-url">URL</Label>
                <Input id="source-url" value={sourceForm.url} onChange={e => setSourceForm(p => ({ ...p, url: e.target.value }))} placeholder="https://docs.example.com" />
              </div>
            </FormBlock>
          )}

          {sourceForm.type === 'file' && (
            <FormBlock title="File content" description="Upload a readable text/PDF file or paste source content directly.">
              <div className="space-y-1.5 pt-3">
                <Label htmlFor="source-content">Content</Label>
                <div className="mb-2 rounded-lg border border-dashed border-border bg-secondary px-3 py-3">
                  <button type="button" onClick={() => fileInputRef.current?.click()} disabled={fileUploading} className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-secondary">
                    <FileText size={13} />
                    {fileUploading ? 'Reading…' : 'Choose file'}
                  </button>
                  <span className="ml-2 text-2xs text-muted-foreground">
                    {sourceForm.content ? `${sourceForm.content.length.toLocaleString()} chars` : 'or paste below'}
                  </span>
                </div>
                <input ref={fileInputRef} type="file" accept=".txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.rst,.ts,.js,.py,.go,.rb,.java,.c,.cpp,.h,.pdf" className="hidden" onChange={handleFileSelect} />
                <Textarea id="source-content" className="min-h-[180px] resize-y font-mono text-xs leading-5" value={sourceForm.content} onChange={e => setSourceForm(p => ({ ...p, content: e.target.value }))} placeholder="Paste content here, or upload a file above…" />
              </div>
            </FormBlock>
          )}

          {sourceForm.type === 'repo' && (
            <FormBlock title="Git repository" description="Point to a public repo, or choose a PAT env var for private repositories.">
              <div className="space-y-1.5 pt-3">
                <Label htmlFor="source-repo-url">Repository URL</Label>
                <Input id="source-repo-url" value={sourceForm.repoUrl} onChange={e => setSourceForm(p => ({ ...p, repoUrl: e.target.value }))} placeholder="https://github.com/org/repo" />
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1.5fr]">
                <div className="space-y-1.5">
                  <Label htmlFor="source-branch">Branch</Label>
                  <Input id="source-branch" value={sourceForm.branch} onChange={e => setSourceForm(p => ({ ...p, branch: e.target.value }))} placeholder="main" />
                </div>
                <div className="space-y-1.5">
                  <Label>PAT env var</Label>
                  <Select value={sourceForm.patEnvRef || '__none__'} onValueChange={value => setSourceForm(p => ({ ...p, patEnvRef: value === '__none__' ? '' : value }))}>
                    <SelectTrigger>
                      <SelectValue placeholder="Public repo" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None (public repo)</SelectItem>
                      {envVarKeys.map(k => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                      {envVarKeys.length === 0 && <SelectItem value="__empty__" disabled>No accessible env vars</SelectItem>}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </FormBlock>
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

function FormBlock({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-lg border border-border bg-card">
      <div className="border-b border-border bg-secondary/45 px-3.5 py-3">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {description && <p className="m-0 mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>}
      </div>
      <div className="px-3.5 pb-3.5 pt-1">{children}</div>
    </section>
  );
}

function Modal({ title, subtitle, children, onClose }: { title: string; subtitle?: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-[560px] overflow-y-auto p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
          {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
        </DialogHeader>
        <div className="px-5 py-5">
        {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModalFooter({ onCancel, onSave, saving, saveLabel, disabled }: { onCancel: () => void; onSave: () => void; saving: boolean; saveLabel: string; disabled?: boolean }) {
  return (
    <DialogFooter className="sticky bottom-0 -mx-5 -mb-5 mt-5 border-t border-border bg-background px-5 py-4">
      <Button variant="outline" onClick={onCancel}>Cancel</Button>
      <Button onClick={onSave} disabled={saving || disabled}>{saving ? 'Saving…' : saveLabel}</Button>
    </DialogFooter>
  );
}
