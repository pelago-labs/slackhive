'use client';

/**
 * @fileoverview Agent detail page — tabbed control panel.
 *
 * Tabs: Overview · Skills · MCPs · Permissions · Memory · Logs
 *
 * Route: /agents/[slug]
 * @module web/app/agents/[slug]
 */

import React, { useEffect, useState, useRef, use, useMemo } from 'react';
import { Brain, Camera, Clock, History, Upload, Download, Wand2, Loader2, Link2, FileText, GitBranch, BookOpen, ChevronRight, ChevronDown, ArrowLeft, Folder, FolderOpen, Library, X, Search, Code2, Database, Layers, Briefcase, Sparkles, MessageSquare, Activity as ActivityIcon, Home, Wrench, Users, Settings as SettingsIcon, Calendar, UserCircle, ArrowRight, RotateCcw, Square, Terminal, Globe, Radio, Plus, ExternalLink, Plug, Check, Pencil, Minus, Copy, MoreHorizontal, Trash2, Slack, ThumbsUp, ThumbsDown, ShieldCheck, AlertTriangle, Info, ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Agent, Skill, McpServer, Memory, Permission, Restriction, AgentSnapshot, AgentFeedbackReport, FeedbackRating } from '@slackhive/shared';
import { PERSONA_CATALOG, searchPersonas } from '@slackhive/shared/personas';
import type { PersonaTemplate, PersonaCategory } from '@slackhive/shared';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Portal } from '@/lib/portal';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth-context';
import { FilesChanged, type FileChange } from './diff-view';
import { CoachPanel } from './coach-panel';
import { TestPanel } from './test-panel';
import { EvalsPanel } from './evals-panel';
import { AudiencesPanel } from './audiences-panel';

type Tab = 'overview' | 'instructions' | 'tools' | 'knowledge' | 'audiences' | 'settings';
type SettingsSection = 'general' | 'slack' | 'evals' | 'feedback' | 'logs' | 'history' | 'danger';

interface AgentExportPayload {
  version: number;
  exportedAt?: string;
  name?: string;
  persona?: string;
  description?: string;
  claudeMd?: string;
  skills?: { category: string; filename: string; content: string; sortOrder: number }[];
  memories?: { type: string; name: string; content: string }[];
}

/**
 * A meaningful (non-empty, trimmed string) identity value, else undefined.
 * Guards persona/description import-export: never export blank values and never
 * apply a non-string or empty value that would silently overwrite a real one.
 */
function meaningfulStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Format a date for agent panels. Accepts a Date, an ISO string, or SQLite's
 *  `YYYY-MM-DD HH:MM:SS` (UTC, no tz) — normalizing the latter so it isn't parsed
 *  as local time. Single helper so the Overview + Feedback panels agree. */
function fmtAgentDate(d: Date | string | undefined): string {
  if (!d) return '—';
  const iso = typeof d === 'string' && d.includes(' ') && !d.includes('T') ? `${d.replace(' ', 'T')}Z` : d;
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Single source of truth for the satisfaction-score → rating mapping (label +
 *  status color). Used by the Overview satisfaction card + Settings panel. */
function feedbackTier(score: number, has: boolean): { label: string; color: string } {
  if (!has)        return { label: 'No ratings yet', color: 'var(--muted)' };
  if (score >= 90) return { label: 'Excellent',      color: '#16a34a' };
  if (score >= 75) return { label: 'Very good',      color: '#16a34a' };
  if (score >= 60) return { label: 'Good',           color: '#d97706' };
  if (score >= 40) return { label: 'OK',             color: '#d97706' };
  return                  { label: 'Needs work',     color: '#dc2626' };
}

/** Maps a Tier-1 healthcheck summary → a status label/color/icon for the
 *  Overview Evals card. Restrained palette (status colors only). */
function evalTier(summary: { total: number; errors: number; warnings: number } | null): {
  label: string; color: string; Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
} {
  if (!summary)            return { label: 'Not run yet', color: 'var(--muted)', Icon: ShieldCheck };
  if (summary.errors > 0)  return { label: `${summary.errors} issue${summary.errors !== 1 ? 's' : ''}`, color: '#dc2626', Icon: AlertTriangle };
  if (summary.warnings > 0) return { label: `${summary.warnings} warning${summary.warnings !== 1 ? 's' : ''}`, color: '#d97706', Icon: AlertTriangle };
  return                   { label: 'Healthy', color: '#16a34a', Icon: ShieldCheck };
}

const TABS: { id: Tab; label: string; Icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'overview',      label: 'Overview',     Icon: Home },
  { id: 'instructions',  label: 'Instructions', Icon: FileText },
  { id: 'tools',         label: 'Tools',        Icon: Wrench },
  { id: 'knowledge',     label: 'Wiki',         Icon: BookOpen },
  { id: 'audiences',     label: 'Audiences',    Icon: Users },
  { id: 'settings',      label: 'Settings',     Icon: SettingsIcon },
];

const STATUS_COLOR = {
  running: '#16a34a',
  stopped: 'var(--border-2)',
  error: '#ef4444',
  stale: '#f59e0b',
} as const;

// ─── Page ─────────────────────────────────────────────────────────────────────

// Minimalist deterministic avatar palette — soft pastel bg + darker fg letter.
// Mirrors the palette used on the dashboard (apps/web/src/app/page.tsx).
const AVATAR_PALETTES: { bg: string; fg: string }[] = [
  { bg: '#fef3c7', fg: '#92400e' }, { bg: '#fce7f3', fg: '#9d174d' },
  { bg: '#ede9fe', fg: '#5b21b6' }, { bg: '#dbeafe', fg: '#1e40af' },
  { bg: '#cffafe', fg: '#155e75' }, { bg: '#dcfce7', fg: '#166534' },
  { bg: '#ecfccb', fg: '#3f6212' }, { bg: '#fee2e2', fg: '#991b1b' },
  { bg: '#ffedd5', fg: '#9a3412' }, { bg: '#f3f4f6', fg: '#1f2937' },
];
function avatarPalette(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTES[Math.abs(h) % AVATAR_PALETTES.length];
}

/**
 * Agent detail page — loads the agent by slug then renders the tabbed UI.
 *
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export default function AgentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { role, canManageUsers, username } = useAuth();
  // Arriving from the new-agent wizard (?coach=open) lands on Overview as
  // usual, but arms the Coach to auto-open the first time the user opens the
  // Instructions tab. We don't pop the panel on Overview — users deserve to
  // see their new agent before we shove a chat in their face.
  // useSearchParams is hydration-safe (returns the same value on server + client).
  const coachArmedFromWizard = useSearchParams().get('coach') === 'open';
  // Arriving from the new-agent wizard (?setup=slack) opens Settings → Slack
  // directly, since connecting Slack is the next step that makes the agent live.
  const setupSlackFromWizard = useSearchParams().get('setup') === 'slack';
  const router = useRouter();
  const [coachOpen, setCoachOpen] = useState(false);
  const [pendingCoachOpen, setPendingCoachOpen] = useState(coachArmedFromWizard);
  // Each Ask-Coach click bumps this token; CoachPanel watches it and fires the
  // seed message once per change. Tokens (not message equality) drive resends
  // so identical seeds from two different rows still trigger.
  const [coachSeed, setCoachSeed] = useState<{ token: string; message: string } | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [avatarImgFailed, setAvatarImgFailed] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const [tab, setTab] = useState<Tab>(setupSlackFromWizard ? 'settings' : 'overview');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(setupSlackFromWizard ? 'slack' : 'general');
  /** Full-main-window mode swap. `test` replaces the agent header + tabs +
   *  tab content with <TestPanel>. The global SlackHive sidebar (rendered by
   *  layout-shell.tsx) remains visible — clicking it navigates away and
   *  naturally unmounts this page, resetting back to `normal` on next load. */
  const [mode, setMode] = useState<'normal' | 'test'>('normal');

  // Strip ?coach=open from the URL after the first render so refreshing
  // the page doesn't keep rearming the auto-open.
  useEffect(() => {
    if (!coachArmedFromWizard && !setupSlackFromWizard) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('coach');
    url.searchParams.delete('setup');
    window.history.replaceState({}, '', url.toString());
  }, [coachArmedFromWizard, setupSlackFromWizard]);

  // When the user navigates to Instructions and Coach is armed, pop it open
  // once, then disarm so subsequent Instructions visits stay quiet.
  useEffect(() => {
    if (tab === 'instructions' && pendingCoachOpen) {
      setCoachOpen(true);
      setPendingCoachOpen(false);
    }
  }, [tab, pendingCoachOpen]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');

  useEffect(() => {
    setCanEdit(false);
    setViewOnly(false);
    fetch('/api/agents')
      .then(r => r.json())
      .then((agents: Agent[]) => {
        setAllAgents(agents);
        const found = agents.find(a => a.slug === slug) ?? null;
        if (!found) {
          setAgent(null);
          return;
        }
        if (role === 'admin' || role === 'superadmin') {
          setCanEdit(true);
          setAgent(found);
          // Admins/superadmins can see Slack tokens — fetch detail endpoint
          fetch(`/api/agents/${found.id}`)
            .then(r => r.json())
            .then((detail: Agent) => setAgent(detail))
            .catch(() => {});
        } else if (role === 'editor' || role === 'viewer') {
          setAgent(found);
          fetch(`/api/agents/${found.id}/access`)
            .then(r => r.json())
            .then(data => {
              const canRead = data.canRead ?? false;
              if (!canRead) { router.push('/agents'); return; }
              const writable = data.canWrite ?? false;
              setCanEdit(writable);
              const readOnly = !writable;
              setViewOnly(readOnly);
              if (writable) {
                // Editors with write access can also see tokens — update in background
                fetch(`/api/agents/${found.id}`)
                  .then(r => r.json())
                  .then((detail: Agent) => setAgent(detail))
                  .catch(() => {});
              }
            });
        }
      })
      .finally(() => setLoading(false));
  }, [slug, role]);

  const triggerAction = async (action: 'start' | 'stop' | 'reload') => {
    if (!agent) return;
    setActionMsg(action === 'start' ? 'Starting…' : action === 'stop' ? 'Stopping…' : 'Reloading…');
    await fetch(`/api/agents/${agent.id}/${action}`, { method: 'POST' });
    const r = await fetch(`/api/agents/${agent.id}`);
    setAgent(await r.json());
    setActionMsg('Done');
    setTimeout(() => setActionMsg(''), 2000);
    window.dispatchEvent(new Event('slackhive:sidebar-refresh'));
  };

  if (loading) return <PageLoader />;
  if (!agent)  return <NotFound slug={slug} />;

  // Prefer the API-computed liveStatus (accounts for heartbeat staleness) over
  // the raw DB status. A green "running" dot with no recent heartbeat means
  // the owning runner crashed — surface that as an amber "stale" dot instead.
  const displayStatus = (agent.liveStatus ?? agent.status) as keyof typeof STATUS_COLOR;
  const statusColor = STATUS_COLOR[displayStatus] ?? 'var(--border-2)';
  const staleTooltip = displayStatus === 'stale'
    ? 'Status unconfirmed — no runner heartbeat in over 45s. The owning process may have crashed.'
    : undefined;

  // Test mode swap — renders only the TestPanel as the main window. The
  // global SlackHive sidebar (from layout-shell.tsx) stays visible; clicking
  // anything in it navigates away and unmounts this page (exiting test mode
  // implicitly). No tab state is touched, so hitting × returns to the same
  // tab the user was on.
  if (mode === 'test') {
    return (
      <div className="h-screen">
        <TestPanel
          agentId={agent.id}
          agentName={agent.name}
          onClose={() => setMode('normal')}
        />
      </div>
    );
  }

  return (
    <div className="fade-up min-h-screen">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-10 pt-7">
        <div>
          {/* Breadcrumb */}
          <div className="mb-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Link href="/" className="text-muted-foreground no-underline">Agents</Link>
            <span className="text-muted-foreground/60">/</span>
            <span className="text-foreground">{agent.name}</span>
          </div>

          {/* Agent name + status */}
          <div className="mb-4 flex items-center gap-3">
            {(() => {
              const palette = avatarPalette(agent.name);
              const showSlackImage = !!agent.slackBotImageUrl && !avatarImgFailed;
              return (
                <div
                  style={{ background: showSlackImage ? undefined : palette.bg, color: palette.fg }}
                  className={cn(
                    'flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border text-md font-bold',
                    showSlackImage && 'bg-muted',
                  )}
                >
                  {showSlackImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={agent.slackBotImageUrl}
                      alt={agent.name}
                      width={44}
                      height={44}
                      onError={() => setAvatarImgFailed(true)}
                      className="block h-full w-full rounded-full object-cover"
                    />
                  ) : (
                    agent.name.charAt(0).toUpperCase()
                  )}
                </div>
              );
            })()}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="m-0 text-lg font-semibold tracking-normal text-foreground">
                  {agent.name}
                </h1>
                {agent.isBoss && (
                  <span className="rounded border border-amber/25 bg-amber/15 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-amber">Boss</span>
                )}
                <span title={staleTooltip} style={{
                  background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
                  color: statusColor,
                  border: `1px solid color-mix(in srgb, ${statusColor} 28%, transparent)`,
                }} className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-semibold capitalize">
                  <span
                    className={cn('h-1.5 w-1.5 rounded-full', displayStatus === 'running' && 'status-running')}
                    style={{ background: statusColor }}
                  />
                  {displayStatus}
                </span>
              </div>
              <div className="mt-px font-mono text-2xs text-muted-foreground">
                {agent.slackBotHandle ? `@${agent.slackBotHandle} · ` : ''}{agent.model.replace('claude-', '').split('-20')[0]}
              </div>
              {agent.lastError && agent.status !== 'running' && (
                <div className="mt-1.5 max-w-[520px] break-words text-xs leading-snug text-red">
                  {agent.lastError}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 pb-4">
          {actionMsg && <span className="text-xs text-muted-foreground">{actionMsg}</span>}

          {!viewOnly && <HeaderBtn icon={<MessageSquare size={14} />} label="Test" onClick={() => setMode('test')}
            title="Test this agent — chat with it without connecting to Slack" />}

          {canEdit && agent.status === 'running' && (
            <>
              <div className="mx-1 h-[22px] w-px bg-border" />
              <HeaderBtn icon={<RotateCcw size={14} />} label="Reload" onClick={() => triggerAction('reload')} />
              <HeaderBtn icon={<Square size={13} />} label="Stop" tone="danger" onClick={() => triggerAction('stop')} />
            </>
          )}
          {canEdit && agent.status !== 'running' && (
            <>
              <div className="mx-1 h-[22px] w-px bg-border" />
              <HeaderBtn icon={<ActivityIcon size={14} />} label="Start" tone="success" onClick={() => triggerAction('start')} />
            </>
          )}
        </div>
      </div>

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div className="flex min-h-[48px] items-center justify-between gap-3 overflow-x-auto border-b border-border bg-card px-10">
        <div className="flex">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent px-4 py-3 text-sm transition-colors',
                tab === t.id ? 'tab-active font-medium text-foreground' : 'font-normal text-muted-foreground',
              )}
            >
              <t.Icon size={14} />
              {t.label}
            </button>
          ))}
        </div>

        {/* Instructions actions — only on the Instructions tab */}
        {tab === 'instructions' && canEdit && (
          <div className="flex shrink-0 items-center gap-1.5">
            <ActionBtn icon={<Download size={13} />} label="Export" onClick={() => window.dispatchEvent(new Event('instr:export'))} subtle />
            <ActionBtn icon={<Upload size={13} />} label="Import" onClick={() => window.dispatchEvent(new Event('instr:import'))} subtle />
            {!agent.isBoss && (
              <>
                <div className="mx-1 h-[22px] w-px bg-border" />
                <ActionBtn icon={<Wand2 size={13} />} label="Coach" onClick={() => setCoachOpen(true)} primary />
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Tab content ──────────────────────────────────────────────────── */}
      <div className="px-10 py-7">
        {tab === 'overview'      && <OverviewTab      agent={agent} onUpdate={setAgent} canEdit={canEdit} allAgents={allAgents} onConnectSlack={() => { setSettingsSection('slack'); setTab('settings'); }} onViewFeedback={() => { setSettingsSection('feedback'); setTab('settings'); }} onViewEvals={() => { setSettingsSection('evals'); setTab('settings'); }} />}
        {tab === 'instructions'  && <InstructionsTab  agent={agent} canEdit={canEdit} onAgentUpdate={setAgent} onOpenCoach={() => setCoachOpen(true)} />}
        {tab === 'tools'         && <ToolsTab          agentId={agent.id} canEdit={canEdit} canManageMcps={canManageUsers} currentUsername={username} />}
        {tab === 'knowledge'     && <KnowledgeTab      agentId={agent.id} agentSlug={agent.slug} canEdit={canEdit} />}
        {tab === 'audiences'     && <AudiencesPanel    agentId={agent.id} canEdit={canEdit} />}
        {tab === 'settings'      && <AgentSettingsTab  agent={agent} onUpdate={setAgent} canEdit={canEdit} viewOnly={viewOnly} allAgents={allAgents} role={role} username={username} section={settingsSection} onSection={setSettingsSection}
          onAskCoach={(message) => { setCoachSeed({ token: crypto.randomUUID(), message }); setCoachOpen(true); }}
          onOpenCoach={() => setCoachOpen(true)} />}
      </div>

      {/* Coach is a slide-over — rendered once at page level so it floats over
          any tab, not just Instructions. */}
      <CoachPanel
        agentId={agent.id}
        agentName={agent.name}
        open={coachOpen}
        onClose={() => setCoachOpen(false)}
        canEdit={canEdit && !agent.isBoss}
        seed={coachSeed}
      />
    </div>
  );
}

// ─── Overview ─────────────────────────────────────────────────────────────────

/** Compact metric tile (icon + value + label) for the Details card grid. */
/** Uppercase group label for the Details side panel. */
function MetaGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-0.5 text-2xs font-bold uppercase tracking-[0.07em] text-muted-foreground">{children}</div>
  );
}

/** Rendered-markdown view (GFM) for read-friendly previews of prompts/skills. */
const MD_VIEW: Record<string, (p: any) => React.ReactElement> = {
  h1: (p) => <h1 className="mb-1.5 mt-4 text-base font-bold text-foreground" {...p} />,
  h2: (p) => <h2 className="mb-1.5 mt-3 text-xs font-bold text-foreground" {...p} />,
  h3: (p) => <h3 className="mb-1.5 mt-3 text-2xs font-semibold text-foreground" {...p} />,
  p:  (p) => <p className="mb-2 leading-relaxed text-muted-foreground" {...p} />,
  ul: (p) => <ul className="mb-2.5 pl-5 leading-relaxed" {...p} />,
  ol: (p) => <ol className="mb-2.5 pl-5 leading-relaxed" {...p} />,
  li: (p) => <li className="my-0.5 text-muted-foreground" {...p} />,
  a:  (p) => <a className="text-blue underline" target="_blank" rel="noreferrer" {...p} />,
  code: ({ inline, children, ...rest }: any) => inline
    ? <code className="rounded bg-muted px-1 py-px font-mono text-xs" {...rest}>{children}</code>
    : <code className="font-mono text-xs" {...rest}>{children}</code>,
  pre: (p) => <pre className="mb-3 overflow-auto rounded-md border border-border bg-muted px-3.5 py-3 text-xs leading-relaxed" {...p} />,
  blockquote: (p) => <blockquote className="mb-2.5 border-l-[3px] border-border py-0.5 pl-3.5 text-muted-foreground" {...p} />,
  table: (p) => <table className="mb-3 w-full border-collapse text-xs" {...p} />,
  th: (p) => <th className="border border-border bg-muted px-2.5 py-1.5 text-left" {...p} />,
  td: (p) => <td className="border border-border px-2.5 py-1.5" {...p} />,
  hr: () => <hr className="my-3.5 border-none border-t border-border" />,
};
function MarkdownView({ children }: { children: string }) {
  return (
    <div className="break-words text-2xs text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_VIEW as never}>{children || '_Nothing here yet._'}</ReactMarkdown>
    </div>
  );
}

const PROMPT_MD_VIEW: Record<string, (p: any) => React.ReactElement> = {
  h1: (p) => <h1 className="mb-4 mt-0 text-2xl font-semibold leading-tight text-foreground" {...p} />,
  h2: (p) => <h2 className="mb-2.5 mt-8 text-base font-semibold leading-snug text-foreground" {...p} />,
  h3: (p) => <h3 className="mb-2 mt-5 text-sm font-semibold leading-snug text-foreground" {...p} />,
  p:  (p) => <p className="mb-4 leading-7 text-muted-foreground" {...p} />,
  ul: (p) => <ul className="mb-4 pl-6 leading-7" {...p} />,
  ol: (p) => <ol className="mb-4 pl-6 leading-7" {...p} />,
  li: (p) => <li className="my-1 text-muted-foreground" {...p} />,
  a:  (p) => <a className="text-primary underline" target="_blank" rel="noreferrer" {...p} />,
  strong: (p) => <strong className="font-semibold text-foreground" {...p} />,
  em: (p) => <em className="text-foreground" {...p} />,
  code: ({ inline, children, ...rest }: any) => inline
    ? <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground" {...rest}>{children}</code>
    : <code className="font-mono text-xs" {...rest}>{children}</code>,
  pre: (p) => <pre className="mb-5 overflow-auto rounded-md border border-border bg-muted px-4 py-3.5 text-xs leading-6" {...p} />,
  blockquote: (p) => <blockquote className="mb-4 border-l-[3px] border-border py-1 pl-4 text-muted-foreground" {...p} />,
  table: (p) => <table className="mb-5 w-full border-collapse text-xs" {...p} />,
  th: (p) => <th className="border border-border bg-muted px-2.5 py-1.5 text-left" {...p} />,
  td: (p) => <td className="border border-border px-2.5 py-1.5" {...p} />,
  hr: () => <hr className="my-6 border-none border-t border-border" />,
};
function PromptMarkdownView({ children }: { children: string }) {
  return (
    <div className="mx-auto max-w-[920px] break-words text-sm text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={PROMPT_MD_VIEW as never}>{children || '_Nothing here yet._'}</ReactMarkdown>
    </div>
  );
}

/** Card wrapper used across the Overview for a cohesive SaaS look. */
/** A small info icon that reveals a help tooltip on hover/focus. */
function InfoTip({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-label="More info" className="inline-flex cursor-help border-none bg-transparent p-0 text-muted-foreground">
        <Info size={13} />
      </button>
      {open && (
        <span className="absolute left-0 top-[calc(100%+6px)] z-30 w-80 rounded-md border border-border bg-popover px-3 py-2.5 text-2xs font-normal leading-relaxed tracking-normal text-muted-foreground shadow-lg">{children}</span>
      )}
    </span>
  );
}

function Card({ title, children, fill, grow, className }: { title?: string; children: React.ReactNode; fill?: boolean; grow?: boolean; className?: string }) {
  // `fill` stretches to the parent's height (e.g. a stretched flex column);
  // `grow` makes the card flex-grow to absorb leftover space in a flex column
  // so the last card's bottom lines up with a taller sibling column.
  const stretch = fill || grow;
  return (
    <div className={cn(
      'rounded-lg border border-border bg-card px-5 py-5 shadow-card',
      grow && 'min-h-0 flex-1',
      stretch && 'flex flex-col',
      fill && !grow && 'h-full',
      className,
    )}>
      {title && <div className="mb-4 flex items-center justify-between border-b border-border pb-3 text-sm font-semibold text-foreground">{title}</div>}
      <div className={cn('flex flex-col gap-3.5', stretch && 'flex-1')}>{children}</div>
    </div>
  );
}

/** A labeled metadata row for the Overview side panel. */
function MetaRow({ icon, label, children, mono }: { icon: React.ReactNode; label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span className="flex shrink-0 text-muted-foreground">{icon}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn(
        'ml-auto max-w-[170px] min-w-0 truncate text-right text-xs font-medium text-foreground',
        mono && 'font-mono',
      )}>{children}</span>
    </div>
  );
}

function RailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="mb-2.5 text-2xs font-bold uppercase tracking-[0.07em] text-muted-foreground">{title}</div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function RailMetric({ label, value, tone, icon }: { label: string; value: string; tone?: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
        <span className="truncate">{label}</span>
      </div>
      <div className="shrink-0 text-right text-xs font-semibold text-foreground" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

/**
 * Overview — slimmed to the agent's identity + an at-a-glance summary. Operational
 * config (Slack, verbose, hierarchy), logs, history and delete live under the
 * Settings tab. Identity edits PATCH only their own fields (updateAgent merges).
 */
function OverviewTab({ agent, onUpdate, canEdit, allAgents, onConnectSlack, onViewFeedback, onViewEvals }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean; allAgents: Agent[]; onConnectSlack: () => void; onViewFeedback: () => void; onViewEvals: () => void }) {
  const [form, setForm] = useState({
    name:        agent.name,
    description: agent.description ?? '',
    persona:     agent.persona ?? '',
    model:       agent.model,
    tags:        agent.tags ?? [] as string[],
    isBoss:      agent.isBoss,
    reportsTo:   agent.reportsTo ?? [] as string[],
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  // Start empty (not a Claude-model placeholder): the reset effect below snaps
  // form.model to options[0] whenever the saved value isn't in the list. If we
  // seed with the wrong-backend list, it clobbers the agent's real model (e.g.
  // gpt-5.5:high → "Balanced") before the correct list loads — and would persist
  // that downgrade on the next Save. The `!modelOptions.length` guard defers the
  // reset until the fetched, backend-correct list arrives.
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string; sub?: string }[]>([]);
  const [counts, setCounts] = useState<{ skills: number; memories: number; tools: number; wiki: number; audiences: number } | null>(null);
  const [usage, setUsage] = useState<{ queries30d: number; inputTokens: number; outputTokens: number; totalTokens: number; powerUser7d: { handle: string; taskCount: number } | null } | null>(null);
  const [feedback, setFeedback] = useState<AgentFeedbackReport | null>(null);
  const [evalHealth, setEvalHealth] = useState<{ total: number; errors: number; warnings: number } | null>(null);
  const [evalRun, setEvalRun] = useState<{ passCount: number; failCount: number; suspectCount: number; infraCount: number; status: string } | null>(null);
  const [slackInfo, setSlackInfo] = useState<{ displayName: string; handle: string; teamName: string } | null>(null);
  // Socket Mode (how the runner connects) needs the bot token AND the app-level
  // token; the signing secret is only for the HTTP Events API and is unused here.
  // Non-writers (e.g. viewers) get the agent via toAgentPublic, which STRIPS the raw
  // tokens and sets `hasSlackCreds` — so prefer that flag and fall back to the raw
  // tokens (present only for editors/admins who receive the un-stripped agent).
  const slackConfigured = agent.hasSlackCreds ?? !!(agent.slackBotToken && agent.slackAppToken);

  useEffect(() => {
    fetch('/api/system/models').then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.models?.length) setModelOptions(d.models); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!modelOptions.length) return;
    setForm(f => modelOptions.some(m => m.value === f.model) ? f : { ...f, model: modelOptions[0].value });
  }, [modelOptions]);

  useEffect(() => {
    let cancelled = false;
    const len = (x: any, key: string) => Array.isArray(x) ? x.length : (Array.isArray(x?.[key]) ? x[key].length : 0);
    Promise.all([
      fetch(`/api/agents/${agent.id}/skills`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/agents/${agent.id}/memories`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/agents/${agent.id}/mcps`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/agents/${agent.id}/wiki-folders`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/agents/${agent.id}/groups`).then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([s, m, t, w, g]) => {
      if (!cancelled) setCounts({ skills: len(s, 'skills'), memories: len(m, 'memories'), tools: len(t, 'mcps'), wiki: len(w, 'folders'), audiences: len(g, 'groups') });
    });
    return () => { cancelled = true; };
  }, [agent.id]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agents/${agent.id}/usage`).then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setUsage(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [agent.id]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agents/${agent.id}/feedback?limit=0&window=30d`).then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setFeedback(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [agent.id]);

  useEffect(() => {
    let cancelled = false;
    // Tier-1 healthcheck (static, fast) + the latest regression run, for the
    // Overview Evals card. Both are best-effort.
    fetch(`/api/agents/${agent.id}/evals/healthcheck`).then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.summary) setEvalHealth(d.summary); }).catch(() => {});
    fetch(`/api/agents/${agent.id}/evals/runs?limit=1`).then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return;
        const run = Array.isArray(d) ? d[0] : (d?.runs?.[0] ?? d?.run ?? null);
        if (run && typeof run.passCount === 'number') setEvalRun(run);
      }).catch(() => {});
    return () => { cancelled = true; };
  }, [agent.id]);

  useEffect(() => {
    if (!slackConfigured) { setSlackInfo(null); return; }
    let cancelled = false;
    fetch(`/api/agents/${agent.id}/slack-info`).then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setSlackInfo(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [agent.id, slackConfigured]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/agents/${agent.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, persona: form.persona, description: form.description, model: form.model, tags: form.tags, isBoss: form.isBoss, reportsTo: form.reportsTo }),
      });
      const data = await r.json();
      if (r.ok) { onUpdate(data); setMsg('Saved'); } else setMsg(data.error ?? 'Error');
    } finally { setSaving(false); setTimeout(() => setMsg(''), 3000); }
  };

  const num = (n: number | undefined) => counts ? String(n ?? 0) : '—';
  const fmtDate = fmtAgentDate;
  const fmtTokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

  return (
    <div className="fade-up w-full max-w-[1480px]">
      <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-card">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
            <div className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border',
              slackConfigured ? 'bg-green/15 text-green' : 'bg-muted text-muted-foreground',
            )}><Slack size={17} /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className={cn('h-[7px] w-[7px] shrink-0 rounded-full', slackConfigured ? 'bg-green' : 'bg-amber')} />
                <span className="text-sm font-semibold text-foreground">{slackConfigured ? 'Connected to Slack' : 'Slack not connected'}</span>
              </div>
              <div className="mt-0.5 truncate text-2xs text-muted-foreground">
                {slackConfigured
                  ? (slackInfo ? <>{slackInfo.teamName} · {slackInfo.displayName} <span className="font-mono">@{slackInfo.handle}</span></> : 'Credentials configured')
                  : 'Connect Slack when this agent is ready to answer from a workspace channel.'}
              </div>
            </div>
            {(canEdit || slackConfigured) && (
              <button onClick={onConnectSlack} className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium shadow-sm',
                slackConfigured ? 'border border-border bg-card text-foreground' : 'bg-primary text-primary-foreground',
              )}>{slackConfigured ? 'Manage Slack' : <><Plug size={13} /> Connect Slack</>}</button>
            )}
          </div>

          <div className="px-5 py-5">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <div className="text-base font-semibold text-foreground">Identity</div>
                <div className="mt-1 max-w-2xl text-sm text-muted-foreground">How this agent appears to teammates and how other agents decide when to delegate to it.</div>
              </div>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-3">
                  {msg && <span className={cn('text-xs', msg === 'Saved' ? 'text-green' : 'text-muted-foreground')}>{msg}</span>}
                  <PrimaryBtn onClick={save} loading={saving}>Save changes</PrimaryBtn>
                </div>
              )}
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} readOnly={!canEdit}
                hint="Internal agent name." />
              <SelectField label="Model" value={form.model} options={modelOptions}
                onChange={v => setForm(f => ({ ...f, model: v }))}
                hint="Model this agent runs on (options follow the active backend)." readOnly={!canEdit} />
            </div>
            <div className="mt-4">
              <TextArea label="Description" value={form.description}
                onChange={v => setForm(f => ({ ...f, description: v }))}
                hint="Short summary — used by boss agents for delegation." rows={2} readOnly={!canEdit} />
            </div>
            <div className="mt-4">
              <TagInput tags={form.tags} onChange={tags => setForm(f => ({ ...f, tags }))}
                allTags={allAgents.flatMap(a => a.tags ?? [])} readOnly={!canEdit} />
            </div>
            <div className="mt-4">
              <TextArea label="Persona" value={form.persona}
                onChange={v => setForm(f => ({ ...f, persona: v }))}
                hint="Who is this agent? This becomes the identity shown in Instructions → Skills." rows={7} readOnly={!canEdit} />
            </div>

            <div className="mt-5 border-t border-border pt-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="mb-0.5 text-sm font-medium text-foreground">Boss Agent</div>
                  <div className="text-2xs text-muted-foreground">Orchestrates other agents and delegates tasks.</div>
                </div>
                <button disabled={!canEdit} onClick={() => setForm(f => ({ ...f, isBoss: !f.isBoss }))} className={cn(
                  'relative h-6 w-11 shrink-0 rounded-full border-none transition-colors',
                  form.isBoss ? 'bg-amber' : 'bg-border',
                  canEdit ? 'cursor-pointer' : 'cursor-default',
                )}>
                  <div className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-card shadow-sm transition-[left]" style={{ left: form.isBoss ? 23 : 3 }} />
                </button>
              </div>
              {!form.isBoss && (() => {
                const bosses = allAgents.filter(a => a.isBoss && a.id !== agent.id);
                if (!bosses.length) return null;
                return (
                  <div className="mt-3.5">
                    <div className="mb-1.5 text-2xs font-medium text-foreground">Reports to</div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {bosses.map(boss => {
                        const checked = form.reportsTo.includes(boss.id);
                        return (
                          <label key={boss.id} className={cn(
                            'flex items-center gap-2 rounded-md border px-2.5 py-1.5',
                            checked ? 'border-amber/30 bg-amber/[0.04]' : 'border-border bg-card',
                            canEdit ? 'cursor-pointer' : 'cursor-default',
                          )}>
                            <input type="checkbox" checked={checked} disabled={!canEdit}
                              onChange={() => setForm(f => ({ ...f, reportsTo: checked ? f.reportsTo.filter(id => id !== boss.id) : [...f.reportsTo, boss.id] }))}
                              className="h-3.5 w-3.5 accent-amber" />
                            <span className="truncate text-xs font-medium text-foreground">{boss.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </section>

        <aside className="flex h-full flex-col rounded-lg border border-border bg-card px-4 py-4 shadow-card">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">Agent signal</div>
              <div className="mt-0.5 text-2xs text-muted-foreground">Live quality, usage, and configuration.</div>
            </div>
            <Link href={`/activity?agent=${encodeURIComponent(agent.id)}`} className="inline-flex items-center gap-1 text-xs font-medium text-foreground no-underline">
              Activity <ArrowRight size={12} />
            </Link>
          </div>

          <div className="flex flex-1 flex-col gap-4">
            {(() => {
              const f = feedback;
              const has = !!(f && f.total > 0);
              const score = f?.scorePercent ?? 0;
              const up = f?.up ?? 0, down = f?.down ?? 0;
              const tier = feedbackTier(score, has);
              return (
                <RailSection title="Satisfaction">
                  <button onClick={onViewFeedback} className="flex w-full cursor-pointer items-center gap-3 border-none bg-transparent p-0 text-left">
                    <div className={cn('text-2xl font-semibold leading-none tracking-normal', !has && 'text-muted-foreground')} style={has ? { color: tier.color } : undefined}>{has ? `${score}%` : '—'}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-foreground">{has ? tier.label : 'No ratings yet'}</div>
                      <div className="mt-1 flex items-center gap-1.5">
                        {has ? (
                          <>
                            <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"><ThumbsUp size={10} className="text-green" /> {up}</span>
                            <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"><ThumbsDown size={10} className="text-red" /> {down}</span>
                          </>
                        ) : (
                          <span className="text-2xs text-muted-foreground">Slack feedback appears here.</span>
                        )}
                      </div>
                    </div>
                    <ArrowRight size={13} className="text-muted-foreground" />
                  </button>
                  {has && (
                    <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="bg-green" style={{ width: `${score}%` }} />
                      <div className="bg-red opacity-55" style={{ width: `${100 - score}%` }} />
                    </div>
                  )}
                </RailSection>
              );
            })()}

            <RailSection title="Quality">
              {(() => {
                const tier = evalTier(evalHealth);
                const run = evalRun;
                const ranTotal = run ? run.passCount + run.failCount + run.suspectCount + run.infraCount : 0;
                const ran = run && run.status === 'done' && ranTotal > 0;
                const rate = ran ? Math.round((run!.passCount / ranTotal) * 100) : 0;
                const rateColor = !ran ? 'var(--muted)' : rate >= 80 ? '#16a34a' : rate >= 50 ? '#d97706' : '#dc2626';
                return (
                  <>
                    <button onClick={onViewEvals} title="Open Evals" className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent py-1 text-left">
                      <tier.Icon size={13} style={{ color: tier.color, flexShrink: 0 }} />
                      <span className="text-xs text-muted-foreground">Health</span>
                      <span className="ml-auto text-xs font-semibold" style={{ color: tier.color }}>{tier.label}</span>
                    </button>
                    <button onClick={onViewEvals} title="Open Evals" className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent py-1 text-left">
                      <ClipboardCheck size={13} style={{ color: rateColor }} className="shrink-0" />
                      <span className="text-xs text-muted-foreground">Regression</span>
                      <span className="ml-auto text-xs font-semibold" style={{ color: rateColor }}>{ran ? `${rate}%` : 'No runs'}</span>
                    </button>
                  </>
                );
              })()}
            </RailSection>

            <RailSection title="Composition">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <RailMetric label="Skills" value={num(counts?.skills)} />
                <RailMetric label="Tools" value={num(counts?.tools)} />
                <RailMetric label="Memories" value={num(counts?.memories)} />
                <RailMetric label="Wiki" value={num(counts?.wiki)} />
                <RailMetric label="Audiences" value={num(counts?.audiences)} />
              </div>
            </RailSection>

            <RailSection title="Activity">
              <RailMetric icon={<MessageSquare size={13} />} label="Queries 30d" value={usage ? String(usage.queries30d) : '—'} />
              <RailMetric icon={<Layers size={13} />} label="Input tokens" value={usage ? fmtTokens(usage.inputTokens) : '—'} />
              <RailMetric icon={<Layers size={13} />} label="Output tokens" value={usage ? fmtTokens(usage.outputTokens) : '—'} />
              <RailMetric icon={<UserCircle size={13} />} label="Power user 7d" value={usage ? (usage.powerUser7d ? `@${usage.powerUser7d.handle}` : 'None') : '—'} />
            </RailSection>

            <RailSection title="Configuration">
              <RailMetric icon={<Briefcase size={13} />} label="Role" value={agent.isBoss ? 'Boss' : 'Standard'} />
              <RailMetric icon={<MessageSquare size={13} />} label="Verbose" value={agent.verbose ? 'On' : 'Off'} />
              <RailMetric icon={<UserCircle size={13} />} label="Owner" value={agent.createdBy} />
              <RailMetric icon={<Calendar size={13} />} label="Created" value={fmtDate(agent.createdAt)} />
              <RailMetric icon={<Clock size={13} />} label="Updated" value={fmtDate(agent.updatedAt)} />
            </RailSection>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── Agent Settings (side-nav: General · Slack · Evals · Logs · History · Danger) ──

function AgentSettingsTab({ agent, onUpdate, canEdit, viewOnly, allAgents, role, username, section, onSection, onAskCoach, onOpenCoach }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean; viewOnly: boolean; allAgents: Agent[]; role: string | null; username: string; section: SettingsSection; onSection: (s: SettingsSection) => void; onAskCoach: (message: string) => void; onOpenCoach: () => void }) {
  const isAdmin = role === 'admin' || role === 'superadmin';
  const canDelete = isAdmin || agent.createdBy === username;
  const sections: { id: SettingsSection; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'slack', label: 'Slack' },
  ];
  if (!viewOnly) sections.push({ id: 'evals', label: 'Evals' }, { id: 'feedback', label: 'Feedback' }, { id: 'logs', label: 'Logs' }, { id: 'history', label: 'History' });
  if (canDelete) sections.push({ id: 'danger', label: 'Danger Zone' });
  const setSection = onSection;

  return (
    <div className="fade-up grid w-full max-w-[1480px] items-start gap-6 xl:grid-cols-[220px_minmax(0,980px)]">
      <div className="rounded-lg border border-border bg-card p-2 shadow-card xl:sticky xl:top-4">
        <div className="px-2.5 pb-2 pt-1.5">
          <div className="text-sm font-semibold text-foreground">Settings</div>
          <div className="mt-0.5 text-2xs text-muted-foreground">Agent configuration and operational controls.</div>
        </div>
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)} className={cn(
            'flex w-full cursor-pointer items-center justify-between rounded-md border-none bg-transparent px-2.5 py-2 text-left text-sm',
            section === s.id
              ? cn('bg-muted font-medium shadow-sm', s.id === 'danger' ? 'text-destructive' : 'text-foreground')
              : 'font-normal text-muted-foreground',
          )}>
            <span>{s.label}</span>
            {section === s.id && <ChevronRight size={13} className="text-muted-foreground" />}
          </button>
        ))}
      </div>
      <div className="min-w-0">
        {section === 'general' && <GeneralSettingsSection agent={agent} onUpdate={onUpdate} canEdit={canEdit} />}
        {section === 'slack'   && <SlackSettingsSection   agent={agent} onUpdate={onUpdate} canEdit={canEdit} />}
        {section === 'evals'   && <EvalsPanel agent={agent} onAskCoach={onAskCoach} onOpenCoach={onOpenCoach} />}
        {section === 'feedback' && <FeedbackPanel agent={agent} />}
        {section === 'logs'    && <LogsTab    agentId={agent.id} slug={agent.slug} />}
        {section === 'history' && <HistoryTab agentId={agent.id} canEdit={canEdit} />}
        {section === 'danger'  && <DangerSection agent={agent} canDelete={canDelete} />}
      </div>
    </div>
  );
}

function GeneralSettingsSection({ agent, onUpdate, canEdit }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean }) {
  const [form, setForm] = useState({
    verbose: agent.verbose ?? true,
    sensitivityCheck: agent.sensitivityCheck ?? 'deterministic',
    enforcementRedaction: agent.enforcementRedaction ?? false,
    redactionLevel: agent.redactionLevel ?? 'secrets',
    sensitivityGuidance: agent.sensitivityGuidance ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [guideOpen, setGuideOpen] = useState(!!(agent.sensitivityGuidance ?? '').trim());
  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/agents/${agent.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbose: form.verbose, sensitivityCheck: form.sensitivityCheck, enforcementRedaction: form.enforcementRedaction, redactionLevel: form.redactionLevel, sensitivityGuidance: form.sensitivityGuidance }),
      });
      const data = await r.json();
      if (r.ok) { onUpdate(data); setMsg('Saved'); } else setMsg(data.error ?? 'Error');
    } finally { setSaving(false); setTimeout(() => setMsg(''), 3000); }
  };
  return (
    <div className="flex max-w-[980px] flex-col gap-5">
      <Card title="Behavior">
        <div className="flex items-center justify-between">
          <div>
            <div className="mb-0.5 text-sm font-medium text-foreground">Verbose Responses</div>
            <div className="text-xs text-muted-foreground">On: each step is posted as it happens. Off: only the final answer is sent as one message.</div>
          </div>
          <button disabled={!canEdit} onClick={() => setForm(f => ({ ...f, verbose: !f.verbose }))} className={cn(
            'relative h-6 w-11 shrink-0 rounded-full border-none transition-colors',
            form.verbose ? 'bg-blue' : 'bg-border',
            canEdit ? 'cursor-pointer' : 'cursor-default',
          )}>
            <div className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-card shadow-sm transition-[left]" style={{ left: form.verbose ? 23 : 3 }} />
          </button>
        </div>
      </Card>

      <Card title="Sensitive data monitoring">
        <div className="mb-4">
          <div className="mb-0.5 flex items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">Detection mode</span>
            <InfoTip>
              <div><strong className="text-foreground">Off</strong> — no detection, no overhead. Use for agents that never handle personal data, secrets, or external sends.</div>
              <div className="mt-1"><strong className="text-foreground">Deterministic</strong> (recommended) — fast pattern rules flag PII, secrets, DB credentials, and source→sink exfiltration flows; no model calls. Good default for most agents.</div>
              <div className="mt-1"><strong className="text-foreground">Smart</strong> — the rules, plus one cheap LLM pass per turn that (a) confirms findings and drops false positives, and (b) independently catches sensitive data the rules miss, like obfuscated PII (a phone number spelled out in words). LLM-only finds are marked &quot;caught by LLM&quot; in sessions — report-only, never blocks. Adds slight latency + cost.</div>
            </InfoTip>
          </div>
          <div className="mb-2 text-xs text-muted-foreground">
            How this agent&apos;s tool I/O and replies are scanned for PII, secrets, and exfiltration flows.
          </div>
          <div className="grid gap-2 lg:grid-cols-3">
            {([
              ['off', 'Off', 'No scanning'],
              ['deterministic', 'Deterministic', 'Regex / pattern rules'],
              ['smart', 'Smart', 'Rules + LLM detection'],
            ] as const).map(([val, label, sub]) => {
              const active = form.sensitivityCheck === val;
              return (
                <button key={val} disabled={!canEdit} onClick={() => setForm(f => ({ ...f, sensitivityCheck: val }))} className={cn(
                  'flex-1 rounded-md border px-3 py-2 text-left transition-colors',
                  active ? 'border-primary bg-muted' : 'border-border bg-card',
                  canEdit ? 'cursor-pointer' : 'cursor-default',
                )}>
                  <div className={cn('text-sm font-semibold', active ? 'text-foreground' : 'text-muted-foreground')}>{label}</div>
                  <div className="text-2xs text-muted-foreground">{sub}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Smart-only: per-agent guidance on what counts as sensitive, fed into the
            LLM detector prompt. A small toggle keeps the card lean by default. */}
        {form.sensitivityCheck === 'smart' && (
          <div className="mt-1 rounded-md border border-border bg-muted px-3.5 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="mb-0.5">
                  <span className="text-sm font-medium text-foreground">What&apos;s sensitive for this agent</span>
                </div>
                <div className="text-2xs text-muted-foreground">Optional. Tell the LLM detector what to treat as sensitive here, beyond the built-in PII/secrets.</div>
              </div>
              {!guideOpen && (
                <button disabled={!canEdit} onClick={() => setGuideOpen(true)} className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground',
                  canEdit ? 'cursor-pointer' : 'cursor-default',
                )}><Pencil size={12} /> {form.sensitivityGuidance.trim() ? 'Edit' : 'Add rules'}</button>
              )}
            </div>
            {guideOpen && (
              <div className="mt-2.5">
                <textarea
                  value={form.sensitivityGuidance}
                  onChange={e => setForm(f => ({ ...f, sensitivityGuidance: e.target.value }))}
                  readOnly={!canEdit}
                  rows={4}
                  placeholder={'e.g. Internal project codenames (Project Atlas, Bluebird)\nUnreleased pricing or revenue figures\nPatient or case identifiers'}
                  className="w-full resize-y rounded-md border border-border bg-card px-2.5 py-2 text-xs leading-normal text-foreground" />
                <div className="mt-1 text-2xs text-muted-foreground">One rule per line. Findings from these still appear marked &quot;caught by LLM&quot; — report-only, never blocks.</div>
              </div>
            )}
          </div>
        )}

        <div className={cn('flex items-center justify-between', form.sensitivityCheck === 'off' && 'opacity-50')}>
          <div>
            <div className="mb-0.5 flex items-center gap-1.5">
              <span className="text-sm font-medium text-foreground">Redact secrets in replies</span>
              <InfoTip>
                Mask detected secrets and high-risk values (keys, cards, SSNs) as <code>[redacted]</code> in the agent&apos;s outbound message before it reaches the channel. Enable for agents that read from credential stores / databases and post into shared channels. Emails &amp; phone numbers are left intact; the full value is still kept in the private trace.
              </InfoTip>
            </div>
            <div className="text-xs text-muted-foreground">Strip leaked secrets from messages before they&apos;re posted.</div>
          </div>
          <button disabled={!canEdit || form.sensitivityCheck === 'off'} onClick={() => setForm(f => ({ ...f, enforcementRedaction: !f.enforcementRedaction }))} className={cn(
            'relative h-6 w-11 shrink-0 rounded-full border-none transition-colors',
            form.enforcementRedaction ? 'bg-destructive' : 'bg-border',
            canEdit && form.sensitivityCheck !== 'off' ? 'cursor-pointer' : 'cursor-default',
          )}>
            <div className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-card shadow-sm transition-[left]" style={{ left: form.enforcementRedaction ? 23 : 3 }} />
          </button>
        </div>
        {form.enforcementRedaction && form.sensitivityCheck !== 'off' && (
          <div className="mt-3">
            <div className="mb-1.5 text-xs font-medium text-foreground">What to redact</div>
            <div className="grid gap-2 lg:grid-cols-3">
              {([
                ['secrets', 'Secrets only', 'Keys, tokens, cards, SSNs'],
                ['pii', 'Secrets + PII', 'Also emails & phone numbers'],
                ['all', 'Everything flagged', 'All detected matches'],
              ] as const).map(([val, label, sub]) => {
                const active = form.redactionLevel === val;
                return (
                  <button key={val} disabled={!canEdit} onClick={() => setForm(f => ({ ...f, redactionLevel: val }))} className={cn(
                    'flex-1 rounded-md border px-3 py-2 text-left transition-colors',
                    active ? 'border-destructive bg-destructive/[0.06]' : 'border-border bg-card',
                    canEdit ? 'cursor-pointer' : 'cursor-default',
                  )}>
                    <div className={cn('text-xs font-semibold', active ? 'text-foreground' : 'text-muted-foreground')}>{label}</div>
                    <div className="text-2xs text-muted-foreground">{sub}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      <Card title="Capabilities">
        <PermissionsTab agentId={agent.id} canEdit={canEdit} />
      </Card>

      <div className="flex items-center gap-2.5">
        {canEdit && <PrimaryBtn onClick={save} loading={saving}>Save Changes</PrimaryBtn>}
        {msg && <span className="text-xs text-green">{msg}</span>}
      </div>
    </div>
  );
}

function SlackSettingsSection({ agent, onUpdate, canEdit }: { agent: Agent; onUpdate: (a: Agent) => void; canEdit: boolean }) {
  const [form, setForm] = useState({ slackBotToken: agent.slackBotToken, slackAppToken: agent.slackAppToken, slackSigningSecret: agent.slackSigningSecret });
  const [allowedChannels, setAllowedChannels] = useState('');
  const [slackInfo, setSlackInfo] = useState<{ displayName: string; handle: string; teamName: string } | null>(null);
  const [manifest, setManifest] = useState('');
  const [showManifest, setShowManifest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!agent.slackBotToken) return;
    fetch(`/api/agents/${agent.id}/slack-info`).then(r => r.ok ? r.json() : null).then(d => d && setSlackInfo(d)).catch(() => {});
  }, [agent.id, agent.slackBotToken]);
  useEffect(() => {
    fetch(`/api/agents/${agent.id}/restrictions`).then(r => r.json()).then((d: Restriction) => setAllowedChannels((d.allowedChannels ?? []).join('\n'))).catch(() => {});
  }, [agent.id]);

  const save = async () => {
    setSaving(true);
    try {
      const [r] = await Promise.all([
        fetch(`/api/agents/${agent.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form.slackBotToken ? { platformCredentials: { botToken: form.slackBotToken, appToken: form.slackAppToken, signingSecret: form.slackSigningSecret } } : {}),
        }),
        fetch(`/api/agents/${agent.id}/restrictions`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowedChannels: allowedChannels.split('\n').map(s => s.trim()).filter(Boolean) }),
        }),
      ]);
      const data = await r.json();
      if (r.ok) { onUpdate(data); setMsg('Saved'); } else setMsg(data.error ?? 'Error');
    } finally { setSaving(false); setTimeout(() => setMsg(''), 3000); }
  };

  const loadManifest = async () => {
    const r = await fetch(`/api/agents/${agent.id}/manifest`);
    setManifest(JSON.stringify(await r.json(), null, 2));
    setShowManifest(true);
  };

  const [disconnecting, setDisconnecting] = useState(false);
  const disconnect = async () => {
    if (!confirm('Disconnect Slack? This permanently removes this agent\'s bot token, app token, and signing secret, and stops it from posting to Slack. You can reconnect later by entering credentials again.')) return;
    setDisconnecting(true);
    try {
      const r = await fetch(`/api/agents/${agent.id}/slack`, { method: 'DELETE' });
      if (r.ok) {
        const data = await r.json().catch(() => null);
        setForm({ slackBotToken: '', slackAppToken: '', slackSigningSecret: '' });
        setSlackInfo(null);
        onUpdate(data ?? { ...agent, slackBotToken: undefined, slackAppToken: undefined, slackSigningSecret: undefined, slackBotUserId: undefined });
        setMsg('Disconnected');
      } else setMsg('Disconnect failed');
    } catch { setMsg('Disconnect failed'); }
    finally { setDisconnecting(false); setTimeout(() => setMsg(''), 3000); }
  };
  const slackConfigured = !!(agent.slackBotToken || agent.slackAppToken || agent.slackSigningSecret);

  return (
    <div className="flex max-w-[980px] flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2.5">
        {canEdit && <PrimaryBtn onClick={save} loading={saving}>Save Changes</PrimaryBtn>}
        <GhostBtn onClick={loadManifest}>View Slack Manifest</GhostBtn>
        {canEdit && slackConfigured && (
          <button onClick={disconnect} disabled={disconnecting} className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-destructive/30 bg-card px-3.5 py-1.5 text-sm font-medium text-destructive disabled:cursor-not-allowed"><Plug size={13} /> {disconnecting ? 'Disconnecting…' : 'Disconnect Slack'}</button>
        )}
        {msg && <span className="text-xs text-green">{msg}</span>}
      </div>

      {!slackConfigured && (
        <Card title="Connect this agent to Slack">
          <p className="mb-3 mt-0 text-xs leading-relaxed text-muted-foreground">
            This agent isn&apos;t connected yet, so it can&apos;t post to Slack. It takes ~2 minutes:
          </p>
          <ol className="mb-1 mt-0 list-decimal pl-[18px] text-xs leading-loose text-muted-foreground">
            <li>Open <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="font-medium text-primary no-underline">api.slack.com/apps</a> → <strong>Create New App</strong> → <strong>From a manifest</strong>.</li>
            <li>Click <strong>View Slack Manifest</strong> above, copy it, and paste it into the JSON tab → <strong>Create</strong>.</li>
            <li><strong>Install to Workspace</strong> (sidebar → Install App), then paste the Bot &amp; App-Level tokens below and <strong>Save</strong>.</li>
          </ol>
        </Card>
      )}

      <Card title="Slack Credentials">
        <Field label="Bot Token" value={form.slackBotToken ?? ''} onChange={v => setForm(f => ({ ...f, slackBotToken: v }))} type="password" readOnly={!canEdit}
          hint={form.slackBotToken && !form.slackBotToken.startsWith('xoxb-')
            ? <span className="text-red">Bot tokens start with <code className="font-mono text-2xs">xoxb-</code> — did you paste the wrong one?</span>
            : <>api.slack.com/apps → your app → <strong>OAuth &amp; Permissions</strong> → Bot User OAuth Token</>} />
        <Field label="App-Level Token" value={form.slackAppToken ?? ''} onChange={v => setForm(f => ({ ...f, slackAppToken: v }))} type="password" readOnly={!canEdit}
          hint={form.slackAppToken && !form.slackAppToken.startsWith('xapp-')
            ? <span className="text-red">App-level tokens start with <code className="font-mono text-2xs">xapp-</code> — did you paste the wrong one?</span>
            : <>Basic Information → <strong>App-Level Tokens</strong> → Generate with scope <code className="font-mono text-2xs">connections:write</code></>} />
        <Field label="Signing Secret (optional)" value={form.slackSigningSecret ?? ''} onChange={v => setForm(f => ({ ...f, slackSigningSecret: v }))} type="password" readOnly={!canEdit}
          hint="Not used in Socket Mode (how agents connect) — only needed for the HTTP Events API. Basic Information → App Credentials → Signing Secret." />
        {slackInfo && (
          <div className="rounded-md border border-green/30 bg-green/10 px-3.5 py-2.5 text-xs">
            <div className="mb-2 flex items-center gap-1.5">
              <div className="h-[7px] w-[7px] shrink-0 rounded-full bg-green" />
              <span className="font-semibold text-green">Connected to Slack</span>
              <span className="ml-auto text-2xs text-muted-foreground">{slackInfo.teamName}</span>
            </div>
            <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              <span className="text-muted-foreground">Display name</span>
              <span className="font-medium text-foreground">{slackInfo.displayName}</span>
              <span className="text-muted-foreground">@handle</span>
              <span className="font-mono text-foreground">@{slackInfo.handle}</span>
              {agent.slackBotUserId && <>
                <span className="text-muted-foreground">Bot User ID</span>
                <span className="font-mono text-foreground">{agent.slackBotUserId}</span>
              </>}
            </div>
          </div>
        )}
      </Card>

      <Card title="Allowed Channels">
        <p className="mb-2.5 mt-0 text-xs leading-relaxed text-muted-foreground">
          Restrict this bot to specific Slack channels. One Slack channel ID per line (e.g. <code className="font-mono text-2xs">C01234ABCDE</code>).
          If empty, the bot responds in all channels it's invited to.
        </p>
        <textarea value={allowedChannels} onChange={e => setAllowedChannels(e.target.value)} rows={4} readOnly={!canEdit} placeholder={'C01234ABCDE\nC09876ZYXWV'}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </Card>

      {showManifest && (
        <Modal title="Slack App Manifest" width={680} onClose={() => setShowManifest(false)}>
          <div className="overflow-hidden rounded-lg border border-border bg-muted">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="font-mono text-2xs text-muted-foreground">slack-manifest.json</span>
              <button onClick={() => navigator.clipboard.writeText(manifest)} className="cursor-pointer border-none bg-transparent text-2xs text-primary">Copy</button>
            </div>
            <pre className="m-0 max-h-[60vh] overflow-auto p-4 font-mono text-2xs text-primary">{manifest}</pre>
          </div>
        </Modal>
      )}
    </div>
  );
}

function DangerSection({ agent, canDelete }: { agent: Agent; canDelete: boolean }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState('');
  const handleDelete = async () => {
    if (!confirm(`Permanently delete agent "${agent.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    const r = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
    if (r.ok) { window.dispatchEvent(new Event('slackhive:sidebar-refresh')); router.push('/'); }
    else { const err = await r.json(); setMsg(err.error ?? 'Delete failed'); setDeleting(false); }
  };
  if (!canDelete) return <div className="text-sm text-muted-foreground">You don&apos;t have permission to delete this agent.</div>;
  return (
    <div className="max-w-[980px]">
      <div className="mb-4 text-2xs font-bold uppercase tracking-[0.08em] text-destructive">Danger Zone</div>
      <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-muted px-4 py-3.5">
        <div>
          <div className="mb-0.5 text-sm font-medium text-foreground">Delete this agent</div>
          <div className="text-xs text-muted-foreground">Permanently removes the agent, all its skills, memories, and history. This cannot be undone.</div>
        </div>
        <button onClick={handleDelete} disabled={deleting} className="ml-6 shrink-0 whitespace-nowrap rounded-md border border-destructive bg-card px-4 py-2 text-sm font-semibold text-destructive disabled:cursor-not-allowed disabled:bg-muted">{deleting ? 'Deleting…' : 'Delete Agent'}</button>
      </div>
      {msg && <div className="mt-2.5 text-xs text-destructive">{msg}</div>}
    </div>
  );
}

// ─── Feedback report card (Settings → Feedback) ───────────────────────────────

type FbWindow = '7d' | '30d' | '90d' | 'all';
type FbSentiment = 'all' | 'up' | 'down';
const FB_WINDOWS: { k: FbWindow; label: string }[] = [
  { k: '7d', label: '7d' }, { k: '30d', label: '30d' }, { k: '90d', label: '90d' }, { k: 'all', label: 'All' },
];
const FB_WINDOW_LABEL: Record<FbWindow, string> = {
  '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days', 'all': 'all-time',
};
function FeedbackPanel({ agent }: { agent: Agent }) {
  const [data, setData] = useState<AgentFeedbackReport | null>(null);
  const [list, setList] = useState<FeedbackRating[]>([]);
  const [win, setWin] = useState<FbWindow>('30d');
  const [sent, setSent] = useState<FbSentiment>('all');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped whenever the filters change; a stale loadMore checks it before
  // appending so it can't merge a previous filter's rows into the new list.
  const genRef = useRef(0);

  // Build the query for the active window + sentiment filter.
  const query = (extra?: Record<string, string>) => {
    const p = new URLSearchParams(extra);
    if (win !== 'all') p.set('window', win);
    if (sent !== 'all') p.set('sentiment', sent);
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  useEffect(() => {
    let cancelled = false;
    const gen = ++genRef.current;
    setLoading(true);
    fetch(`/api/agents/${agent.id}/feedback${query()}`).then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && gen === genRef.current) { setData(d); setList(d?.recentRatings ?? []); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, win, sent]);

  const loadMore = async () => {
    const gen = genRef.current;
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/agents/${agent.id}/feedback${query({ offset: String(list.length), limit: '10' })}`);
      // Drop the response if the filters changed while it was in flight.
      if (r.ok && gen === genRef.current) { const d = await r.json(); setList(prev => [...prev, ...(d.recentRatings ?? [])]); }
    } finally { if (gen === genRef.current) setLoadingMore(false); }
  };

  const total = data?.total ?? 0;
  const up = data?.up ?? 0;
  const down = data?.down ?? 0;
  const score = data?.scorePercent ?? 0;
  const ratingCount = data?.ratingCount ?? 0;
  const tier = feedbackTier(score, total > 0);

  const pill = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 5, border: 'none',
    background: active ? 'var(--surface)' : 'transparent', color: active ? 'var(--text)' : 'var(--muted)',
    borderRadius: 6, padding: '4px 11px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
    fontFamily: 'var(--font-sans)', boxShadow: active ? 'var(--shadow-sm)' : 'none',
  });

  const windowUI = (
    <div className="flex gap-[3px] rounded-lg bg-secondary p-[3px]">
      {FB_WINDOWS.map(w => (
        <button key={w.k} onClick={() => setWin(w.k)} style={pill(win === w.k)}>{w.label}</button>
      ))}
    </div>
  );

  const sentimentUI = (
    <div className="flex gap-[3px] rounded-lg bg-secondary p-[3px]">
      <button onClick={() => setSent('all')} style={pill(sent === 'all')}>All</button>
      <button onClick={() => setSent('up')} style={pill(sent === 'up')} aria-label="Thumbs up only"><ThumbsUp size={13} /></button>
      <button onClick={() => setSent('down')} style={pill(sent === 'down')} aria-label="Thumbs down only"><ThumbsDown size={13} /></button>
    </div>
  );

  const GREEN = '#16a34a', RED = '#dc2626';

  return (
    <div className="fade-up flex max-w-[980px] flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xl font-semibold tracking-normal">Feedback</div>
          <div className="mt-1 text-sm text-muted-foreground">Ratings users gave this agent&apos;s replies in Slack.</div>
        </div>
        {windowUI}
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : total === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-5 py-12 text-center text-sm leading-relaxed text-muted-foreground">
          {win === 'all'
            ? <>No ratings yet. When this agent replies in Slack, a feedback prompt lets users rate it — results show up here.</>
            : <>No ratings in the {FB_WINDOW_LABEL[win]}. Try a wider range.</>}
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-card p-5 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-5">
              <div>
                <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Satisfaction</div>
                <div className="mt-1.5 flex items-baseline gap-2.5">
                  <span className="text-[40px] font-semibold leading-none tracking-normal" style={{ color: tier.color }}>{score}%</span>
                  <span className="rounded-md px-2 py-0.5 text-xs font-semibold" style={{ color: tier.color, background: `color-mix(in srgb, ${tier.color} 12%, transparent)` }}>{tier.label}</span>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">{total} rating{total !== 1 ? 's' : ''} · {FB_WINDOW_LABEL[win]}</div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setSent('up')} className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium',
                  sent === 'up' ? 'border-green/30 bg-green/10 text-green' : 'border-border bg-secondary text-muted-foreground',
                )}><ThumbsUp size={14} /> {up}</button>
                <button onClick={() => setSent('down')} className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium',
                  sent === 'down' ? 'border-red/30 bg-red/10 text-red' : 'border-border bg-secondary text-muted-foreground',
                )}><ThumbsDown size={14} /> {down}</button>
              </div>
            </div>
            <div className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="bg-green" style={{ width: `${score}%` }} />
              <div className="bg-red opacity-55" style={{ width: `${100 - score}%` }} />
            </div>
          </div>

          {/* Ratings feed — rater, sentiment, note, and a thread link. */}
          <div>
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <div className="text-base font-semibold">Ratings{ratingCount ? ` (${ratingCount})` : ''}</div>
              {sentimentUI}
            </div>
            {list.length === 0 ? (
              <div className="rounded-xl border border-border px-5 py-7 text-center text-sm text-muted-foreground">
                No {sent === 'up' ? 'positive' : sent === 'down' ? 'negative' : ''} ratings in this range.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                {list.map((rt, i) => {
                  const c = rt.sentiment === 'up' ? GREEN : RED;
                  const handle = rt.raterHandle || 'Anonymous';
                  return (
                    <div key={i} className={cn('flex gap-3 px-4 py-3.5', i && 'border-t border-border')}>
                      <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg" style={{ background: `color-mix(in srgb, ${c} 14%, transparent)` }}>
                        {rt.sentiment === 'up' ? <ThumbsUp size={15} className="text-green" /> : <ThumbsDown size={15} className="text-red" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">{handle}</span>
                          <span className="text-2xs text-muted-foreground">{fmtAgentDate(rt.createdAt)}</span>
                          {(rt.sessionId || rt.permalink) && (
                            <span className="ml-auto flex items-center gap-3.5">
                              {rt.sessionId && (
                                <Link href={`/activity/${encodeURIComponent(rt.sessionId)}`} className="flex items-center gap-1 text-xs font-medium text-primary no-underline">
                                  View session <ArrowRight size={12} />
                                </Link>
                              )}
                              {rt.permalink && (
                                <a href={rt.permalink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs font-medium text-muted-foreground no-underline">
                                  View thread <ExternalLink size={12} />
                                </a>
                              )}
                            </span>
                          )}
                        </div>
                        {rt.note && <div className="mt-[5px] text-sm leading-[1.55] text-foreground">{rt.note}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {list.length < ratingCount && (
              <button onClick={loadMore} disabled={loadingMore} className={cn('mt-3 rounded-lg border border-border bg-transparent px-3.5 py-[7px] text-xs font-medium text-foreground', loadingMore ? 'cursor-default' : 'cursor-pointer')}>{loadingMore ? 'Loading…' : `Load more (${ratingCount - list.length})`}</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── CLAUDE.md viewer ─────────────────────────────────────────────────────────

function InstructionsTab({ agent, canEdit, onAgentUpdate, onOpenCoach }: { agent: Agent; canEdit: boolean; onAgentUpdate: (a: Agent) => void; onOpenCoach?: () => void }) {
  // ── Export / Import ────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [importPreview, setImportPreview] = useState<AgentExportPayload | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Which surface is shown — System Prompt, Skills, or Memory (was: System Prompt
  // always-on + a separate Skills/Memory sub-tab bar). One segmented control reads
  // cleaner and gives each surface the full width.
  const [section, setSection] = useState<'system' | 'skills' | 'memory'>('system');

  // Persona library / import modal
  const [personaLibOpen, setPersonaLibOpen] = useState(false);
  const [libTab, setLibTab] = useState<'json' | 'template'>('json');
  const [libSearch, setLibSearch] = useState('');
  const [libCategory, setLibCategory] = useState<PersonaCategory | 'all'>('all');
  const [libSelected, setLibSelected] = useState<PersonaTemplate | null>(null);
  const [libSkillSel, setLibSkillSel] = useState<Set<string>>(new Set());
  const [libApplying, setLibApplying] = useState(false);

  // Export chooser — pick which parts to include.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSel, setExportSel] = useState({ identity: true, system: true, skills: true, memory: true });
  // Import selection — which parts of the loaded file to apply.
  const [importSel, setImportSel] = useState({ identity: true, system: true, skills: true, memory: true });

  const doExport = async () => {
    setExporting(true);
    try {
      const payload: AgentExportPayload = {
        version: 1,
        exportedAt: new Date().toISOString(),
      };
      if (exportSel.identity) {
        // Only export non-empty values so a persona-less agent's export can't
        // later blank a target agent's real persona/description on import.
        const persona = meaningfulStr(agent.persona);
        const description = meaningfulStr(agent.description);
        if (persona !== undefined) payload.persona = persona;
        if (description !== undefined) payload.description = description;
      }
      if (exportSel.system) {
        payload.claudeMd = await fetch(`/api/agents/${agent.id}/claude-md`).then(r => r.text());
      }
      if (exportSel.skills) {
        const skills: Skill[] = await fetch(`/api/agents/${agent.id}/skills`).then(r => r.json());
        payload.skills = skills.map(s => ({ category: s.category, filename: s.filename, content: s.content, sortOrder: s.sortOrder }));
      }
      if (exportSel.memory) {
        const mems: Memory[] = await fetch(`/api/agents/${agent.id}/memories`).then(r => r.ok ? r.json() : []).catch(() => []);
        payload.memories = mems.map(m => ({ type: m.type, name: m.name, content: m.content }));
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${agent.slug}-export.json`; a.click();
      URL.revokeObjectURL(url);
      setExportOpen(false);
    } finally { setExporting(false); }
  };

  // Export/Import are triggered from the tab-bar actions (rendered at page level,
  // only on this tab) via window events; we keep the handlers + modals here.
  useEffect(() => {
    const onExport = () => setExportOpen(true);
    const onImport = () => { setImportPreview(null); setImportError(''); setPersonaLibOpen(true); };
    window.addEventListener('instr:export', onExport);
    window.addEventListener('instr:import', onImport);
    return () => {
      window.removeEventListener('instr:export', onExport);
      window.removeEventListener('instr:import', onImport);
    };
  }, []);

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImportError('');
    if (!file.name.endsWith('.json')) { setImportError('File must be a .json export'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data || typeof data !== 'object') { setImportError('Invalid file: not a JSON object'); return; }
        const hasIdentity = meaningfulStr(data.persona) !== undefined || meaningfulStr(data.description) !== undefined;
        const hasMd = typeof data.claudeMd === 'string';
        const hasSkills = Array.isArray(data.skills) && data.skills.length > 0;
        const hasMems = Array.isArray(data.memories) && data.memories.length > 0;
        if (!hasIdentity && !hasMd && !hasSkills && !hasMems) { setImportError('Nothing to import: file has no identity, system prompt, skills, or memories'); return; }
        if (hasSkills) {
          for (let i = 0; i < data.skills.length; i++) {
            const s = data.skills[i];
            if (!s.category || typeof s.category !== 'string') { setImportError(`Invalid skill #${i + 1}: missing category`); return; }
            if (!s.filename || typeof s.filename !== 'string') { setImportError(`Invalid skill #${i + 1}: missing filename`); return; }
            if (typeof s.content !== 'string') { setImportError(`Invalid skill #${i + 1}: missing content`); return; }
          }
        }
        // Default selection = whatever the file actually contains.
        setImportSel({ identity: hasIdentity, system: hasMd, skills: hasSkills, memory: hasMems });
        setImportPreview(data);
      } catch { setImportError('Could not parse file — must be valid JSON'); }
    };
    reader.readAsText(file);
  };

  const applyImport = async (payload?: AgentExportPayload, selOverride?: { identity: boolean; system: boolean; skills: boolean; memory: boolean }) => {
    const data = payload ?? importPreview;
    if (!data) return;
    const sel = selOverride ?? importSel;
    setImporting(true);
    try {
      // Identity: persona + description (independent of the System Prompt body).
      // Only apply meaningful (non-empty string) values — never blank a real one
      // or send a non-string to the API.
      if (sel.identity) {
        const persona = meaningfulStr(data.persona);
        const description = meaningfulStr(data.description);
        if (persona !== undefined || description !== undefined) {
          await fetch(`/api/agents/${agent.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(persona !== undefined && { persona }),
              ...(description !== undefined && { description }),
            }),
          });
        }
      }
      // System Prompt: instructions body.
      if (sel.system && typeof data.claudeMd === 'string') {
        await fetch(`/api/agents/${agent.id}/claude-md`, {
          method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: data.claudeMd,
        });
      }
      // Skills: upsert each.
      if (sel.skills && Array.isArray(data.skills)) {
        await Promise.all(data.skills.map(s =>
          fetch(`/api/agents/${agent.id}/skills?noSnapshot=1`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s),
          })
        ));
      }
      // Memories: create each (POST upserts by name).
      if (sel.memory && Array.isArray(data.memories)) {
        await Promise.all(data.memories.map(m =>
          fetch(`/api/agents/${agent.id}/memories`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: m.type, name: m.name, content: m.content }),
          })
        ));
      }
      const updated = await fetch(`/api/agents/${agent.id}`).then(r => r.json());
      onAgentUpdate(updated);
      setImportPreview(null);
      window.dispatchEvent(new Event('slackhive:sidebar-refresh'));
    } finally { setImporting(false); }
  };

  // The "Import JSON" tab body for the import modal (file picker → part chooser).
  const jsonPanel = (() => {
    if (!importPreview) {
      return (
        <div className="px-6 py-7">
          <div className="rounded-xl border-2 border-dashed border-border px-5 py-10 text-center">
            <Upload size={26} className="mx-auto block text-muted-foreground" />
            <p className="mb-1 mt-3 text-base font-semibold text-foreground">Import an exported config</p>
            <p className="mb-4 text-xs text-muted-foreground">Choose a <code>.json</code> file exported from an agent — you’ll pick which parts to apply.</p>
            <button onClick={() => fileInputRef.current?.click()} className="cursor-pointer rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Choose file</button>
            {importError && <p className="mt-3.5 text-xs text-red">{importError}</p>}
          </div>
        </div>
      );
    }
    const hasIdentity = meaningfulStr(importPreview.persona) !== undefined || meaningfulStr(importPreview.description) !== undefined;
    const hasMd = typeof importPreview.claudeMd === 'string';
    const nSkills = importPreview.skills?.length ?? 0;
    const nMems = importPreview.memories?.length ?? 0;
    const none = !(importSel.identity && hasIdentity) && !(importSel.system && hasMd) && !(importSel.skills && nSkills) && !(importSel.memory && nMems);
    const row = (sel: boolean, onToggle: () => void, disabled: boolean, label: string, sub: string) => (
      <label className={cn('flex items-start gap-2.5 rounded-[9px] border border-border px-3 py-[11px]', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', sel && !disabled ? 'bg-secondary' : 'bg-card')}>
        <input type="checkbox" checked={sel} disabled={disabled} onChange={onToggle} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" />
        <div><div className="text-sm font-medium text-foreground">{label}</div><div className="mt-px text-2xs text-muted-foreground">{sub}</div></div>
      </label>
    );
    return (
      <div className="px-6 py-5">
        <p className="mb-3.5 text-xs leading-normal text-muted-foreground">
          Choose what to import{importPreview.exportedAt ? ` (exported ${new Date(importPreview.exportedAt).toLocaleDateString()})` : ''}. Selected parts overwrite current content; the system prompt is snapshotted before it&apos;s replaced.
        </p>
        <div className="mb-[18px] flex flex-col gap-2">
          {row(importSel.identity && hasIdentity, () => setImportSel(s => ({ ...s, identity: !s.identity })), !hasIdentity, 'Identity', hasIdentity ? 'Replaces persona & description' : 'Not in this file')}
          {row(importSel.system && hasMd, () => setImportSel(s => ({ ...s, system: !s.system })), !hasMd, 'System Prompt', hasMd ? 'Replaces the current instructions' : 'Not in this file')}
          {row(importSel.skills && nSkills > 0, () => setImportSel(s => ({ ...s, skills: !s.skills })), nSkills === 0, 'Skills', nSkills > 0 ? `${nSkills} skill${nSkills !== 1 ? 's' : ''} upserted` : 'Not in this file')}
          {row(importSel.memory && nMems > 0, () => setImportSel(s => ({ ...s, memory: !s.memory })), nMems === 0, 'Memories', nMems > 0 ? `${nMems} memor${nMems !== 1 ? 'ies' : 'y'} added` : 'Not in this file')}
        </div>
        <div className="flex gap-2.5">
          <PrimaryBtn onClick={async () => { await applyImport(); setPersonaLibOpen(false); }} loading={importing}>{none ? 'Select something' : 'Import'}</PrimaryBtn>
          <GhostBtn onClick={() => { setImportPreview(null); setImportError(''); }}>Choose another file</GhostBtn>
        </div>
      </div>
    );
  })();

  return (
    <div className="fade-up">
      <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />


      {/* ── Export: choose which parts to include ────────────────────── */}
      {exportOpen && (() => {
        const none = !exportSel.identity && !exportSel.system && !exportSel.skills && !exportSel.memory;
        const row = (sel: boolean, onToggle: () => void, label: string, sub: string) => (
          <label className={cn('flex cursor-pointer items-start gap-2.5 rounded-[9px] border border-border px-3 py-[11px]', sel ? 'bg-secondary' : 'bg-card')}>
            <input type="checkbox" checked={sel} onChange={onToggle} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" />
            <div><div className="text-sm font-medium text-foreground">{label}</div><div className="mt-px text-2xs text-muted-foreground">{sub}</div></div>
          </label>
        );
        return (
          <Portal>
            <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 backdrop-blur-sm" onClick={() => setExportOpen(false)}>
              <div className="w-[90%] max-w-[460px] rounded-[14px] bg-card px-7 py-[26px] shadow-lg" onClick={e => e.stopPropagation()}>
                <h3 className="mb-1.5 text-md font-bold tracking-[-0.02em] text-foreground">Export agent config</h3>
                <p className="mb-4 text-xs leading-normal text-muted-foreground">Choose what to include in the downloaded JSON.</p>
                <div className="mb-5 flex flex-col gap-2">
                  {row(exportSel.identity, () => setExportSel(s => ({ ...s, identity: !s.identity })), 'Identity', 'Persona & description')}
                  {row(exportSel.system, () => setExportSel(s => ({ ...s, system: !s.system })), 'System Prompt', 'The agent instructions')}
                  {row(exportSel.skills, () => setExportSel(s => ({ ...s, skills: !s.skills })), 'Skills', 'All skill files')}
                  {row(exportSel.memory, () => setExportSel(s => ({ ...s, memory: !s.memory })), 'Memories', 'Learned memories')}
                </div>
                <div className="flex gap-2.5">
                  <PrimaryBtn onClick={doExport} loading={exporting}>{none ? 'Select something' : 'Download'}</PrimaryBtn>
                  <GhostBtn onClick={() => setExportOpen(false)}>Cancel</GhostBtn>
                </div>
              </div>
            </div>
          </Portal>
        );
      })()}

      {/* ── Persona Library modal ────────────────────────────────────── */}
      {personaLibOpen && (
        <PersonaLibraryModal
          agentId={agent.id}
          tab={libTab}
          onTabChange={setLibTab}
          jsonPanel={jsonPanel}
          fileInputRef={fileInputRef}
          applying={libApplying}
          search={libSearch}
          onSearchChange={setLibSearch}
          category={libCategory}
          onCategoryChange={setLibCategory}
          selected={libSelected}
          onSelectPersona={(p) => {
            setLibSelected(p);
            setLibSkillSel(new Set(p.skills.map(s => s.filename)));
          }}
          onBack={() => setLibSelected(null)}
          skillSel={libSkillSel}
          onToggleSkill={(fn) => setLibSkillSel(prev => {
            const next = new Set(prev);
            if (next.has(fn)) next.delete(fn); else next.add(fn);
            return next;
          })}
          onImportFull={async (template) => {
            setLibApplying(true);
            try {
              const existing = await fetch(`/api/agents/${agent.id}/skills`).then(r => r.json());
              await Promise.all((existing as { id: string }[]).map(s =>
                fetch(`/api/agents/${agent.id}/skills/${s.id}?noSnapshot=1`, { method: 'DELETE' })
              ));
              await applyImport({
                version: 1,
                persona: template.persona,
                description: template.description,
                claudeMd: template.claudeMd,
                skills: template.skills,
              }, { identity: true, system: true, skills: true, memory: false });
            } finally {
              setLibApplying(false);
              setPersonaLibOpen(false);
              setLibSelected(null);
            }
          }}
          onImportSkills={async (template, selected) => {
            setLibApplying(true);
            try {
              const skills = template.skills.filter(s => selected.has(s.filename));
              await Promise.all(skills.map(s =>
                fetch(`/api/agents/${agent.id}/skills?noSnapshot=1`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s),
                })
              ));
              const updated = await fetch(`/api/agents/${agent.id}`).then(r => r.json());
              onAgentUpdate(updated);
              window.dispatchEvent(new Event('slackhive:sidebar-refresh'));
            } finally {
              setLibApplying(false);
              setPersonaLibOpen(false);
              setLibSelected(null);
            }
          }}
          onClose={() => { setPersonaLibOpen(false); setLibSelected(null); setLibSearch(''); setLibCategory('all'); }}
        />
      )}

      <div className="grid w-full max-w-[1480px] items-start gap-5 xl:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="rounded-lg border border-border bg-card p-2 shadow-card xl:sticky xl:top-4">
          <div className="px-2.5 pb-2 pt-1.5">
            <div className="text-sm font-semibold text-foreground">Instruction surfaces</div>
            <div className="mt-0.5 text-2xs text-muted-foreground">Prompt, capabilities, and remembered context.</div>
          </div>
          {([
            { id: 'system' as const, label: 'System Prompt', Icon: FileText, sub: agent.isBoss ? 'Generated roster prompt' : 'Core behavior and rules' },
            { id: 'skills' as const, label: 'Skills', Icon: Sparkles, sub: 'On-demand workflows' },
            { id: 'memory' as const, label: 'Memory', Icon: Database, sub: 'Learned facts' },
          ]).map(s => (
            <button key={s.id} onClick={() => setSection(s.id)} className={cn(
              'flex w-full cursor-pointer items-start gap-2.5 rounded-md border-none bg-transparent px-2.5 py-2.5 text-left transition-colors',
              section === s.id ? 'bg-muted text-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}>
              <s.Icon size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{s.label}</span>
                <span className="mt-0.5 block text-2xs text-muted-foreground">{s.sub}</span>
              </span>
            </button>
          ))}
          {importError && <div className="mt-2 rounded-md border border-red/25 bg-red/10 px-2.5 py-2 text-2xs text-red">{importError}</div>}
        </aside>

        <div className="min-w-0">
          {section === 'system' && <ClaudeMdSection agentId={agent.id} canEdit={canEdit && !agent.isBoss} updatedAt={agent.updatedAt} />}
          {section === 'skills' && <SkillsTab agentId={agent.id} canEdit={canEdit} agentName={agent.name} agentPersona={agent.persona ?? ''} agentDescription={agent.description ?? ''} />}
          {section === 'memory' && <MemorySection agentId={agent.id} canEdit={canEdit} />}
        </div>
      </div>
    </div>
  );
}

/** Pill-style segmented switcher (System Prompt · Skills · Memory). */
/** Labeled action button (icon + text) — used for the Instructions toolbar so
 *  Coach / Export / Persona Library aren't hidden behind bare icons. */
function ActionBtn({ icon, label, onClick, loading, primary, subtle }: { icon: React.ReactNode; label: string; onClick?: () => void; loading?: boolean; primary?: boolean; subtle?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading} className={cn(
      'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60',
      primary ? 'border border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/90'
        : subtle ? 'border border-border bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground'
        : 'border border-border bg-card text-foreground hover:bg-secondary',
    )}>
      {loading ? <Loader2 size={13} className="animate-spin" /> : icon}
      {label}
    </button>
  );
}

function ClaudeMdSection({ agentId, canEdit, updatedAt }: { agentId: string; canEdit: boolean; updatedAt?: Date | string }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<'edit' | 'preview'>('preview');

  const refetch = () => {
    setLoading(true);
    fetch(`/api/agents/${agentId}/claude-md`)
      .then(r => r.text())
      .then(t => { setContent(t); setDirty(false); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { refetch(); }, [agentId]);

  // Re-fetch when Coach applies / finishes bootstrapping, but don't clobber
  // a user's in-flight edits.
  useEffect(() => {
    const h = () => { if (!dirty) refetch(); };
    window.addEventListener('slackhive:instructions-refresh', h);
    return () => window.removeEventListener('slackhive:instructions-refresh', h);
  }, [agentId, dirty]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/claude-md`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content,
      });
      if (!res.ok) throw new Error(await res.text());
      setDirty(false);
      setMsg('Saved');
      setTimeout(() => setMsg(''), 3000);
    } catch (e: any) {
      setMsg(`Error: ${e.message}`);
    } finally { setSaving(false); }
  };

  if (loading) return <p className="text-base text-muted-foreground">Loading...</p>;
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;
  const updatedLabel = updatedAt ? new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never';

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-base font-semibold tracking-normal text-foreground">System Prompt</h2>
            {dirty && <span className="rounded border border-amber/30 bg-amber/10 px-1.5 py-0.5 text-2xs font-medium text-amber">Unsaved</span>}
            {msg && <span className={cn('text-2xs font-medium', msg.startsWith('Error') ? 'text-red' : 'text-green')}>{msg}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
            <span>Updated {updatedLabel}</span>
            <span>{wordCount.toLocaleString()} words</span>
            <span>{content.length.toLocaleString()} characters</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canEdit && view === 'edit' && dirty && (
            <button onClick={save} disabled={saving} className={cn(
              'rounded-md bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground',
              saving ? 'cursor-not-allowed' : 'cursor-pointer',
            )}>{saving ? 'Saving...' : 'Save'}</button>
          )}
          <div className="inline-flex gap-0.5 rounded-md border border-border bg-muted p-0.5">
            {(['edit', 'preview'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} className={cn(
                'cursor-pointer rounded px-3 py-1.5 text-xs transition-colors',
                view === v ? 'bg-card font-semibold text-foreground shadow-sm' : 'bg-transparent font-medium text-muted-foreground hover:text-foreground',
              )}>{v === 'edit' ? 'Edit' : 'Preview'}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-muted/35">
        {view === 'edit' ? (
          <textarea
            value={content}
            onChange={e => { setContent(e.target.value); setDirty(true); }}
            readOnly={!canEdit}
            placeholder="Write the agent's core instructions here — rules, workflows, response style..."
            className="box-border block h-[68vh] min-h-[540px] w-full resize-none border-none bg-card px-5 py-5 font-mono text-[13px] leading-7 text-foreground outline-none"
          />
        ) : (
          <div className="box-border h-[68vh] min-h-[540px] overflow-auto px-6 py-8">
            <PromptMarkdownView>{content}</PromptMarkdownView>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Skills ───────────────────────────────────────────────────────────────────

function SkillsTab({ agentId, canEdit, agentName, agentPersona, agentDescription }: { agentId: string; canEdit: boolean; agentName: string; agentPersona: string; agentDescription: string }) {
  const [skills, setSkills]         = useState<Skill[]>([]);
  const [selected, setSelected]     = useState<Skill | null>(null);
  const [content, setContent]       = useState('');
  const [skillView, setSkillView]   = useState<'edit' | 'preview'>('preview');
  const [description, setDescription] = useState('');
  const [descModal, setDescModal]   = useState(false);
  const [descDraft, setDescDraft]   = useState('');
  // Description value at the moment Regenerate was clicked. We only end the
  // loader when polling brings in a description that differs from this — the
  // old code ended on any truthy description, so the spinner flickered off
  // before the runner had even started summarizing.
  const [regenBaseline, setRegenBaseline] = useState<string | null>(null);
  const [saving, setSaving]         = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [msg, setMsg]               = useState('');
  const [showNew, setShowNew]       = useState(false);
  const [newSkill, setNewSkill]     = useState({ category: '', filename: '', content: '' });

  const load = () =>
    fetch(`/api/agents/${agentId}/skills`).then(r => r.json()).then((next: Skill[]) => {
      setSkills(next);
      // Keep the selected skill's description in sync if the runner just
      // filled it in via summarize. Without this, the input shows the stale
      // value from the moment the user clicked into the file.
      setSelected(prev => {
        if (!prev || prev.id === '__identity__') return prev;
        const fresh = next.find(s => s.id === prev.id);
        if (fresh && fresh.description !== prev.description) {
          setDescription(fresh.description ?? '');
          return fresh;
        }
        return prev;
      });
    });

  useEffect(() => { load(); }, [agentId]);

  // Re-fetch when Coach applies / finishes bootstrapping.
  useEffect(() => {
    const h = () => load();
    window.addEventListener('slackhive:instructions-refresh', h);
    return () => window.removeEventListener('slackhive:instructions-refresh', h);
  }, [agentId]);

  // Light polling so a freshly-saved or regenerating skill picks up the
  // description the runner just summarized. Polls while the selected skill
  // has no description OR a regenerate is in flight; stops once filled.
  useEffect(() => {
    if (!selected || selected.id === '__identity__') return;
    if (selected.description && !regenerating) return;
    const t = setInterval(load, 1_500);
    return () => clearInterval(t);
  }, [selected?.id, selected?.description, regenerating]);

  // When polling brings in a fresh description that's actually new (not the
  // pre-click value), end the regenerating state and seed the modal draft.
  useEffect(() => {
    if (!regenerating) return;
    if (!selected?.description) return;
    if (selected.description === regenBaseline) return; // still old value
    setRegenerating(false);
    setRegenBaseline(null);
    if (descModal) setDescDraft(selected.description);
  }, [selected?.description, regenerating, regenBaseline, descModal]);

  const select = (s: Skill) => {
    setSelected(s);
    setContent(s.content);
    setDescription(s.description ?? '');
    setDescModal(false);
  };

  const openDescModal = () => {
    setDescDraft(description);
    setDescModal(true);
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    // Content-only save. Description has its own PATCH path so a content edit
    // never wipes a description the runner just summarized.
    await fetch(`/api/agents/${agentId}/skills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: selected.category, filename: selected.filename,
        content, sortOrder: selected.sortOrder,
      }),
    });
    setSaving(false); setMsg('Saved'); setTimeout(() => setMsg(''), 2000); load();
  };

  const regenerate = async () => {
    if (!selected || selected.id === '__identity__') return;
    // Snapshot the current description so the polling effect can tell when
    // the runner has actually written a NEW value (vs just seeing the old
    // one on the next poll tick).
    setRegenBaseline(selected.description ?? '');
    setRegenerating(true);
    // Modal stays OPEN so the user has somewhere to watch the spinner and
    // can review the new draft before saving it. The second effect below
    // populates descDraft once the runner writes back.
    await fetch(`/api/agents/${agentId}/skills/${selected.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate: true }),
    });
    // Polling keeps `regenerating` true until the new description arrives.
  };

  const saveDescription = async () => {
    if (!selected || selected.id === '__identity__') return;
    const trimmed = descDraft.trim();
    await fetch(`/api/agents/${agentId}/skills/${selected.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: trimmed === '' ? null : trimmed }),
    });
    setDescription(trimmed);
    setDescModal(false);
    setMsg('Saved'); setTimeout(() => setMsg(''), 1500);
    load();
  };

  const remove = async (s: Skill) => {
    if (!confirm(`Delete ${s.category}/${s.filename}?`)) return;
    await fetch(`/api/agents/${agentId}/skills/${s.id}`, { method: 'DELETE' });
    if (selected?.id === s.id) { setSelected(null); setContent(''); }
    load();
  };

  const create = async () => {
    if (!newSkill.category || !newSkill.filename) return;
    await fetch(`/api/agents/${agentId}/skills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSkill),
    });
    setShowNew(false); setNewSkill({ category: '', filename: '', content: '' }); load();
  };

  // Virtual identity row — computed from agent fields, not stored in DB
  const identityVirtual: Skill = {
    id: '__identity__',
    agentId,
    category: '00-core',
    filename: 'identity.md',
    sortOrder: -1,
    content: [`# ${agentName}`, agentPersona, agentDescription].filter(Boolean).join('\n\n'),
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const grouped = skills.reduce<Record<string, Skill[]>>((acc, s) => {
    (acc[s.category] ??= []).push(s); return acc;
  }, {});

  const isIdentity = selected?.id === '__identity__';

  return (
    <div className="fade-up flex h-[580px] gap-3.5">
      {/* File tree */}
      <div className="flex w-[220px] shrink-0 flex-col overflow-auto rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Files
          </span>
          {canEdit && <button onClick={() => setShowNew(true)} className="cursor-pointer border-none bg-transparent text-xs text-primary">+ New</button>}
        </div>
        <div className="flex-1 overflow-auto p-1.5">
          {/* Virtual identity row — always first */}
          <div>
            <div className="px-1.5 pb-0.5 pt-1.5 font-mono text-2xs tracking-[0.02em] text-muted-foreground">00-core/</div>
            <div
              onClick={() => select(identityVirtual)}
              className={cn(
                'skill-row flex cursor-pointer items-center justify-between rounded-md px-2 py-[5px] font-mono text-xs transition-colors',
                selected?.id === '__identity__' ? 'bg-blue/10 text-primary' : 'bg-transparent text-muted-foreground hover:bg-secondary',
              )}
            >
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">identity.md</span>
              <span className="shrink-0 text-[9px] text-muted-foreground">locked</span>
            </div>
          </div>
          {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([cat, catSkills]) => (
            <div key={cat}>
              <div className="px-1.5 pb-0.5 pt-1.5 font-mono text-2xs tracking-[0.02em] text-muted-foreground">{cat}/</div>
              {catSkills.map(s => (
                <div
                  key={s.id}
                  onClick={() => select(s)}
                  className={cn(
                    'skill-row group flex cursor-pointer items-center justify-between rounded-md px-2 py-[5px] font-mono text-xs transition-colors',
                    selected?.id === s.id ? 'bg-blue/10 text-primary' : 'bg-transparent text-muted-foreground hover:bg-secondary',
                  )}
                >
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">{s.filename}</span>
                  {canEdit && <button
                    onClick={e => { e.stopPropagation(); remove(s); }}
                    className="delete-btn shrink-0 cursor-pointer border-none bg-transparent px-0.5 text-base leading-none text-red opacity-0 transition-opacity group-hover:opacity-100"
                  >×</button>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
        {selected ? (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary px-4 py-2.5">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {selected.category}/{selected.filename}
                </span>
                {isIdentity && <span className="rounded-sm bg-muted px-1.5 py-px text-2xs text-muted-foreground">read-only · edit in Overview</span>}
                {!isIdentity && (
                  <button
                    onClick={openDescModal}
                    disabled={!canEdit && !description}
                    title={
                      regenerating ? 'Regenerating with AI…'
                        : description ? description
                        : (canEdit ? 'Add a "when to use" description' : 'No description')
                    }
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-sm border-none bg-muted px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.04em] text-muted-foreground',
                      canEdit ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
                    )}
                  >
                    {regenerating && (
                      <span
                        aria-label="Regenerating"
                        className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-border border-t-foreground"
                        style={{ animation: 'spin 0.8s linear infinite' }}
                      />
                    )}
                    desc
                  </button>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <div className="inline-flex gap-0.5 rounded-[7px] bg-muted p-0.5">
                  {(['edit', 'preview'] as const).map(v => (
                    <button key={v} onClick={() => setSkillView(v)} className={cn(
                      'cursor-pointer rounded-[5px] px-2.5 py-[3px] text-2xs',
                      skillView === v ? 'bg-card font-semibold text-foreground' : 'bg-transparent font-normal text-muted-foreground',
                    )}>{v === 'edit' ? 'Edit' : 'Preview'}</button>
                  ))}
                </div>
                {msg && <span className="text-2xs text-green">{msg}</span>}
                {canEdit && !isIdentity && skillView === 'edit' && <button
                  onClick={save} disabled={saving}
                  className={cn(
                    'rounded-md border-none px-3.5 py-[5px] text-xs font-medium text-primary-foreground',
                    saving ? 'cursor-not-allowed bg-border' : 'cursor-pointer bg-primary',
                  )}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>}
              </div>
            </div>
            {skillView === 'edit' ? (
              <textarea
                value={isIdentity ? identityVirtual.content : content}
                onChange={e => { if (!isIdentity) setContent(e.target.value); }}
                readOnly={!canEdit || isIdentity}
                className="flex-1 resize-none border-none bg-transparent p-4 font-mono text-xs leading-[1.65] text-foreground caret-primary outline-none"
                spellCheck={false}
              />
            ) : (
              <div className="flex-1 overflow-auto px-[18px] py-4">
                <MarkdownView>{isIdentity ? identityVirtual.content : content}</MarkdownView>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a file to edit
          </div>
        )}
      </div>

      {/* New skill modal */}
      {showNew && (
        <Modal title="New Skill File" onClose={() => setShowNew(false)}>
          <Field label="Category" value={newSkill.category}
            onChange={v => setNewSkill(s => ({ ...s, category: v }))} hint="e.g. 00-core" />
          <Field label="Filename" value={newSkill.filename}
            onChange={v => setNewSkill(s => ({ ...s, filename: v }))} hint="e.g. api-design.md" />
          <TextArea label="Content (optional)" value={newSkill.content}
            onChange={v => setNewSkill(s => ({ ...s, content: v }))} rows={4} />
          <div className="mt-1 flex gap-2">
            <PrimaryBtn onClick={create}>Create</PrimaryBtn>
            <GhostBtn onClick={() => setShowNew(false)}>Cancel</GhostBtn>
          </div>
        </Modal>
      )}

      {/* Edit description modal */}
      {descModal && selected && (
        <Modal title={`Edit description — ${selected.filename}`} onClose={() => setDescModal(false)}>
          <div className="relative">
            <TextArea
              label="Description"
              value={descDraft}
              onChange={setDescDraft}
              rows={3}
              hint='Frame as a "when to use" trigger so the agent picks the right /command. e.g. "Use when filing a Notion bug ticket from a Slack investigation".'
            />
            {regenerating && (
              <div className="pointer-events-none absolute inset-x-0 bottom-8 top-6 flex items-center justify-center gap-2.5 rounded-md bg-black/35 text-sm font-medium text-foreground backdrop-blur-[2px]">
                <span
                  aria-label="Regenerating"
                  className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-border border-t-foreground"
                  style={{ animation: 'spin 0.8s linear infinite' }}
                />
                Regenerating with AI…
              </div>
            )}
          </div>
          <div className="mt-1 flex justify-between gap-2">
            <div className="flex gap-2">
              <PrimaryBtn onClick={saveDescription}>Save</PrimaryBtn>
              <GhostBtn onClick={() => setDescModal(false)}>Cancel</GhostBtn>
            </div>
            <GhostBtn onClick={regenerate}>{regenerating ? 'Regenerating…' : 'Regenerate with AI'}</GhostBtn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── MCPs ─────────────────────────────────────────────────────────────────────

function ToolsTab({ agentId, canEdit, canManageMcps, currentUsername }: { agentId: string; canEdit: boolean; canManageMcps: boolean; currentUsername: string }) {
  // Connected Apps (MCP servers). Capabilities (internet/shell) moved to Settings.
  return (
    <div className="fade-up">
      <McpsSection agentId={agentId} canEdit={canEdit} canManageMcps={canManageMcps} currentUsername={currentUsername} />
    </div>
  );
}

/** Transport → icon. stdio = local process, http/sse = remote endpoints. */
function mcpTypeIcon(type: McpServer['type']) {
  return type === 'stdio' ? Terminal : type === 'http' ? Globe : Radio;
}

function McpsSection({ agentId, canEdit, canManageMcps, currentUsername }: { agentId: string; canEdit: boolean; canManageMcps: boolean; currentUsername: string }) {
  const [all, setAll]           = useState<McpServer[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  // Snapshot of what's persisted, so we can show a Save bar only when the
  // local selection diverges (Connect/Disconnect is optimistic; persisting
  // triggers an agent reload, so we batch rather than save per-toggle).
  const [initial, setInitial]   = useState<Set<string>>(new Set());
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState('');
  // Tracks the initial fetch so the empty-state doesn't flash before data.
  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      fetch('/api/mcps').then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
      fetch(`/api/agents/${agentId}/mcps`).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
    ]).then(([a, b]: [McpServer[], McpServer[]]) => {
      if (cancelled) return;
      const ids = new Set(b.map(m => m.id));
      setAll(a); setAssigned(ids); setInitial(new Set(ids));
    }).catch(err => {
      if (cancelled) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [agentId]);

  const toggle = (id: string) =>
    setAssigned(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const dirty = assigned.size !== initial.size || [...assigned].some(id => !initial.has(id));

  const save = async () => {
    setSaving(true);
    try {
      await fetch(`/api/agents/${agentId}/mcps`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpIds: [...assigned] }),
      });
      setInitial(new Set(assigned));
      setMsg('Saved · agent will reload');
      setTimeout(() => setMsg(''), 3500);
    } finally {
      setSaving(false);
    }
  };

  const connected = all.filter(m => assigned.has(m.id));
  const available = all.filter(m => !assigned.has(m.id));

  const Badge = ({ children }: { children: React.ReactNode }) => (
    <span className="whitespace-nowrap rounded-[5px] border border-border bg-secondary px-1.5 py-px font-mono text-2xs font-semibold leading-normal tracking-[0.03em] text-muted-foreground">{children}</span>
  );

  const renderCard = (mcp: McpServer, isConn: boolean) => {
    const Icon = mcpTypeIcon(mcp.type);
    const canAssign = canManageMcps || mcp.createdBy === currentUsername;
    const actionable = canEdit && canAssign && mcp.enabled;
    return (
      <div key={mcp.id} className={cn(
        'overflow-hidden rounded-[14px] border border-border',
        isConn ? 'bg-secondary' : 'bg-card',
        mcp.enabled ? 'opacity-100' : 'opacity-60',
      )}>
        <div className="flex items-start gap-[13px] p-4">
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] border border-border bg-card text-foreground">
            <Icon size={20} />
            {isConn && (
              <span className="absolute -bottom-[5px] -right-[5px] flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-secondary bg-primary text-primary-foreground"><Check size={11} strokeWidth={3} /></span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-[7px]">
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-base font-semibold text-foreground">{mcp.name}</span>
                  <Badge>MCP</Badge>
                  <Badge>{mcp.type.toUpperCase()}</Badge>
                </div>
              </div>
              {canEdit && (
                actionable ? (
                  <button onClick={() => toggle(mcp.id)} className={cn(
                    'inline-flex shrink-0 cursor-pointer items-center gap-[5px] rounded-lg border px-3 py-[5px] text-xs font-medium',
                    isConn ? 'border-border bg-card text-foreground' : 'border-primary bg-primary text-primary-foreground',
                  )}>
                    {isConn ? <><X size={13} />Disconnect</> : <><Plus size={13} />Connect</>}
                  </button>
                ) : (
                  <span className="max-w-[130px] shrink-0 text-right text-2xs text-muted-foreground">
                    {!mcp.enabled ? 'Disabled in catalog' : 'Owner/admin only'}
                  </span>
                )
              )}
            </div>
            {mcp.description && (
              <p className="mt-[7px] line-clamp-2 text-xs leading-normal text-muted-foreground">{mcp.description}</p>
            )}
          </div>
        </div>
        <div className={cn(
          'flex items-center gap-[7px] border-t border-border px-4 py-[9px] text-2xs',
          isConn ? 'font-semibold text-green' : 'font-normal text-muted-foreground',
        )}>
          <span className={cn('h-[7px] w-[7px] shrink-0 rounded-full', isConn ? 'bg-green' : 'bg-muted-foreground')} />
          {isConn ? 'Connected' : 'Not connected'}
        </div>
      </div>
    );
  };

  const SectionHead = ({ label, count }: { label: string; count: number }) => (
    <div className="mb-3 flex items-center gap-2">
      <h3 className="text-base font-semibold text-foreground">{label}</h3>
      <span className="rounded-full border border-border bg-secondary px-2 text-2xs font-semibold leading-[18px] text-muted-foreground">{count}</span>
    </div>
  );

  const colEmpty = (text: string) => (
    <div className="rounded-[14px] border border-dashed border-border px-4 py-7 text-center text-xs text-muted-foreground">{text}</div>
  );

  return (
    <div className="fade-up">
      {/* Header */}
      <div className="mb-[22px] flex flex-wrap items-start justify-between gap-3.5">
        <div className="min-w-0">
          <h2 className="mb-1 text-xl font-semibold tracking-[-0.01em] text-foreground">Tools</h2>
          <p className="max-w-[560px] text-sm leading-normal text-muted-foreground">
            Connect external systems and MCP servers that this agent can use.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
          {canEdit && dirty && <PrimaryBtn onClick={save} loading={saving}>Save changes</PrimaryBtn>}
          <Link href="/settings/mcps" className="inline-flex items-center gap-[7px] rounded-lg border border-border bg-card px-3 py-[7px] text-xs font-medium text-foreground no-underline">Browse MCP Catalog <ExternalLink size={13} /></Link>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> Loading tools…
        </div>
      ) : loadError ? (
        <div className="rounded-xl bg-destructive/10 px-5 py-4 text-sm text-destructive">
          Couldn't load MCP servers: {loadError}
        </div>
      ) : all.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-border px-5 py-10 text-center text-sm text-muted-foreground">
          No MCP servers in the catalog yet.{' '}
          <Link href="/settings/mcps" className="font-medium text-foreground">Add one →</Link>
        </div>
      ) : (
        <div className="grid items-start gap-7 [grid-template-columns:repeat(auto-fit,minmax(360px,1fr))]">
          <div>
            <SectionHead label="Connected Tools" count={connected.length} />
            <div className="flex flex-col gap-3">
              {connected.length ? connected.map(m => renderCard(m, true)) : colEmpty('No tools connected yet — connect one from the right.')}
            </div>
          </div>
          <div>
            <SectionHead label="Available Tools" count={available.length} />
            <div className="flex flex-col gap-3">
              {available.length ? available.map(m => renderCard(m, false)) : colEmpty('All catalog tools are connected.')}
            </div>
          </div>
        </div>
      )}

      {/* What are tools? */}
      <div className="mt-7 flex flex-wrap items-start gap-3.5 rounded-[14px] border border-border bg-secondary px-[18px] py-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground"><Plug size={18} /></div>
        <div className="min-w-[220px] flex-1">
          <div className="mb-[3px] text-sm font-semibold text-foreground">What are tools?</div>
          <p className="text-xs leading-[1.55] text-muted-foreground">
            Tools let this agent securely access external systems and data through MCP (Model Context Protocol) servers —
            querying databases, calling APIs, or running integrations. Connect the ones it needs; changes take effect on its next reload.
          </p>
        </div>
        <Link href="/settings/mcps" className="inline-flex shrink-0 items-center gap-1.5 self-center rounded-lg border border-border bg-card px-3 py-[7px] text-xs font-medium text-foreground no-underline">Learn more <ExternalLink size={13} /></Link>
      </div>
    </div>
  );
}

// ─── Permissions ──────────────────────────────────────────────────────────────

const BASE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
const INTERNET_TOOLS = ['WebSearch', 'WebFetch'];
const SHELL_TOOLS = ['Bash'];

function PermissionsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [allowed, setAllowed] = useState<string[]>([]);
  const [denied,  setDenied]  = useState<string[]>([]);
  const [saving,  setSaving]  = useState(false);
  const [msg,     setMsg]     = useState('');
  // Without a loading flag, the toggles render in their "off" state during
  // the round-trip and then flip on once data arrives — looks like the
  // setting is being changed under the user's feet.
  const [loading, setLoading] = useState(true);

  const internetOn = INTERNET_TOOLS.every(t => allowed.includes(t));
  const shellOn = SHELL_TOOLS.some(t => allowed.includes(t));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/agents/${agentId}/permissions`).then(r => r.json()).then((p: Permission) => {
      if (cancelled) return;
      setAllowed(p.allowedTools ?? []);
      setDenied(p.deniedTools ?? []);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [agentId]);

  const save = async (newAllowed: string[], newDenied: string[]) => {
    setSaving(true);
    await fetch(`/api/agents/${agentId}/permissions`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowedTools: newAllowed, deniedTools: newDenied }),
    });
    setSaving(false); setMsg('Saved'); setTimeout(() => setMsg(''), 2000);
  };

  const toggleCapability = (tools: string[], enable: boolean) => {
    let next = enable
      ? [...new Set([...allowed, ...tools])]
      : allowed.filter(t => !tools.includes(t));
    for (const t of BASE_TOOLS) { if (!next.includes(t)) next = [t, ...next]; }
    setAllowed(next);
    save(next, denied);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-1.5 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Loading capabilities…
      </div>
    );
  }

  return (
    <div>
      <div>
        {/* Internet Access */}
        <div className="flex items-center justify-between border-b border-border pb-3.5 pt-0.5">
          <div>
            <div className="text-sm font-medium text-foreground">Internet Access</div>
            <div className="mt-0.5 text-2xs text-muted-foreground">
              Web search and fetch
            </div>
          </div>
          <label className="relative inline-block h-[22px] w-10 shrink-0">
            <input type="checkbox" checked={internetOn} disabled={!canEdit}
              onChange={e => toggleCapability(INTERNET_TOOLS, e.target.checked)}
              className="h-0 w-0 opacity-0" />
            <span className={cn(
              'absolute inset-0 rounded-full transition-colors',
              internetOn ? 'bg-green' : 'bg-border',
              canEdit ? 'cursor-pointer' : 'cursor-default',
            )}>
              <span className="absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-[left]" style={{ left: internetOn ? 21 : 3 }} />
            </span>
          </label>
        </div>

        {/* Shell Access */}
        <div className="flex items-center justify-between pb-0.5 pt-3.5">
          <div>
            <div className="text-sm font-medium text-foreground">Shell Access</div>
            <div className="mt-0.5 text-2xs text-muted-foreground">
              Terminal commands (dangerous commands auto-blocked)
            </div>
          </div>
          <label className="relative inline-block h-[22px] w-10 shrink-0">
            <input type="checkbox" checked={shellOn} disabled={!canEdit}
              onChange={e => toggleCapability(SHELL_TOOLS, e.target.checked)}
              className="h-0 w-0 opacity-0" />
            <span className={cn(
              'absolute inset-0 rounded-full transition-colors',
              shellOn ? 'bg-green' : 'bg-border',
              canEdit ? 'cursor-pointer' : 'cursor-default',
            )}>
              <span className="absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-[left]" style={{ left: shellOn ? 21 : 3 }} />
            </span>
          </label>
        </div>
      </div>
      {msg && <div className="mt-2.5 text-xs text-green">{msg}</div>}
    </div>
  );
}

// ─── Memory ───────────────────────────────────────────────────────────────────

const MEM_TYPE_STYLE: Record<string, string> = {
  user:      'bg-purple-500/10 text-purple-500',
  feedback:  'bg-blue/10 text-blue',
  project:   'bg-amber/10 text-amber',
  reference: 'bg-green/10 text-green',
};

function MemorySection({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    return fetch(`/api/agents/${agentId}/memories`)
      .then(r => r.json())
      .then(setMemories)
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [agentId]);
  useEffect(() => {
    fetch(`/api/agents/${agentId}/groups`)
      .then(r => r.json())
      .then(d => setGroups(d.groups ?? []))
      .catch(() => setGroups([]));
  }, [agentId]);

  const groupName = (id: string) => groups.find(g => g.id === id)?.name ?? 'group';

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete memory "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/agents/${agentId}/memories/${id}`, { method: 'DELETE' });
    load();
  };

  /** Re-upsert a memory with patched tier fields (pin / scope). */
  const patch = async (m: Memory, changes: { pinned?: boolean; scopeUserId?: string | null; scopeGroupId?: string | null }) => {
    await fetch(`/api/agents/${agentId}/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: m.type, name: m.name, content: m.content,
        pinned: 'pinned' in changes ? changes.pinned : m.pinned,
        scopeUserId: 'scopeUserId' in changes ? changes.scopeUserId : m.scopeUserId,
        scopeGroupId: 'scopeGroupId' in changes ? changes.scopeGroupId : m.scopeGroupId,
      }),
    });
    load();
  };

  const onScopeChange = (m: Memory, value: string) => {
    if (value === 'global') return patch(m, { scopeUserId: null, scopeGroupId: null });
    if (value.startsWith('group:')) return patch(m, { scopeUserId: null, scopeGroupId: value.slice(6) });
  };

  const toggle = (id: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const grouped = memories.reduce<Record<string, Memory[]>>((acc, m) => {
    (acc[m.type] ??= []).push(m); return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-5 py-6 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Loading memories…
      </div>
    );
  }

  if (memories.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-border bg-card px-5 py-10 text-muted-foreground">
        <div className="mb-3 flex justify-center"><Brain size={32} className="text-muted-foreground/50" /></div>
        <p className="mb-0.5 mt-0 text-center text-md font-semibold text-foreground">
          No memories yet
        </p>
        <p className="m-0 max-w-[300px] text-center text-sm text-muted-foreground">
          The agent will automatically accumulate memories as it interacts in Slack.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-4">
      <div className="mb-3.5">
        <span className="text-sm text-muted-foreground">
          {memories.length} memor{memories.length === 1 ? 'y' : 'ies'}
        </span>
      </div>

      {(['feedback', 'user', 'project', 'reference'] as const).map(type => {
        const items = grouped[type];
        if (!items?.length) return null;
        const badge = MEM_TYPE_STYLE[type] ?? 'bg-muted text-muted-foreground';
        return (
          <div key={type} className="mb-5">
            <div className="mb-2 flex items-center gap-2">
              <span className={cn('rounded px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.06em]', badge)}>{type}</span>
              <span className="text-2xs text-muted-foreground">{items.length}</span>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              {items.map((m, i) => (
                <div key={m.id} className={cn(i < items.length - 1 && 'border-b border-border')}>
                  <div className="flex cursor-pointer items-center justify-between px-3.5 py-2.5" onClick={() => toggle(m.id)}>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="text-2xs text-muted-foreground">
                        {expanded.has(m.id) ? '▼' : '▶'}
                      </span>
                      <span className="truncate font-mono text-sm font-medium text-foreground">
                        {m.name}
                      </span>
                      {m.pinned && (
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.04em] text-amber-600 dark:text-amber-400">Pinned</span>
                      )}
                      {m.scopeUserId && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground" title={`Only for user ${m.scopeUserId}`}>User</span>
                      )}
                      {m.scopeGroupId && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground" title="Only for this group">{groupName(m.scopeGroupId)}</span>
                      )}
                      {m.source === 'reflection' && (
                        <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-2xs font-medium text-blue-600 dark:text-blue-400" title={m.createdBy ? `Auto-learned from ${m.createdBy}'s conversation` : 'Auto-learned from a conversation'}>auto</span>
                      )}
                      {m.source === 'agent' && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground" title="Written by the agent">agent</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2.5">
                      <span className="text-2xs text-muted-foreground">
                        {new Date(m.updatedAt).toLocaleDateString()}
                      </span>
                      {canEdit && <button
                        onClick={e => { e.stopPropagation(); remove(m.id, m.name); }}
                        className="cursor-pointer border-none bg-transparent text-sm text-red opacity-50 transition-opacity hover:opacity-100"
                      >Delete</button>}
                    </div>
                  </div>
                  {expanded.has(m.id) && (
                    <div className="border-t border-border bg-muted">
                      <pre className="m-0 whitespace-pre-wrap px-3.5 py-3 font-mono text-2xs leading-relaxed text-muted-foreground">{m.content}</pre>
                      {canEdit && (
                        <div className="flex flex-wrap items-center gap-3 border-t border-border px-3.5 py-2.5 text-2xs">
                          <button
                            onClick={() => patch(m, { pinned: !m.pinned })}
                            className="cursor-pointer rounded border border-border bg-card px-2 py-1 font-medium text-foreground transition-colors hover:bg-accent"
                          >{m.pinned ? 'Unpin' : 'Pin (always remember)'}</button>
                          <label className="flex items-center gap-1.5 text-muted-foreground">
                            Scope
                            <select
                              value={m.scopeUserId ? 'user' : m.scopeGroupId ? `group:${m.scopeGroupId}` : 'global'}
                              onChange={e => onScopeChange(m, e.target.value)}
                              className="rounded border border-border bg-card px-1.5 py-1 text-foreground"
                            >
                              <option value="global">Everyone</option>
                              {m.scopeUserId && <option value="user" disabled>{`User ${m.scopeUserId}`}</option>}
                              {groups.map(g => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}
                            </select>
                          </label>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Wiki Tree ──────────────────────────────────────────────────────────────

type WikiArticle = { path: string; title: string; size: number };
type TreeNode = { name: string; path?: string; title?: string; size?: number; children: TreeNode[] };

function buildTree(articles: WikiArticle[]): TreeNode[] {
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
  // Sort: folders first, then files, alphabetical within each
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

const FOLDER_LABELS: Record<string, string> = {
  concepts: 'Concepts',
  entities: 'Entities',
  flows: 'Flows',
  modules: 'Modules',
};

function WikiTreeNode({ node, depth, onSelect, selected }: { node: TreeNode; depth: number; onSelect: (path: string) => void; selected: string | null }) {
  const [open, setOpen] = useState(true);
  const isFolder = !node.path && node.children.length > 0;
  const label = isFolder ? (FOLDER_LABELS[node.name] || node.name) : (node.title || node.name.replace('.md', ''));
  const isActive = node.path === selected;

  if (isFolder) {
    return (
      <div>
        <div onClick={() => setOpen(!open)}
          style={{ paddingLeft: 6 + depth * 12 }}
          className="flex cursor-pointer items-center gap-1 px-1.5 pb-0.5 pt-1.5 font-mono text-2xs tracking-[0.02em] text-muted-foreground">
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
      style={{ paddingLeft: 8 + depth * 12 }}
      className={cn(
        'flex cursor-pointer items-center gap-1 truncate rounded-md px-2 py-1 font-mono text-xs transition-colors',
        isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent',
      )}
    >
      <FileText size={12} className="shrink-0" />
      <span className="truncate">{node.name.replace('.md', '')}</span>
    </div>
  );
}

function WikiTree({ articles, onSelect, selected }: { articles: WikiArticle[]; onSelect: (path: string) => void; selected: string | null }) {
  const tree = buildTree(articles);
  return (
    <div className="flex-1 overflow-auto p-1.5">

      {tree.map(node => (
        <WikiTreeNode key={node.path || node.name} node={node} depth={0} onSelect={onSelect} selected={selected} />
      ))}
    </div>
  );
}

// ─── Knowledge (Wiki Folder Assignment) ─────────────────────────────────────

interface WikiFolder { id: string; name: string; description?: string; createdBy: string; createdAt: string; updatedAt: string; }
interface WikiSource  { id: string; status: string; wordCount: number; type: string; lastSynced?: string; }

type FolderStats = { sources: number; words: number; lastSynced: string | null };

function KnowledgeTab({ agentId, canEdit }: { agentId: string; agentSlug: string; canEdit: boolean }) {
  const [allFolders, setAllFolders] = useState<(WikiFolder & { assigned: boolean })[]>([]);
  const [stats, setStats]           = useState<Record<string, FolderStats>>({});
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/wiki-folders').then(r => r.json()) as Promise<WikiFolder[]>,
      fetch(`/api/agents/${agentId}/wiki-folders`).then(r => r.json()) as Promise<WikiFolder[]>,
    ]).then(([all, assigned]) => {
      const assignedIds = new Set(assigned.map((f: WikiFolder) => f.id));
      const merged = all.map(f => ({ ...f, assigned: assignedIds.has(f.id) }));
      setAllFolders(merged);
      // Per-folder counts come from each folder's sources (one fetch each).
      merged.forEach(f => {
        fetch(`/api/wiki-folders/${f.id}/sources`).then(r => r.ok ? r.json() : []).then((srcs: WikiSource[]) => {
          const words = srcs.reduce((s, x) => s + (x.wordCount || 0), 0);
          const lastSynced = srcs.reduce<string | null>((m, x) => (x.lastSynced && (!m || x.lastSynced > m) ? x.lastSynced : m), null);
          setStats(prev => ({ ...prev, [f.id]: { sources: srcs.length, words, lastSynced } }));
        }).catch(() => {});
      });
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [agentId]);

  async function toggle(folderId: string, currentlyAssigned: boolean) {
    setSaving(folderId);
    const updated = allFolders.map(f => f.id === folderId ? { ...f, assigned: !currentlyAssigned } : f);
    setAllFolders(updated);
    const newIds = updated.filter(f => f.assigned).map(f => f.id);
    const r = await fetch(`/api/agents/${agentId}/wiki-folders`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderIds: newIds }),
    });
    if (!r.ok) {
      setAllFolders(allFolders); // roll back optimistic update
      const err = await r.json().catch(() => ({}));
      alert(err.error ?? 'Failed to update wiki folder assignment');
    }
    setSaving(null);
  }

  const fmtWords = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const fmtSynced = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

  const assigned  = allFolders.filter(f => f.assigned);
  const available = allFolders.filter(f => !f.assigned);

  const renderCard = (f: WikiFolder & { assigned: boolean }) => {
    const st = stats[f.id];
    const busy = saving === f.id;
    return (
      <div key={f.id} className={cn('overflow-hidden rounded-xl border', f.assigned ? 'border-border bg-muted' : 'border-border bg-card')}>
        <div className="flex items-start gap-3 p-4">
          <Link href={`/knowledge?folder=${f.id}`} title={`Open ${f.name}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground no-underline">
            {f.assigned ? <FolderOpen size={20} /> : <Folder size={20} />}
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2.5">
              <div className="min-w-0">
                <Link href={`/knowledge?folder=${f.id}`} title={`Open ${f.name}`} className="block truncate text-base font-semibold text-foreground no-underline hover:underline">{f.name}</Link>
                <div className="mt-0.5 text-2xs text-muted-foreground">by {f.createdBy}</div>
              </div>
              {canEdit ? (
                <button onClick={() => toggle(f.id, f.assigned)} disabled={busy} className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-60',
                  busy ? 'cursor-not-allowed' : 'cursor-pointer',
                  f.assigned ? 'border-border bg-card text-foreground' : 'border-primary bg-primary text-primary-foreground',
                )}>
                  {f.assigned ? <><X size={13} />Unassign</> : <><Plus size={13} />Assign</>}
                </button>
              ) : null}
            </div>
            {f.description && (
              <p className="mt-2 line-clamp-2 text-xs leading-normal text-muted-foreground">{f.description}</p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-2xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><FileText size={12} /> {st ? `${st.sources} source${st.sources !== 1 ? 's' : ''}` : '—'}</span>
          <span className="text-border">·</span>
          <span>{st ? `${fmtWords(st.words)} words` : '—'}</span>
          {st?.lastSynced && (<><span className="text-border">·</span><span className="inline-flex items-center gap-1"><Clock size={12} /> synced {fmtSynced(st.lastSynced)}</span></>)}
          <span className={cn('ml-auto inline-flex items-center gap-1.5', f.assigned ? 'font-semibold text-green' : 'text-muted-foreground')}>
            <span className={cn('h-[7px] w-[7px] rounded-full', f.assigned ? 'bg-green' : 'bg-muted-foreground')} />
            {f.assigned ? 'Assigned' : 'Not assigned'}
          </span>
        </div>
      </div>
    );
  };

  const SectionHead = ({ label, count }: { label: string; count: number }) => (
    <div className="mb-3 flex items-center gap-2">
      <h3 className="m-0 text-base font-semibold text-foreground">{label}</h3>
      <span className="rounded-full border border-border bg-muted px-2 text-2xs font-semibold leading-[18px] text-muted-foreground">{count}</span>
    </div>
  );

  const colEmpty = (text: string) => (
    <div className="rounded-xl border border-dashed border-border px-4 py-7 text-center text-xs text-muted-foreground">{text}</div>
  );

  return (
    <div className="fade-up">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3.5">
        <div className="min-w-0">
          <h2 className="mb-0.5 mt-0 text-xl font-semibold tracking-tight text-foreground">Wiki</h2>
          <p className="m-0 max-w-[560px] text-sm leading-normal text-muted-foreground">
            Assign shared knowledge folders — the agent reads these wikis at compile time.
          </p>
        </div>
        <Link href="/knowledge" className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground no-underline">Knowledge Library <ExternalLink size={13} /></Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> Loading folders…
        </div>
      ) : allFolders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-5 py-10 text-center text-sm text-muted-foreground">
          No wiki folders exist yet.{' '}
          <Link href="/knowledge" className="font-medium text-foreground">Create one in the Knowledge Library →</Link>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] items-start gap-7">
          <div>
            <SectionHead label="Assigned" count={assigned.length} />
            <div className="flex flex-col gap-3">
              {assigned.length ? assigned.map(renderCard) : colEmpty('No folders assigned yet — assign one from the right.')}
            </div>
          </div>
          <div>
            <SectionHead label="Available" count={available.length} />
            <div className="flex flex-col gap-3">
              {available.length ? available.map(renderCard) : colEmpty('All folders are assigned.')}
            </div>
          </div>
        </div>
      )}

      {/* What is the wiki? */}
      <div className="mt-7 flex flex-wrap items-start gap-3.5 rounded-xl border border-border bg-muted px-4 py-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground"><BookOpen size={18} /></div>
        <div className="min-w-[220px] flex-1">
          <div className="mb-0.5 text-sm font-semibold text-foreground">What is the wiki?</div>
          <p className="m-0 text-xs leading-relaxed text-muted-foreground">
            Wiki folders are shared knowledge bases — docs, repos, and URLs — that the agent reads at compile time.
            Assign the folders this agent should know; edit folder contents in the Knowledge Library.
          </p>
        </div>
        <Link href="/knowledge" className="inline-flex shrink-0 items-center gap-1.5 self-center rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground no-underline">Learn more <ExternalLink size={13} /></Link>
      </div>
    </div>
  );

}

// ─── Logs ─────────────────────────────────────────────────────────────────────

type LogLevel = 'all' | 'debug' | 'info' | 'warn' | 'error';

interface ParsedLog {
  raw: string;
  level: LogLevel;
  time: string;
  message: string;
  fields: Record<string, string>;
}

function parseLine(raw: string): ParsedLog {
  const stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
  try {
    const obj = JSON.parse(stripped);
    const level: LogLevel =
      obj.level === 'error' || obj.level === 50 ? 'error' :
      obj.level === 'warn'  || obj.level === 40 ? 'warn'  :
      obj.level === 'debug' || obj.level === 20 ? 'debug' : 'info';
    const ts = obj.timestamp ? new Date(obj.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const rawMsg = obj.message ?? obj.msg ?? '';
    const msg = rawMsg.replace(/^(error|warn|info|debug|trace):\s*/i, '');
    const skip = new Set(['level', 'message', 'msg', 'timestamp', 'agent', 'service']);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!skip.has(k)) fields[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return { raw: stripped, level, time: ts, message: msg, fields };
  } catch {
    const lo = stripped.toLowerCase();
    const level: LogLevel =
      lo.includes('"level":"error"') || lo.includes('"level":50') || lo.includes('error:') ? 'error' :
      lo.includes('"level":"warn"')  || lo.includes('"level":40') || lo.includes('warn:')  ? 'warn'  :
      lo.includes('"level":"debug"') || lo.includes('"level":20') || lo.includes('debug:') ? 'debug' : 'info';
    const plainMsg = stripped.replace(/^(error|warn|info|debug|trace):\s*/i, '');
    const tsMatch = stripped.match(/"timestamp":"([^"]+)"/);
    const plainTime = tsMatch ? new Date(tsMatch[1]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    return { raw: stripped, level, time: plainTime, message: plainMsg, fields: {} };
  }
}

const LOG_META: Record<LogLevel, { label: string; color: string; bg: string; border: string; rowBg: string }> = {
  all:   { label: 'ALL',   color: 'var(--muted)',  bg: 'var(--surface-2)', border: 'var(--border)',             rowBg: 'transparent' },
  info:  { label: 'INFO',  color: 'var(--blue)',   bg: 'var(--surface-2)', border: 'var(--blue)',               rowBg: 'transparent' },
  debug: { label: 'DEBUG', color: 'var(--subtle)',  bg: 'var(--surface-2)', border: 'var(--border)',             rowBg: 'transparent' },
  warn:  { label: 'WARN',  color: 'var(--amber)',  bg: 'var(--amber-soft-bg)', border: 'var(--amber-soft-border)', rowBg: 'var(--amber-soft-bg)' },
  error: { label: 'ERR',   color: 'var(--red)',    bg: 'var(--red-soft-bg)',   border: 'var(--red-soft-border)',   rowBg: 'var(--red-soft-bg)' },
};

function CopyLogsBtn({ lines }: { lines: ParsedLog[] }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = lines.map(l => {
      const fields = Object.entries(l.fields).map(([k, v]) => `${k}=${v}`).join(' ');
      return `${l.time} [${l.level.toUpperCase()}] ${l.message}${fields ? ' ' + fields : ''}`;
    }).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button onClick={copy} disabled={lines.length === 0} className={cn(
      'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium',
      copied ? 'bg-green/10 text-green' : 'bg-card text-muted-foreground hover:text-foreground',
      lines.length ? 'cursor-pointer opacity-100' : 'cursor-default opacity-40',
    )}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}</button>
  );
}

function LogRow({ log }: { log: ParsedLog }) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered]   = useState(false);
  const m = LOG_META[log.level];
  const hasFields = Object.keys(log.fields).length > 0;
  const msgColor = log.level === 'error' ? 'var(--red)' : log.level === 'warn' ? 'var(--amber)' : log.level === 'debug' ? 'var(--subtle)' : 'var(--text)';

  return (
    <div
      onClick={() => setExpanded(e => !e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="cursor-pointer border-b border-border transition-colors"
      style={{
        background: hovered ? 'var(--surface-2)' : (expanded ? 'var(--surface-2)' : m.rowBg),
      }}
    >
      <div className="grid min-h-[34px] grid-cols-[78px_54px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-1.5">
        <span className="text-2xs tabular-nums text-muted-foreground">
          {log.time}
        </span>
        <span style={{ border: `1px solid ${m.border}`, background: m.bg, color: m.color }}
          className="rounded px-1.5 py-0.5 text-center text-[9.5px] font-bold tracking-[0.06em]">{m.label}</span>
        <span style={{ color: msgColor }} className="min-w-0 truncate text-xs">
          {log.message}
        </span>
        <span className="flex min-w-0 shrink-0 items-center gap-1.5">
          {!expanded && hasFields && (
            <span className="hidden shrink-0 gap-1 md:flex">
              {Object.keys(log.fields).slice(0, 3).map(k => (
                <span key={k} className="rounded border border-border bg-muted px-1.5 py-0.5 text-[9.5px] text-muted-foreground">{k}</span>
              ))}
              {Object.keys(log.fields).length > 3 && <span className="text-[9.5px] text-muted-foreground">+{Object.keys(log.fields).length - 3}</span>}
            </span>
          )}
          <ChevronRight size={13} className="text-muted-foreground transition-transform" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} />
        </span>
      </div>

      {expanded && (
        <div className="border-t border-border bg-muted px-3 py-3">
          {hasFields && (
            <div className="mb-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border border-border bg-card px-3 py-2">
              {Object.entries(log.fields).map(([k, v]) => (
                <>
                  <span key={`k-${k}`} className="text-2xs font-medium text-muted-foreground">{k}</span>
                  <span key={`v-${k}`} className="break-all font-mono text-2xs text-foreground">{v}</span>
                </>
              ))}
            </div>
          )}
          {log.raw && (
            <>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Raw event</div>
              <pre className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-card px-3 py-2.5 font-mono text-2xs leading-relaxed text-muted-foreground">{log.raw}</pre>
            </>
          )}
        </div>
      )}

    </div>
  );
}

function LogsTab({ agentId, slug }: { agentId: string; slug: string }) {
  const [lines, setLines]             = useState<ParsedLog[]>([]);
  const [connected, setConnected]     = useState(false);
  const [levelFilter, setLevelFilter] = useState<LogLevel>('all');
  const [search, setSearch]           = useState('');
  const [autoScroll, setAutoScroll]   = useState(true);
  const bottomRef    = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/agents/${agentId}/logs`);
    setConnected(true);
    es.onmessage = e => {
      const raw = JSON.parse(e.data) as string;
      setLines(prev => [...prev.slice(-1000), parseLine(raw)]);
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [agentId]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, autoScroll]);

  const LEVEL_ORDER: LogLevel[] = ['error', 'warn', 'info', 'debug'];

  const counts = lines.reduce<Record<LogLevel, number>>((acc, l) => {
    acc[l.level] = (acc[l.level] ?? 0) + 1; return acc;
  }, { all: lines.length, error: 0, warn: 0, info: 0, debug: 0 });

  const visibleLines = lines.filter(l => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return l.message.toLowerCase().includes(q) ||
        Object.values(l.fields).some(v => v.toLowerCase().includes(q));
    }
    return true;
  });

  return (
    <div className="fade-up max-w-[1480px]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border',
            connected ? 'border-green/20 bg-green/10 text-green' : 'border-border bg-muted text-muted-foreground',
          )}>
            <Terminal size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="m-0 text-lg font-semibold tracking-normal text-foreground">Live Logs</h2>
              <span className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium',
                connected ? 'border-green/20 bg-green/10 text-green' : 'border-border bg-muted text-muted-foreground',
              )}>
                <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'status-running bg-green' : 'bg-border')} />
                {connected ? 'Live' : 'Disconnected'}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">Streaming runner output for this agent. Click a row to inspect structured fields.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <CopyLogsBtn lines={visibleLines} />
          <button onClick={() => setLines([])} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <Trash2 size={13} /> Clear
          </button>
        </div>
      </div>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(130px,1fr))]">
        {(['all', 'error', 'warn', 'info', 'debug'] as LogLevel[]).map(lvl => {
          const m = LOG_META[lvl];
          const active = levelFilter === lvl;
          return (
            <button key={lvl} onClick={() => setLevelFilter(lvl)}
              className={cn(
                'rounded-lg border bg-card px-3.5 py-3 text-left shadow-card transition-colors',
                active ? 'border-current' : 'border-border hover:bg-secondary',
              )}
              style={active ? { color: m.color, background: m.bg } : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs font-semibold uppercase tracking-[0.06em]" style={{ color: active ? m.color : 'var(--muted)' }}>{m.label}</span>
                <Radio size={13} style={{ color: active ? m.color : 'var(--subtle)' }} />
              </div>
              <div className="mt-1 text-xl font-semibold leading-none text-foreground">{counts[lvl]}</div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="relative w-full sm:w-[360px]">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search message or fields..."
              className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 font-mono text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          </div>
          <div className="flex items-center gap-3 text-2xs text-muted-foreground">
            <span>{visibleLines.length}{visibleLines.length !== lines.length ? ` / ${lines.length}` : ''} line{visibleLines.length !== 1 ? 's' : ''}</span>
            {!autoScroll && (
              <button onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
                className="cursor-pointer border-none bg-transparent text-xs font-medium text-primary">
                Jump to latest
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[78px_54px_minmax(0,1fr)_auto] gap-2.5 border-b border-border bg-muted/55 px-3 py-2 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          <span>Time</span>
          <span>Level</span>
          <span>Event</span>
          <span />
        </div>

        <div ref={containerRef} onScroll={e => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollTop + el.clientHeight >= el.scrollHeight - 40);
        }} className="h-[560px] overflow-auto">
          {visibleLines.length === 0 ? (
            <div className="px-5 py-16 text-center text-sm text-muted-foreground">
              {lines.length === 0 ? 'Waiting for log lines...' : 'No matching lines.'}
            </div>
          ) : (
            visibleLines.map((log, i) => <LogRow key={i} log={log} />)
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────

const SUGGESTED_TAGS = ['Engineering', 'Product', 'Infra', 'Security', 'Customer Success', 'Data', 'Marketing', 'Operations'];

function TagInput({ tags, onChange, allTags, readOnly }: { tags: string[]; onChange: (t: string[]) => void; allTags: string[]; readOnly?: boolean }) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const suggestions = [...new Set([...SUGGESTED_TAGS, ...allTags])].filter(
    t => t.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t)
  );
  const add = (tag: string) => {
    const t = tag.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setInput('');
  };
  const remove = (tag: string) => onChange(tags.filter(t => t !== tag));
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && input.trim()) { e.preventDefault(); add(input); }
    if (e.key === 'Backspace' && !input && tags.length) remove(tags[tags.length - 1]);
  };
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-muted-foreground">Tags</div>
      <div className={cn(
        'flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border border-input px-2.5 py-1.5',
        readOnly ? 'bg-muted' : 'bg-background',
      )}>
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {tag}
            {!readOnly && (
              <button onClick={() => remove(tag)} className="cursor-pointer border-none bg-transparent p-0 leading-none text-inherit opacity-70">×</button>
            )}
          </span>
        ))}
        {!readOnly && (
          <div className="relative min-w-[80px] flex-1">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKey}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              placeholder={tags.length === 0 ? 'Add tags...' : ''}
              className="w-full border-none bg-transparent p-0 text-sm text-foreground outline-none"
            />
            {focused && (input || suggestions.length > 0) && (
              <div className="absolute left-0 top-full z-50 mt-1 max-h-[200px] min-w-[180px] overflow-y-auto rounded-md border border-border bg-popover shadow-lg">
                {suggestions.map(s => (
                  <div key={s} onMouseDown={() => add(s)} className="cursor-pointer px-3 py-2 text-sm text-foreground hover:bg-secondary">
                    {s}
                  </div>
                ))}
                {input.trim() && !tags.includes(input.trim()) && !suggestions.includes(input.trim()) && (
                  <div onMouseDown={() => add(input)} className="cursor-pointer px-3 py-2 text-sm text-primary hover:bg-secondary">
                    Add &ldquo;{input.trim()}&rdquo;
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mt-1 text-2xs text-muted-foreground">Press Enter or comma to add. Used for filtering on the dashboard.</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8 border-b border-border pb-7">
      <div className="mb-4 text-2xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col gap-3.5">{children}</div>
    </div>
  );
}

function Grid2({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function Field({ label, value, onChange, hint, type = 'text', readOnly }: {
  label: string; value: string; onChange: (v: string) => void;
  hint?: React.ReactNode; type?: string; readOnly?: boolean;
}) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        type={type} value={value} onChange={e => onChange(e.target.value)} readOnly={readOnly}
        className="bg-background text-sm"
      />
      {hint && <p className="mt-1.5 mb-0 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SelectField({ label, value, options, onChange, hint, readOnly }: {
  label: string; value: string; options: { value: string; label: string; sub?: string }[];
  onChange: (v: string) => void; hint?: React.ReactNode; readOnly?: boolean;
}) {
  const known = options.some(o => o.value === value);
  return (
    <div>
      <Label className="mb-1.5 block text-xs text-muted-foreground">
        {label}
      </Label>
      <select
        value={value} onChange={e => onChange(e.target.value)} disabled={readOnly}
        className={cn(
          'h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
          readOnly ? 'cursor-default' : 'cursor-pointer',
        )}
      >
        {options.map((o, i) => (
          <option key={o.value} value={o.value}>{o.label}{o.sub ? ` — ${o.sub}` : ''}{i === 0 ? ' (default)' : ''}</option>
        ))}
        {!known && value && <option value={value}>{value}</option>}
      </select>
      {hint && <p className="mt-1.5 mb-0 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TextArea({ label, value, onChange, hint, rows = 3, readOnly, grow }: {
  label: string; value: string; onChange: (v: string) => void;
  hint?: string; rows?: number; readOnly?: boolean; grow?: boolean;
}) {
  return (
    <div className={grow ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      <Label className="mb-1.5 block text-xs text-muted-foreground">
        {label}
      </Label>
      <Textarea
        value={value} onChange={e => onChange(e.target.value)} rows={rows} readOnly={readOnly}
        className={cn('resize-y bg-background text-sm', grow && 'min-h-[140px] flex-1')}
      />
      {hint && <p className="mt-1.5 mb-0 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PrimaryBtn({ children, onClick, loading }: {
  children: React.ReactNode; onClick?: () => void; loading?: boolean;
}) {
  return (
    <Button size="sm" onClick={onClick} disabled={loading}>
      {loading ? 'Saving…' : children}
    </Button>
  );
}

function GhostBtn({ children, onClick, loading }: { children: React.ReactNode; onClick?: () => void; loading?: boolean }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={loading} className="text-muted-foreground hover:text-foreground">
      {loading ? '…' : children}
    </Button>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function IconBtn({ children, onClick, title, loading }: { children: React.ReactNode; onClick?: () => void; title?: string; loading?: boolean }) {
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={onClick}
      title={title}
      disabled={loading}
      className="h-8 w-8 text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      {loading ? <span className="text-2xs">…</span> : children}
    </Button>
  );
}

/**
 * Header action button — consistent icon+label pill. `default` is a neutral
 * outline (Test/Activity/Reload); `danger`/`success` fill solid for the
 * destructive Stop / Start lifecycle actions. Renders a Link when `href` is set.
 */
function HeaderBtn({ icon, label, onClick, href, title, tone = 'default' }: {
  icon: React.ReactNode; label: string; onClick?: () => void; href?: string; title?: string;
  tone?: 'default' | 'danger' | 'success';
}) {
  const cls = tone === 'danger'
    ? 'bg-red text-white border border-red hover:bg-red/90'
    : tone === 'success'
    ? 'bg-green text-white border border-green hover:bg-green/90'
    : 'bg-card text-foreground border border-border hover:bg-secondary';
  const className = cn(
    'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-medium no-underline transition-colors',
    cls,
  );
  if (href) return <Link href={href} title={title} className={className}>{icon}{label}</Link>;
  return <button onClick={onClick} title={title} className={className}>{icon}{label}</button>;
}

function Modal({ title, children, onClose, width = 440 }: {
  title: string; children: React.ReactNode; onClose: () => void; width?: number;
}) {
  return (
    <Portal>
    <div onClick={onClose} className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        onClick={e => e.stopPropagation()}
        style={{ width, maxWidth: '92vw' }}
        className="flex max-h-[90vh] flex-col gap-4 overflow-auto rounded-lg border border-border bg-card p-7 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h3 className="m-0 text-md font-semibold text-foreground">{title}</h3>
          <button onClick={onClose} className="cursor-pointer border-none bg-transparent text-lg leading-none text-muted-foreground">×</button>
        </div>
        {children}
      </div>
    </div>
    </Portal>
  );
}

function PageLoader() {
  return (
    <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}

function NotFound({ slug }: { slug: string }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3">
      <p className="text-sm text-muted-foreground">Agent not found: <code className="font-mono">{slug}</code></p>
      <Link href="/" className="text-sm text-primary no-underline">← Back to dashboard</Link>
    </div>
  );
}

// ─── Persona Library Modal ────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  engineering: 'var(--accent)',
  data: '#9333ea',
  product: '#16a34a',
  business: '#d97706',
  generic: 'var(--muted)',
};

const CATEGORY_LABELS: Record<string, string> = {
  all: 'All',
  engineering: 'Engineering',
  data: 'Data',
  product: 'Product',
  business: 'Business',
  generic: 'Generic',
};

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  all: <Library size={14} />,
  engineering: <Code2 size={14} />,
  data: <Database size={14} />,
  product: <Layers size={14} />,
  business: <Briefcase size={14} />,
  generic: <Sparkles size={14} />,
};

function PersonaLibraryModal({
  agentId,
  tab,
  onTabChange,
  jsonPanel,
  fileInputRef,
  applying,
  search,
  onSearchChange,
  category,
  onCategoryChange,
  selected,
  onSelectPersona,
  onBack,
  skillSel,
  onToggleSkill,
  onImportFull,
  onImportSkills,
  onClose,
}: {
  agentId: string;
  tab: 'json' | 'template';
  onTabChange: (t: 'json' | 'template') => void;
  jsonPanel: React.ReactNode;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  applying: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  category: PersonaCategory | 'all';
  onCategoryChange: (v: PersonaCategory | 'all') => void;
  selected: PersonaTemplate | null;
  onSelectPersona: (p: PersonaTemplate) => void;
  onBack: () => void;
  skillSel: Set<string>;
  onToggleSkill: (filename: string) => void;
  onImportFull: (t: PersonaTemplate) => Promise<void>;
  onImportSkills: (t: PersonaTemplate, sel: Set<string>) => Promise<void>;
  onClose: () => void;
}) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const filteredPersonas = useMemo(() => {
    let list = search.trim() ? searchPersonas(search) : PERSONA_CATALOG;
    if (category !== 'all') list = list.filter(p => p.category === category);
    return list;
  }, [search, category]);

  return (
    <Portal>
      <div className="fixed inset-0 z-[1000] flex items-center justify-center p-5">
        <div className="fixed inset-0 bg-black/50"
          onClick={onClose} />
        <div className="relative flex w-full max-w-[800px] max-h-[560px] flex-col rounded-xl border border-border bg-background shadow-lg">

          {/* ── Header ───────────────────────────────────────────────────── */}
          <div className="flex shrink-0 items-start justify-between border-b border-border px-6 pb-4 pt-5">
            <div className="flex gap-1">
              {(['json', 'template'] as const).map(id => (
                <button key={id} onClick={() => onTabChange(id)} className={cn(
                  'cursor-pointer rounded-lg px-3.5 py-[7px] text-sm',
                  tab === id ? 'bg-secondary font-semibold text-foreground' : 'font-medium text-muted-foreground',
                )}>{id === 'json' ? 'Import JSON' : 'Choose Template'}</button>
              ))}
            </div>
            <button onClick={onClose} className="-mt-0.5 cursor-pointer p-1 text-muted-foreground"><X size={18} /></button>
          </div>

          {tab === 'json' && jsonPanel}
          {tab === 'template' && (<>

          {/* ── Search bar ───────────────────────────────────────────────── */}
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-3">
            <div className="relative flex-1">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search personas..."
                value={search}
                onChange={e => onSearchChange(e.target.value)}
                autoFocus={!selected}
                className="box-border w-full rounded-md border border-border bg-secondary py-[7px] pl-8 pr-2.5 text-sm text-foreground outline-none"
              />
            </div>
          </div>

          {/* ── Body: sidebar + main ─────────────────────────────────────── */}
          <div className="flex flex-1 overflow-hidden">

            {/* Left sidebar */}
            <div className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border px-2 py-3">
              <span className="mb-1 px-2.5 text-2xs font-bold uppercase tracking-[0.08em] text-muted-foreground">Browse</span>
              {Object.entries(CATEGORY_LABELS).map(([val, label]) => {
                const isActive = category === val;
                const count = val === 'all'
                  ? PERSONA_CATALOG.length
                  : PERSONA_CATALOG.filter(p => p.category === val).length;
                const iconColor = isActive
                  ? (CATEGORY_COLORS[val] ?? 'var(--accent)')
                  : 'var(--subtle)';
                return (
                  <button key={val}
                    onClick={() => { onCategoryChange(val as PersonaCategory | 'all'); if (selected) onBack(); }}
                    className={cn(
                      'relative flex cursor-pointer items-center justify-between rounded-md px-2.5 py-[7px] text-left text-sm transition-colors',
                      isActive ? 'bg-secondary font-semibold text-foreground' : 'font-normal text-muted-foreground hover:bg-secondary',
                    )}
                  >
                    {isActive && (
                      <span className="absolute bottom-[20%] left-0 top-[20%] w-[3px] rounded-sm"
                        style={{ background: CATEGORY_COLORS[val] ?? 'var(--accent)' }} />
                    )}
                    <span className="flex items-center gap-2" style={{ color: iconColor }}>
                      {CATEGORY_ICONS[val]}
                      <span className={isActive ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
                    </span>
                    <span className={cn('text-xs font-medium', isActive ? 'text-primary' : 'text-muted-foreground')}>{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Right: card grid or detail */}
            {selected ? (
              // ── Detail view ───────────────────────────────────────────────
              <div className="flex flex-1 flex-col overflow-auto">
                <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
                  <button onClick={onBack} className="flex cursor-pointer items-center gap-[5px] p-0 text-sm text-muted-foreground hover:text-foreground">
                    <ArrowLeft size={14} /> Back
                  </button>
                  <div className="flex gap-2">
                    {selected.skills.length > 0 && (
                      <button
                        disabled={applying || skillSel.size === 0}
                        onClick={() => onImportSkills(selected, skillSel)}
                        className={cn(
                          'rounded-md border border-border bg-transparent px-3.5 py-[7px] text-sm font-medium text-foreground hover:border-primary',
                          (applying || skillSel.size === 0) ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
                        )}
                      >
                        Add {skillSel.size} skill{skillSel.size !== 1 ? 's' : ''}
                      </button>
                    )}
                    <button
                      disabled={applying}
                      onClick={() => onImportFull(selected)}
                      className={cn(
                        'rounded-md border-none bg-primary px-4 py-[7px] text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-85',
                        applying ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
                      )}
                    >
                      {applying ? 'Importing…' : 'Import persona'}
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-4 px-5 pb-7 pt-4">
                  <div>
                    <h3 className="mb-1 text-md font-semibold text-foreground">
                      {selected.name}
                    </h3>
                    <p className="text-sm leading-normal text-muted-foreground">
                      {selected.cardDescription}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-[5px]">
                    <span className="rounded-sm px-[7px] py-0.5 text-2xs font-bold uppercase tracking-[0.06em]"
                      style={{
                        background: `${CATEGORY_COLORS[selected.category]}1a`,
                        color: CATEGORY_COLORS[selected.category] ?? 'var(--muted)',
                      }}>{selected.category}</span>
                    {selected.tags.map(tag => (
                      <span key={tag} className="rounded-sm border border-border bg-secondary px-[7px] py-0.5 text-xs text-muted-foreground">{tag}</span>
                    ))}
                  </div>
                  {/* System prompt preview */}
                  {selected.claudeMd && (
                    <div className="overflow-hidden rounded-md border border-border">
                      <button onClick={() => setPromptExpanded(v => !v)} className="flex w-full cursor-pointer items-center justify-between border-none bg-secondary px-3 py-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                          System Prompt
                        </span>
                        <ChevronDown size={13} className="text-muted-foreground transition-transform"
                          style={{ transform: promptExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                      </button>
                      {promptExpanded && (
                        <pre className="m-0 max-h-[200px] overflow-auto bg-background px-3 py-2.5 font-mono text-2xs leading-normal text-muted-foreground whitespace-pre-wrap">
                          {selected.claudeMd.trim()}
                        </pre>
                      )}
                    </div>
                  )}

                  {selected.skills.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Skills · select to cherry-pick</p>
                      <div className="flex flex-col gap-0.5">
                        {selected.skills.map(skill => {
                          const isExpanded = expandedSkill === skill.filename;
                          return (
                            <div key={skill.filename} className={cn(
                              'overflow-hidden rounded-md border transition-all',
                              skillSel.has(skill.filename) ? 'border-border bg-secondary' : 'border-border bg-transparent',
                            )}>
                              <div className="flex items-center gap-2 px-2.5 py-[7px]">
                                <input type="checkbox"
                                  checked={skillSel.has(skill.filename)}
                                  onChange={() => onToggleSkill(skill.filename)}
                                  className="h-[13px] w-[13px] shrink-0 cursor-pointer accent-primary"
                                />
                                <span className="shrink-0 font-mono text-xs text-muted-foreground">{skill.category}/</span>
                                <span className="flex-1 font-mono text-xs text-foreground">{skill.filename}</span>
                                <button
                                  onClick={() => setExpandedSkill(isExpanded ? null : skill.filename)}
                                  className={cn(
                                    'flex shrink-0 cursor-pointer items-center border-none bg-transparent px-1 py-0.5',
                                    isExpanded ? 'text-foreground' : 'text-muted-foreground',
                                  )}
                                  title={isExpanded ? 'Hide content' : 'Preview content'}
                                >
                                  <ChevronDown size={12} className="transition-transform"
                                    style={{ transform: isExpanded ? 'rotate(180deg)' : 'none' }} />
                                </button>
                              </div>
                              {isExpanded && (
                                <pre className="m-0 max-h-[200px] overflow-auto border-t border-border bg-background px-3 pb-2.5 pt-2 font-mono text-xs leading-normal text-muted-foreground whitespace-pre-wrap">
                                  {skill.content}
                                </pre>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    "Import persona" replaces your current system prompt, description, and all existing skills.
                  </p>
                  <button onClick={() => { onClose(); fileInputRef.current?.click(); }} className="cursor-pointer self-start border-none bg-transparent p-0 text-xs text-muted-foreground underline underline-offset-[3px] hover:text-foreground"
                  >Import from JSON file instead</button>
                </div>
              </div>
            ) : (
              // ── Card grid ─────────────────────────────────────────────────
              <div className="flex-1 overflow-auto px-4 pb-5 pt-3">
                {filteredPersonas.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    No personas match your search.
                  </div>
                ) : (
                  <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
                    {filteredPersonas.map(p => (
                      <button key={p.id} onClick={() => onSelectPersona(p)}
                        className="flex min-w-0 cursor-pointer flex-col items-start gap-[7px] rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-all hover:border-primary hover:shadow-md"
                      >
                        <span className="shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.07em]"
                          style={{
                            background: `${CATEGORY_COLORS[p.category]}1a`,
                            color: CATEGORY_COLORS[p.category] ?? 'var(--muted)',
                          }}>{p.category}</span>
                        <span className="text-sm font-semibold leading-tight text-foreground">
                          {p.name}
                        </span>
                        <p className="m-0 line-clamp-2 overflow-hidden text-xs leading-snug text-muted-foreground">{p.cardDescription}</p>
                        <div className="flex w-full min-w-0 items-center justify-between gap-1">
                          <span className="min-w-0 flex-shrink overflow-hidden text-ellipsis whitespace-nowrap rounded-sm border border-border bg-secondary px-1.5 py-px text-2xs text-muted-foreground">{p.tags[0]}</span>
                          {p.skills.length > 0 && (
                            <span className="shrink-0 whitespace-nowrap text-2xs text-muted-foreground">
                              {p.skills.length} skills
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          </>)}
        </div>
      </div>
    </Portal>
  );
}

// ─── History ──────────────────────────────────────────────────────────────────

// ── Diff panel ───────────────────────────────────────────────────────────────

/**
 * Build the file-diff entries for a **restore preview**: "if I restore this
 * snapshot on top of the current state, what will change?"
 *
 * That means current is the OLD side (what you have now) and the snapshot is
 * the NEW side (what you'd get). So:
 *   - present in snapshot, missing in current → `added` (will be added by restore)
 *   - present in current, missing in snapshot → `removed` (will be removed by restore)
 *   - different                               → `modified` (will change)
 *
 * CLAUDE.md comes first, then every differing skill alphabetically.
 */
function buildDiffFiles(snapshot: AgentSnapshot, current: AgentSnapshot): FileChange[] {
  const files: FileChange[] = [];

  // CLAUDE.md. Skip unless both sides captured content — old snapshots
  // without `compiledMd` would otherwise render as a misleading all-green
  // "will be removed" diff.
  const currMd = current.compiledMd?.trim() ?? '';
  const snapMd = snapshot.compiledMd?.trim() ?? '';
  if (currMd && snapMd && currMd !== snapMd) {
    files.push({ path: 'AGENTS.md', status: 'modified', oldText: currMd, newText: snapMd });
  }

  const snapMap = new Map(snapshot.skillsJson.map(s => [`${s.category}/${s.filename}`, s.content]));
  const currMap = new Map(current.skillsJson.map(s => [`${s.category}/${s.filename}`, s.content]));
  const keys = new Set([...snapMap.keys(), ...currMap.keys()]);
  for (const key of Array.from(keys).sort()) {
    const inSnap = snapMap.get(key);
    const inCurr = currMap.get(key);
    if (inCurr === undefined && inSnap !== undefined) {
      // Restore would add this file back.
      files.push({ path: key, status: 'added', oldText: '', newText: inSnap });
    } else if (inSnap === undefined && inCurr !== undefined) {
      // Restore would delete this file from current.
      files.push({ path: key, status: 'removed', oldText: inCurr, newText: '' });
    } else if (inSnap !== inCurr && inSnap !== undefined && inCurr !== undefined) {
      files.push({ path: key, status: 'modified', oldText: inCurr, newText: inSnap });
    }
  }

  return files;
}

// Each of these diffs is framed as **restore preview**:
//   will-add  = in snapshot, not in current  (restore grants / reconnects / re-restricts to)
//   will-drop = in current, not in snapshot  (restore revokes / disconnects / un-restricts)

function PermsDiff({ snapshot, current }: { snapshot: AgentSnapshot; current: AgentSnapshot | null }) {
  const currAllowed = new Set(current ? current.allowedTools : []);
  const currDenied  = new Set(current ? current.deniedTools  : []);
  const snapAllowed = new Set(snapshot.allowedTools);
  const snapDenied  = new Set(snapshot.deniedTools);

  const willAddAllowed  = [...snapAllowed].filter(t => !currAllowed.has(t));
  const willDropAllowed = [...currAllowed].filter(t => !snapAllowed.has(t));
  const willAddDenied   = [...snapDenied].filter(t => !currDenied.has(t));
  const willDropDenied  = [...currDenied].filter(t => !snapDenied.has(t));

  if (!willAddAllowed.length && !willDropAllowed.length && !willAddDenied.length && !willDropDenied.length) {
    return <p className="m-0 text-sm text-muted-foreground">No permission changes.</p>;
  }
  const row = (label: string, items: string[], color: string) => items.length > 0 && (
    <div key={label}>
      <div className="mb-1 text-2xs font-semibold text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map(t => (
          <span key={t} style={{ background: `${color}22`, color }} className="rounded-sm px-2 py-0.5 font-mono text-2xs">{t}</span>
        ))}
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-2.5">
      {row('Tools that will be allowed',      willAddAllowed,  'var(--green)')}
      {row('Tools that will no longer be allowed', willDropAllowed, 'var(--red)')}
      {row('Tools that will be denied',       willAddDenied,   'var(--red)')}
      {row('Tools that will no longer be denied',  willDropDenied,  'var(--green)')}
    </div>
  );
}

function McpsDiff({ snapshot, current, allMcps }: { snapshot: AgentSnapshot; current: AgentSnapshot | null; allMcps: McpServer[] }) {
  const nameFor = (id: string) => allMcps.find(m => m.id === id)?.name ?? id;
  const currIds = new Set(current ? current.mcpIds : []);
  const snapIds = new Set(snapshot.mcpIds);
  const willConnect    = [...snapIds].filter(id => !currIds.has(id));
  const willDisconnect = [...currIds].filter(id => !snapIds.has(id));
  if (!willConnect.length && !willDisconnect.length) return <p className="m-0 text-sm text-muted-foreground">No MCP changes.</p>;
  return (
    <div className="flex flex-col gap-2">
      {willConnect.length > 0 && <div>
        <div className="mb-1 text-2xs font-semibold text-green">Will be connected</div>
        {willConnect.map(id => <div key={id} className="text-xs text-green">+ {nameFor(id)}</div>)}
      </div>}
      {willDisconnect.length > 0 && <div>
        <div className="mb-1 text-2xs font-semibold text-red">Will be disconnected</div>
        {willDisconnect.map(id => <div key={id} className="text-xs text-red">− {nameFor(id)}</div>)}
      </div>}
    </div>
  );
}

function ChannelsDiff({ snapshot, current }: { snapshot: AgentSnapshot; current: AgentSnapshot | null }) {
  const currChannels = new Set(current?.allowedChannels ?? []);
  const snapChannels = new Set(snapshot.allowedChannels ?? []);
  const willAdd  = [...snapChannels].filter(ch => !currChannels.has(ch));
  const willDrop = [...currChannels].filter(ch => !snapChannels.has(ch));
  if (!willAdd.length && !willDrop.length) return <p className="m-0 text-sm text-muted-foreground">No channel restriction changes.</p>;
  return (
    <div className="flex flex-col gap-2">
      {willAdd.length > 0 && <div>
        <div className="mb-1 text-2xs font-semibold text-green">Channels that will be restored</div>
        <div className="flex flex-wrap gap-1.5">
          {willAdd.map(ch => (
            <span key={ch} className="rounded-sm bg-green/10 px-2 py-0.5 font-mono text-2xs text-green">{ch}</span>
          ))}
        </div>
      </div>}
      {willDrop.length > 0 && <div>
        <div className="mb-1 text-2xs font-semibold text-red">Channels that will be dropped</div>
        <div className="flex flex-wrap gap-1.5">
          {willDrop.map(ch => (
            <span key={ch} className="rounded-sm bg-red/10 px-2 py-0.5 font-mono text-2xs text-red">{ch}</span>
          ))}
        </div>
      </div>}
    </div>
  );
}

// ── Trigger badge ─────────────────────────────────────────────────────────────

const TRIGGER_COLORS: Record<string, { bg: string; color: string }> = {
  skills:      { bg: 'rgba(59,130,246,0.12)',  color: '#3b82f6' },
  permissions: { bg: 'rgba(234,179,8,0.12)',   color: '#ca8a04' },
  mcps:        { bg: 'rgba(168,85,247,0.12)',  color: '#a855f7' },
  'claude-md': { bg: 'rgba(236,72,153,0.12)',  color: '#ec4899' },
  manual:      { bg: 'rgba(22,163,74,0.12)',   color: '#16a34a' },
};

const TRIGGER_LABELS: Record<string, string> = {
  skills: 'Skills', permissions: 'Capabilities', mcps: 'Connected Apps',
  'claude-md': 'System Prompt', manual: 'Manual', restrictions: 'Channels',
};

function TriggerBadge({ trigger }: { trigger: string }) {
  const c = TRIGGER_COLORS[trigger] ?? { bg: 'var(--surface-2)', color: 'var(--muted)' };
  return (
    <span style={{ background: c.bg, color: c.color }}
      className="rounded-md px-2 py-0.5 text-2xs font-semibold tracking-[0.03em]">{TRIGGER_LABELS[trigger] ?? trigger}</span>
  );
}


// ── Main HistoryTab component ─────────────────────────────────────────────────

function HistoryTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [snapshots, setSnapshots] = useState<AgentSnapshot[]>([]);
  const [loading, setLoading]     = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fullSnapshot, setFullSnapshot] = useState<AgentSnapshot | null>(null);
  // Live current state — the restore-preview target. Always the compare side.
  const [liveSnapshot, setLiveSnapshot] = useState<AgentSnapshot | null>(null);
  const [allMcps, setAllMcps]     = useState<McpServer[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [msg, setMsg]             = useState('');
  const [copied, setCopied]       = useState(false);
  const [menuOpen, setMenuOpen]   = useState(false);

  // Load snapshot list + MCP catalog (fast path — no live state on mount)
  useEffect(() => {
    Promise.all([
      fetch(`/api/agents/${agentId}/snapshots`).then(r => r.json()),
      fetch('/api/mcps').then(r => r.json()),
    ]).then(([snaps, mcps]) => {
      setSnapshots(Array.isArray(snaps) ? snaps : []);
      setAllMcps(mcps);
      setLoading(false);
    });
  }, [agentId]);

  // Lazy-load live state once — it's the fixed compare target for every snapshot.
  useEffect(() => {
    if (liveSnapshot) return;
    Promise.all([
      fetch(`/api/agents/${agentId}/skills`).then(r => r.json()),
      fetch(`/api/agents/${agentId}/permissions`).then(r => r.json()),
      fetch(`/api/agents/${agentId}/mcps`).then(r => r.json()),
      fetch(`/api/agents/${agentId}/claude-md`).then(r => r.text()),
    ]).then(([skills, perms, agentMcps, claudeMd]) => {
      setLiveSnapshot({
        id: '__current__',
        agentId,
        trigger: 'manual',
        createdBy: 'current',
        skillsJson: skills.map((s: Skill) => ({
          category: s.category,
          filename: s.filename,
          content: s.content,
          sort_order: s.sortOrder,
        })),
        allowedTools: perms?.allowedTools ?? [],
        deniedTools:  perms?.deniedTools  ?? [],
        mcpIds: (agentMcps as McpServer[]).map(m => m.id),
        compiledMd: claudeMd ?? '',
        allowedChannels: [],
        createdAt: new Date(),
      });
    });
  }, [agentId, liveSnapshot]);

  // Load full snapshot when selected
  useEffect(() => {
    if (!selectedId) { setFullSnapshot(null); return; }
    setFullSnapshot(null);
    setLoadingDetail(true);
    fetch(`/api/agents/${agentId}/snapshots/${selectedId}`)
      .then(r => r.json())
      .then(snap => { setFullSnapshot(snap); setLoadingDetail(false); })
      .catch(() => setLoadingDetail(false));
  }, [agentId, selectedId]);

  const handleCreateManual = async () => {
    const label = window.prompt('Snapshot label (optional):') ?? '';
    const r = await fetch(`/api/agents/${agentId}/snapshots`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label || null }),
    });
    if (r.ok) {
      const snap = await r.json();
      setSnapshots(prev => [snap, ...prev]);
      setMsg('Snapshot created.');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this snapshot?')) return;
    await fetch(`/api/agents/${agentId}/snapshots/${id}`, { method: 'DELETE' });
    setSnapshots(prev => prev.filter(s => s.id !== id));
    if (selectedId === id) { setSelectedId(null); setFullSnapshot(null); }
    setMsg('Snapshot deleted.');
  };

  const handleRestore = async (snap: AgentSnapshot) => {
    if (!window.confirm(`Restore to snapshot from ${new Date(snap.createdAt).toLocaleString()}?\n\nThis will replace current skills, permissions, and MCPs.`)) return;
    setRestoring(true);
    const r = await fetch(`/api/agents/${agentId}/snapshots/${snap.id}/restore`, { method: 'POST' });
    setRestoring(false);
    if (r.ok) {
      setMsg('Restored. Agent is reloading.');
    } else {
      const err = await r.json();
      setMsg(`Restore failed: ${err.error}`);
    }
  };

  const fmt = (d: Date | string) => {
    const dt = new Date(d);
    return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  const handleExport = () => {
    if (!fullSnapshot) return;
    const blob = new Blob([JSON.stringify(fullSnapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `snapshot-${fullSnapshot.id}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const copyId = () => {
    if (!fullSnapshot) return;
    navigator.clipboard?.writeText(fullSnapshot.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Newer/Older paging across the (newest-first) snapshot list.
  const selIndex = selectedId ? snapshots.findIndex(s => s.id === selectedId) : -1;
  const goNewer = () => { if (selIndex > 0) setSelectedId(snapshots[selIndex - 1].id); };
  const goOlder = () => { if (selIndex >= 0 && selIndex < snapshots.length - 1) setSelectedId(snapshots[selIndex + 1].id); };

  const ghostBtnClass = 'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 py-[7px] text-xs font-medium text-foreground';
  const primaryBtnClass = 'inline-flex items-center gap-1.5 rounded-lg border-none px-3.5 py-[7px] text-xs font-semibold text-primary-foreground';
  const pagerBtnStyle = (disabled: boolean): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: 12.5, fontWeight: 500, borderRadius: 8, fontFamily: 'var(--font-sans)', border: '1px solid var(--border)', background: 'var(--surface)', color: disabled ? 'var(--subtle)' : 'var(--text)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 });

  // Compare target is always live current state — restore preview is current-only.
  const currentAsSnapshot: AgentSnapshot | null = liveSnapshot;

  if (loading) return (
    <div className="flex min-h-[500px] gap-5">
      <div className="flex w-[280px] shrink-0 flex-col gap-2">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="h-[13px] w-[70px] rounded-[5px] bg-secondary" />
          <div className="h-[30px] w-[110px] rounded-lg bg-secondary" />
        </div>
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="rounded-md bg-card px-4 py-3.5 shadow"
            style={{ opacity: 1 - (i - 1) * 0.2 }}>
            <div className="mb-2.5 flex items-center justify-between">
              <div className="h-[18px] w-[70px] rounded-md bg-secondary" />
              <div className="h-[11px] w-[50px] rounded-sm bg-secondary" />
            </div>
            <div className="h-[11px] w-[55%] rounded-sm bg-secondary" />
          </div>
        ))}
      </div>
      <div className="flex flex-1 items-center justify-center rounded-lg bg-card shadow">
        <div className="text-sm text-muted-foreground">Loading history…</div>
      </div>
    </div>
  );

  return (
    <div className="fade-up">
      {/* ── Section header ─────────────────────────────────────────────── */}
      <div className="mb-[22px] flex flex-wrap items-start justify-between gap-3.5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-secondary text-foreground"><History size={19} /></div>
          <div>
            <h2 className="mb-[3px] text-xl font-semibold tracking-[-0.01em] text-foreground">History</h2>
            <p className="max-w-[520px] text-sm leading-normal text-muted-foreground">View and compare snapshots of this agent's configuration over time.</p>
          </div>
        </div>
        {msg && <span className="self-center text-xs text-muted-foreground">{msg}</span>}
      </div>

      <div className="flex items-start gap-5">
        {/* ── Left: snapshot timeline ──────────────────────────────────── */}
        <div className="w-[300px] shrink-0 overflow-hidden rounded-2xl border border-border bg-card">
          <div className="flex items-center justify-between gap-2.5 border-b border-border px-[15px] py-[13px]">
            <span className="inline-flex items-center gap-[7px] text-xs font-bold uppercase tracking-[0.07em] text-muted-foreground">
              <History size={13} /> {snapshots.length} snapshot{snapshots.length !== 1 ? 's' : ''}
            </span>
            {canEdit && (
              <button onClick={handleCreateManual} className="inline-flex cursor-pointer items-center gap-[5px] rounded-lg border-none bg-primary px-[11px] py-1.5 text-xs font-semibold text-primary-foreground"><Plus size={13} /> Snapshot</button>
            )}
          </div>

          {snapshots.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <Camera size={22} className="text-border" />
              <div className="my-1.5 mt-2.5 text-sm font-semibold text-foreground">No snapshots yet</div>
              <div className="text-xs leading-relaxed text-muted-foreground">Snapshots are saved automatically when you change skills, tools, or capabilities.</div>
            </div>
          ) : (
            <div className="relative px-[15px] py-3.5">
              <div className="absolute bottom-[22px] left-5 top-[22px] w-0.5 bg-border" />
              <div className="flex flex-col gap-[9px]">
                {snapshots.map((snap, i) => {
                  const isSel = snap.id === selectedId;
                  return (
                    <div key={snap.id} onClick={() => setSelectedId(snap.id)} className="relative cursor-pointer pl-5">
                      <span className="absolute left-0 top-[15px] z-[1] h-3 w-3 rounded-full shadow-[0_0_0_3px_var(--surface)]"
                        style={{ background: isSel ? 'var(--accent)' : 'var(--surface)', border: `2px solid ${isSel ? 'var(--accent)' : 'var(--border-2)'}` }} />
                      <div className={cn('rounded-xl border px-3 py-2.5 transition-colors', isSel ? 'border-primary bg-secondary' : 'border-border bg-card')}>
                        <div className="flex items-center gap-[7px]">
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-foreground">{TRIGGER_LABELS[snap.trigger] ?? snap.trigger}</span>
                          {i === 0 && <span className="rounded-[5px] bg-primary px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.04em] text-primary-foreground">Latest</span>}
                          <ChevronRight size={14} className="ml-auto shrink-0 text-muted-foreground" />
                        </div>
                        <div className="mt-1 text-2xs text-muted-foreground">{fmt(snap.createdAt)}</div>
                        <div className="mt-px text-2xs text-muted-foreground">by {snap.createdBy}</div>
                        {snap.label && <div className="mt-[3px] overflow-hidden text-ellipsis whitespace-nowrap text-2xs italic text-muted-foreground">{snap.label}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ── Right: detail ────────────────────────────────────────────── */}
        <div className="min-w-0 flex-1">
          {loadingDetail ? (
            <div className="flex flex-col gap-4">
              <div className="h-9 rounded-lg bg-secondary" />
              <div className="h-[84px] rounded-xl bg-secondary" />
              {[160, 120].map((h, i) => <div key={i} className="rounded-xl bg-secondary" style={{ height: h, opacity: 1 - i * 0.3 }} />)}
            </div>
          ) : !fullSnapshot ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed border-border p-10">
              <History size={30} className="text-border" />
              <div className="text-base font-semibold text-foreground">Select a snapshot</div>
              <div className="max-w-[280px] text-center text-sm leading-relaxed text-muted-foreground">Pick a snapshot on the left to see what changed and restore it if needed.</div>
            </div>
          ) : (() => {
            // Restore-preview frame: current = OLD side, snapshot = NEW side.
            // green = snapshot has, current doesn't = added on restore; red = the reverse.
            const files = currentAsSnapshot ? buildDiffFiles(fullSnapshot, currentAsSnapshot) : [];
            const added = files.filter(f => f.status === 'added').length;
            const updated = files.filter(f => f.status === 'modified').length;
            const removed = files.filter(f => f.status === 'removed').length;

            const cur = currentAsSnapshot;
            const hasPermChanges = !!cur && (
              cur.allowedTools.some(t => !fullSnapshot.allowedTools.includes(t)) ||
              fullSnapshot.allowedTools.some(t => !cur.allowedTools.includes(t)) ||
              cur.deniedTools.some(t => !fullSnapshot.deniedTools.includes(t)) ||
              fullSnapshot.deniedTools.some(t => !cur.deniedTools.includes(t)));
            const hasMcpChanges = !!cur && (
              cur.mcpIds.some(id => !fullSnapshot.mcpIds.includes(id)) ||
              fullSnapshot.mcpIds.some(id => !cur.mcpIds.includes(id)));
            const hasChannelChanges = !!cur && (
              (cur.allowedChannels ?? []).some(c => !(fullSnapshot.allowedChannels ?? []).includes(c)) ||
              (fullSnapshot.allowedChannels ?? []).some(c => !(cur.allowedChannels ?? []).includes(c)));
            const hasOther = hasPermChanges || hasMcpChanges || hasChannelChanges;

            const Stat = ({ icon, color, value, label, sub }: { icon: React.ReactNode; color: string; value: number; label: string; sub: string }) => (
              <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5">
                <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px]" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>{icon}</div>
                <div className="min-w-0">
                  <div className="text-2xs text-muted-foreground">{label}</div>
                  <div className="text-xl font-bold leading-tight text-foreground">{value}</div>
                  <div className="text-xs text-muted-foreground">{sub}</div>
                </div>
              </div>
            );

            const shortId = fullSnapshot.id.length > 13 ? `${fullSnapshot.id.slice(0, 8)}…` : fullSnapshot.id;

            return (
              <div className="flex flex-col gap-4">
                {/* Detail header */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-[9px]">
                    <TriggerBadge trigger={fullSnapshot.trigger} />
                    <span className="text-sm font-medium text-foreground">{fmt(fullSnapshot.createdAt)}</span>
                    <span className="text-xs text-muted-foreground">· by {fullSnapshot.createdBy}</span>
                    <span className="inline-flex items-center gap-[5px] text-xs text-muted-foreground">
                      · ID <span className="font-mono text-muted-foreground">{shortId}</span>
                      <button onClick={copyId} title="Copy snapshot ID" className={cn('inline-flex cursor-pointer border-none bg-transparent p-0.5', copied ? 'text-green' : 'text-muted-foreground')}>
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </span>
                  </div>
                  <div className="relative flex shrink-0 items-center gap-2">
                    <button onClick={handleExport} className={ghostBtnClass}><Download size={13} /> Export</button>
                    {canEdit && <button onClick={() => handleRestore(fullSnapshot)} disabled={restoring} className={cn(primaryBtnClass, 'bg-green', restoring ? 'cursor-not-allowed' : 'cursor-pointer')}><RotateCcw size={13} /> {restoring ? 'Restoring…' : 'Restore'}</button>}
                    {canEdit && (
                      <>
                        <button onClick={() => setMenuOpen(o => !o)} className={cn(ghostBtnClass, 'px-[9px]')}><MoreHorizontal size={15} /></button>
                        {menuOpen && (
                          <>
                            <div onClick={() => setMenuOpen(false)} className="fixed inset-0 z-10" />
                            <div className="absolute right-0 top-full z-[11] mt-1.5 min-w-[160px] rounded-lg border border-border bg-card p-[5px] shadow-md">
                              <button onClick={() => { setMenuOpen(false); handleDelete(fullSnapshot.id); }} className="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2.5 py-[7px] text-left text-xs text-red"><Trash2 size={13} /> Delete snapshot</button>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Stat strip */}
                {cur && (
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
                    <Stat icon={<Plus size={17} />} color="var(--green)" value={added} label="Files added" sub="New files" />
                    <Stat icon={<Pencil size={15} />} color="var(--amber)" value={updated} label="Files updated" sub="Modified files" />
                    <Stat icon={<Minus size={17} />} color="var(--red)" value={removed} label="Files removed" sub="Removed files" />
                  </div>
                )}

                {/* Caption */}
                <div className="text-2xs leading-normal text-muted-foreground">
                  Diff vs the current configuration — <span className="font-semibold text-green">green</span> is what Restore would add, <span className="font-semibold text-red">red</span> what it would remove.
                </div>

                {/* Diff */}
                {!cur ? (
                  <div className="rounded-xl border border-border p-6 text-center text-sm text-muted-foreground">Loading comparison…</div>
                ) : files.length === 0 && !hasOther ? (
                  <div className="rounded-xl border border-dashed border-border p-7 text-center text-sm text-muted-foreground">This snapshot matches the current configuration — no differences.</div>
                ) : (
                  <>
                    {files.length > 0 && <FilesChanged files={files} />}
                    {hasOther && (
                      <div className="overflow-hidden rounded-xl border border-border">
                        <div className="border-b border-border px-4 py-[11px] text-xs font-bold uppercase tracking-[0.07em] text-muted-foreground">Other changes</div>
                        <div className="flex flex-col gap-3.5 p-4">
                          {hasPermChanges && <PermsDiff snapshot={fullSnapshot} current={cur} />}
                          {hasMcpChanges && <McpsDiff snapshot={fullSnapshot} current={cur} allMcps={allMcps} />}
                          {hasChannelChanges && <ChannelsDiff snapshot={fullSnapshot} current={cur} />}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Pager */}
                <div className="mt-0.5 flex items-center justify-between gap-2.5">
                  <button onClick={goNewer} disabled={selIndex <= 0} style={pagerBtnStyle(selIndex <= 0)}><ArrowLeft size={14} /> Newer</button>
                  <button onClick={goOlder} disabled={selIndex < 0 || selIndex >= snapshots.length - 1} style={pagerBtnStyle(selIndex < 0 || selIndex >= snapshots.length - 1)}>Older <ArrowRight size={14} /></button>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
