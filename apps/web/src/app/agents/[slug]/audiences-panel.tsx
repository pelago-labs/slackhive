'use client';

/**
 * @fileoverview Audiences tab — manage per-agent groups whose members get
 * extra response-style instructions appended at message time.
 *
 * @module web/app/agents/[slug]/audiences-panel
 */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Users, Plus, Trash2, ChevronDown, ChevronRight, Loader2, Save, X, Sparkles, Search, Check, MessageSquareMore } from 'lucide-react';
import type { AgentGroup } from '@slackhive/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Spinner, EmptyState } from '@/components/patterns';

interface BasicUser {
  id: string;
  username: string;
  role: string;
  source?: 'admin' | 'creator' | 'access';
  /** Effective access level on this specific agent. Always populated by the
   *  server; the audience picker renders the colour-coded pill from this. */
  accessLevel: 'admin' | 'owner' | 'edit' | 'view' | 'trigger';
}
interface Member { userId: string; username: string }

interface DraftPatch {
  name?: string;
  description?: string | null;
  instructions?: string;
  priority?: number;
  verbose?: boolean;
}

// ─── Avatar palette ───────────────────────────────────────────────────────
// Soft pastel bg + darker fg letter. Mirrors AVATAR_PALETTES on the page.
const AVATAR_PALETTES: { bg: string; fg: string }[] = [
  { bg: '#fef3c7', fg: '#92400e' }, { bg: '#fce7f3', fg: '#9d174d' },
  { bg: '#ede9fe', fg: '#5b21b6' }, { bg: '#dbeafe', fg: '#1e40af' },
  { bg: '#cffafe', fg: '#155e75' }, { bg: '#dcfce7', fg: '#166534' },
  { bg: '#ecfccb', fg: '#3f6212' }, { bg: '#fee2e2', fg: '#991b1b' },
  { bg: '#ffedd5', fg: '#9a3412' }, { bg: '#f3f4f6', fg: '#1f2937' },
];
function paletteFor(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTES[Math.abs(h) % AVATAR_PALETTES.length];
}
function initials(name: string): string {
  const parts = name.trim().split(/[\s_\-.]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const { bg, fg } = paletteFor(name);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-[0.02em]"
      style={{
        width: size,
        height: size,
        background: bg,
        color: fg,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initials(name)}
    </span>
  );
}

// ─── Saved flash ──────────────────────────────────────────────────────────
function useSavedFlash(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear pending timer on unmount so the late setShown(false) doesn't fire
  // on a dead component.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  const trigger = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setShown(true);
    timerRef.current = setTimeout(() => setShown(false), 1800);
  };
  return [shown, trigger];
}

// ─── Top-level panel ──────────────────────────────────────────────────────
export function AudiencesPanel({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/groups`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setGroups(json.groups ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, [agentId]);

  return (
    <div className="w-full">
      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="mb-[22px] flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
            <Users size={20} strokeWidth={2.2} /> Audiences
          </h2>
          <p className="mt-1.5 max-w-[640px] text-sm leading-normal text-muted-foreground">
            Group users so the agent answers them in a different style. Each group's
            instructions are appended in priority order when one of its members messages
            the agent — lower number applies first.
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => setCreating(true)} className="shrink-0">
            <Plus size={14} strokeWidth={2.5} /> New audience
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-3.5 rounded-md border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
          Couldn't load audiences: {error}
        </div>
      )}

      {/* ── Group list ──────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Spinner size={16} /> Loading…
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<MessageSquareMore size={20} />}
          title="No audiences yet"
          hint="Create your first audience to make the agent respond differently to specific groups of users."
          action={canEdit && (
            <Button onClick={() => setCreating(true)}>
              <Plus size={14} strokeWidth={2.5} /> New audience
            </Button>
          )}
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {groups.map(g => (
            <GroupRow
              key={g.id}
              agentId={agentId}
              group={g}
              expanded={expanded === g.id}
              onToggle={() => setExpanded(prev => prev === g.id ? null : g.id)}
              canEdit={canEdit}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {creating && (
        <CreateGroupModal
          agentId={agentId}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Group row ────────────────────────────────────────────────────────────
function GroupRow({
  agentId,
  group,
  expanded,
  onToggle,
  canEdit,
  onChanged,
}: {
  agentId: string;
  group: AgentGroup;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  onChanged: () => void;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border bg-card transition-shadow',
        expanded ? 'shadow-md' : 'shadow-sm',
      )}
    >
      <button
        onClick={onToggle}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors',
          !expanded && 'hover:bg-secondary',
        )}
      >
        <span className="inline-flex text-muted-foreground">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <Avatar name={group.name} size={32} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-semibold text-foreground">
            {group.name}
          </span>
          {group.description && (
            <span className="truncate text-xs text-muted-foreground">
              {group.description}
            </span>
          )}
        </span>
        {group.verbose && <Pill tone="accent">verbose</Pill>}
        <Pill tone="muted">priority {group.priority}</Pill>
        <Pill tone="muted">{group.memberCount ?? 0} {group.memberCount === 1 ? 'member' : 'members'}</Pill>
      </button>
      {expanded && (
        <GroupEditor agentId={agentId} group={group} canEdit={canEdit} onChanged={onChanged} />
      )}
    </div>
  );
}

// ─── Pill ─────────────────────────────────────────────────────────────────
function Pill({ children, tone }: { children: React.ReactNode; tone: 'accent' | 'muted' | 'success' | 'warning' }) {
  const tones: Record<string, string> = {
    accent:  'bg-secondary text-foreground',
    muted:   'bg-transparent text-muted-foreground border border-border',
    success: 'bg-green/10 text-green',
    warning: 'bg-amber/10 text-amber',
  };
  return (
    <span className={cn('whitespace-nowrap rounded-full px-2.5 py-[3px] text-2xs font-medium leading-tight', tones[tone])}>
      {children}
    </span>
  );
}

// ─── Access-level pill ────────────────────────────────────────────────────
// Color-coded so the audience admin can tell at a glance whether a candidate
// member is a workspace-wide admin, the agent owner, or has a specific
// per-agent grant (edit / view / trigger). Without this, the picker rendered
// the user's *platform role* (viewer/editor) — which says nothing about
// whether they can actually trigger this agent.
const ACCESS_LEVEL_STYLE: Record<'admin' | 'owner' | 'edit' | 'view' | 'trigger', string> = {
  admin:   'bg-red/10 text-red',
  owner:   'bg-amber/10 text-amber',
  edit:    'bg-blue/10 text-blue',
  view:    'bg-secondary text-foreground',
  trigger: 'bg-green/10 text-green',
};
function AccessLevelPill({ level }: { level: 'admin' | 'owner' | 'edit' | 'view' | 'trigger' }) {
  return (
    <span className={cn('whitespace-nowrap rounded-full px-2 py-[3px] text-[10.5px] font-semibold uppercase leading-tight tracking-[0.04em]', ACCESS_LEVEL_STYLE[level])}>
      {level}
    </span>
  );
}

// ─── Group editor ─────────────────────────────────────────────────────────
function GroupEditor({
  agentId,
  group,
  canEdit,
  onChanged,
}: {
  agentId: string;
  group: AgentGroup;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<DraftPatch>({
    name: group.name,
    description: group.description ?? '',
    instructions: group.instructions ?? '',
    priority: group.priority,
    verbose: group.verbose,
  });
  // Track whether the user has made unsaved local edits. We sync `draft` from
  // a refreshed `group` only when the local copy is clean — that way a parent
  // refresh (e.g. after another tab saved) doesn't blow away in-progress
  // edits, but a clean editor stays in sync with the latest server state.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setDraft({
      name: group.name,
      description: group.description ?? '',
      instructions: group.instructions ?? '',
      priority: group.priority,
      verbose: group.verbose,
    });
    // We intentionally only depend on the fields that come back from the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id, group.updatedAt]);
  function patchDraft(patch: Partial<DraftPatch>) {
    setDraft(d => ({ ...d, ...patch }));
    setDirty(true);
  }
  const [saving, setSaving] = useState(false);
  const [savedFlash, flashSaved] = useSavedFlash();
  const [saveError, setSaveError] = useState<{ field?: string; message: string } | null>(null);
  const [polishing, setPolishing] = useState(false);
  const [polishError, setPolishError] = useState<string | null>(null);
  const [allUsers, setAllUsers] = useState<BasicUser[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  // 'idle' until the first fetch has resolved one way or the other. Toggle is
  // gated on 'loaded' so a failed initial fetch (which sets members to [])
  // can never round-trip and accidentally mass-delete real members.
  const [membersStatus, setMembersStatus] = useState<'idle' | 'loaded' | 'error'>('idle');
  const [memberSearch, setMemberSearch] = useState('');
  const [savingMembers, setSavingMembers] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Track mount state so async callbacks (saveMeta, polish, toggleMember)
  // don't call setState on a component that has been unmounted — happens when
  // the user collapses a row mid-request, or navigates tabs.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    // AbortController guards against stale-response races: rapidly toggling
    // between groups would otherwise let an older fetch land last and clobber
    // the newer group's members list.
    const ctrl = new AbortController();
    setMembersStatus('idle');
    fetch(`/api/agents/${agentId}/eligible-users`, { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : { users: [] })
      .then(j => setAllUsers(j.users ?? []))
      .catch(err => { if (err?.name !== 'AbortError') setAllUsers([]); });
    fetch(`/api/agents/${agentId}/groups/${group.id}/members`, { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => { setMembers(j.members ?? []); setMembersStatus('loaded'); })
      .catch(err => {
        if (err?.name === 'AbortError') return;
        setMembers([]);
        setMembersStatus('error');
      });
    return () => ctrl.abort();
  }, [agentId, group.id]);

  const memberIds = useMemo(() => new Set(members.map(m => m.userId)), [members]);

  async function saveMeta() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/groups/${group.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (!mountedRef.current) return;
        setSaveError({ field: body.field, message: body.error ?? `HTTP ${res.status}` });
        return;
      }
      flashSaved();
      setDirty(false);
      onChanged();
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  async function toggleMember(userId: string) {
    if (!canEdit) return;
    // Refuse toggles before the initial members list has loaded — otherwise a
    // failed initial fetch leaves us with members=[] and a single click would
    // PUT just one user, mass-deleting everyone else.
    if (membersStatus !== 'loaded') return;
    setSavingMembers(true);
    try {
      const next = memberIds.has(userId)
        ? members.filter(m => m.userId !== userId).map(m => m.userId)
        : [...members.map(m => m.userId), userId];
      const res = await fetch(`/api/agents/${agentId}/groups/${group.id}/members`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: next }),
      });
      if (!mountedRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!mountedRef.current) return;
      setMembers(json.members ?? []);
      onChanged();
    } finally {
      if (mountedRef.current) setSavingMembers(false);
    }
  }

  async function polish() {
    setPolishing(true);
    setPolishError(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(`/api/agents/${agentId}/groups/polish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audienceName: draft.name ?? group.name,
          audienceDescription: draft.description ?? group.description ?? '',
          verbose: !!draft.verbose,
          draft: draft.instructions ?? '',
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(errText);
      }
      const json = await res.json();
      if (!mountedRef.current) return;
      if (typeof json.text === 'string' && json.text.trim()) {
        patchDraft({ instructions: json.text });
      } else {
        setPolishError('AI returned an empty draft — try clicking again or write the instructions manually.');
      }
    } catch (e) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? (e.name === 'AbortError' ? 'Timed out after 60s — the runner may still be busy.' : e.message) : String(e);
      setPolishError(msg);
    } finally {
      clearTimeout(timer);
      if (mountedRef.current) setPolishing(false);
    }
  }

  async function deleteGroup() {
    const res = await fetch(`/api/agents/${agentId}/groups/${group.id}`, { method: 'DELETE' });
    if (!res.ok) {
      alert(`Delete failed: ${res.status}`);
      return;
    }
    onChanged();
  }

  const filtered = allUsers.filter(u =>
    !memberSearch.trim() ? true : u.username.toLowerCase().includes(memberSearch.toLowerCase())
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(300px,380px)] items-start gap-[18px] border-t border-border bg-secondary p-[22px]">
      {/* ── Settings card ──────────────────────────────────────────── */}
      <section className={cn(card, 'min-w-0')}>
        {/* Identity */}
        <CardHeader title="Identity" />
        <div className="grid grid-cols-[2fr_1fr] gap-3">
          <Field label="Name">
            <Input
              value={draft.name ?? ''}
              disabled={!canEdit}
              onChange={e => { patchDraft({ name: e.target.value }); setSaveError(null); }}
              className={cn(saveError?.field === 'name' && 'border-destructive')}
            />
            {saveError?.field === 'name' && (
              <span className="text-xs text-destructive">{saveError.message}</span>
            )}
          </Field>
          <Field label="Priority" hint="must be unique · lower applies first">
            <Input
              type="number"
              value={draft.priority ?? 100}
              disabled={!canEdit}
              onChange={e => {
                const n = Number(e.target.value);
                patchDraft({ priority: Number.isFinite(n) ? n : 100 });
                setSaveError(null);
              }}
              className={cn(saveError?.field === 'priority' && 'border-destructive')}
            />
            {saveError?.field === 'priority' && (
              <span className="text-xs text-destructive">{saveError.message}</span>
            )}
          </Field>
        </div>
        <Field label="Description" hint="optional, internal note">
          <Input
            value={draft.description ?? ''}
            disabled={!canEdit}
            onChange={e => patchDraft({ description: e.target.value })}
            placeholder="What sets this audience apart"
          />
        </Field>

        <Divider />

        {/* Behavior */}
        <CardHeader title="Behavior" />
        <Field
          label="Instructions"
          hint="appended to the agent's prompt for members"
          right={canEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={polish}
              disabled={polishing || saving}
              title={saving ? 'Save in progress…' : (draft.instructions ?? '').trim().length < 8 ? 'Generate from audience name' : 'Polish the current draft'}
            >
              {polishing ? <Spinner size={12} /> : <Sparkles size={12} />}
              {polishing ? 'Drafting…' : (draft.instructions ?? '').trim().length < 8 ? 'Generate with AI' : 'Polish with AI'}
            </Button>
          )}
        >
          <Textarea
            value={draft.instructions ?? ''}
            disabled={!canEdit || polishing}
            onChange={e => patchDraft({ instructions: e.target.value })}
            rows={6}
            className="resize-y leading-relaxed"
            placeholder="e.g. Keep replies under 3 sentences. Avoid jargon. Address the user as 'Dear colleague'."
          />
          {polishError && <span className="text-xs text-destructive">AI polish failed: {polishError}</span>}
        </Field>

        <ToggleRow
          checked={!!draft.verbose}
          disabled={!canEdit}
          onChange={v => patchDraft({ verbose: v })}
          title="Verbose for this audience"
          subtitle="ON: members get a detailed final reply, no progress narration (overrides agent default). OFF: no opinion — the agent's own verbose setting applies."
        />

        {/* Footer */}
        {canEdit && (
          <div className="mt-1.5 flex items-center justify-between border-t border-border pt-3.5">
            <button
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Trash2 size={13} /> Delete audience
            </button>
            <div className="flex items-center gap-2.5">
              {savedFlash && (
                <span className="inline-flex items-center gap-1 text-xs text-green">
                  <Check size={13} strokeWidth={2.5} /> Saved
                </span>
              )}
              {saveError && !saveError.field && (
                <span className="text-xs text-destructive">{saveError.message}</span>
              )}
              <Button
                onClick={saveMeta}
                disabled={saving || polishing}
                title={polishing ? 'AI polish in progress…' : undefined}
              >
                {saving ? <Spinner size={14} className="text-primary-foreground" /> : <Save size={14} />}
                Save changes
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* ── Members card ───────────────────────────────────────────── */}
      <section className={cn(card, 'sticky top-4')}>
        <div className="mb-1 flex items-center justify-between">
          <CardHeader title="Members" inline />
          <div className="flex items-center gap-2">
            <Pill tone="muted">{members.length} of {allUsers.length}</Pill>
            {savingMembers && <Spinner size={14} />}
          </div>
        </div>

        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search users…"
            value={memberSearch}
            onChange={e => setMemberSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        <div className="mt-1 flex flex-col gap-0.5">
          {membersStatus === 'idle' ? (
            <div className="inline-flex items-center justify-center gap-1.5 p-4 text-center text-sm text-muted-foreground">
              <Spinner size={14} /> Loading members…
            </div>
          ) : membersStatus === 'error' ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-center text-sm text-destructive">
              Couldn't load members. Toggling is disabled until this loads — try collapsing and re-expanding the row.
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {allUsers.length === 0
                ? 'No users can trigger this agent yet. Grant access from the Overview tab first.'
                : 'No matching users.'}
            </div>
          ) : filtered.map(u => {
            const selected = memberIds.has(u.id);
            return (
              <button
                key={u.id}
                onClick={() => toggleMember(u.id)}
                disabled={!canEdit}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                  canEdit ? 'cursor-pointer' : 'cursor-default',
                  selected ? 'bg-secondary' : 'bg-transparent',
                  canEdit && !selected && 'hover:bg-secondary',
                )}
              >
                <Avatar name={u.username} size={28} />
                <span className="flex-1 text-sm font-medium text-foreground">{u.username}</span>
                {/* Effective access on this agent — admin/owner/edit/view/trigger.
                    listAgentEligibleUsers always populates accessLevel. */}
                <AccessLevelPill level={u.accessLevel} />
                <span
                  className={cn(
                    'inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border text-primary-foreground',
                    selected ? 'border-primary bg-primary' : 'border-input bg-transparent',
                  )}
                >
                  {selected && <Check size={12} strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {confirmDelete && (
        <div className={modalBackdrop} onClick={() => setConfirmDelete(false)}>
          <div className={modalCard} onClick={e => e.stopPropagation()}>
            <h3 className="text-md font-semibold">Delete "{group.name}"?</h3>
            <p className="mb-[18px] mt-2.5 text-sm leading-normal text-muted-foreground">
              Members will lose this group's instructions on their next message. This can't be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button variant="destructive" onClick={deleteGroup}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Card primitives ──────────────────────────────────────────────────────
function CardHeader({ title, inline }: { title: string; inline?: boolean }) {
  return (
    <div className={cn('text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground', !inline && 'mb-1.5')}>
      {title}
    </div>
  );
}

function Field({ label, hint, right, children }: { label: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {label}
          {hint && <span className="ml-1.5 font-normal text-muted-foreground">· {hint}</span>}
        </span>
        {right}
      </span>
      {children}
    </label>
  );
}

function ToggleRow({ checked, onChange, disabled, title, subtitle }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title: string;
  subtitle: string;
}) {
  return (
    <div role="group" className="flex items-start gap-3.5 rounded-md border border-border bg-card p-3.5">
      <div className="flex flex-1 flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs leading-normal text-muted-foreground">{subtitle}</span>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function Divider() {
  return <div className="mx-[-2px] my-1 h-px bg-border" />;
}

// ─── Create modal ─────────────────────────────────────────────────────────
function CreateGroupModal({ agentId, onClose, onCreated }: { agentId: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(100);
  const [instructions, setInstructions] = useState('');
  const [verbose, setVerbose] = useState(false);
  const [saving, setSaving] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function polish() {
    if (!name.trim()) { setError('Add a name first so AI knows what to write for'); return; }
    setPolishing(true);
    setError(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(`/api/agents/${agentId}/groups/polish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audienceName: name.trim(),
          audienceDescription: description,
          verbose,
          draft: instructions,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(errText);
      }
      const json = await res.json();
      if (typeof json.text === 'string' && json.text.trim()) {
        setInstructions(json.text);
      }
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'AbortError' ? 'Timed out after 60s — the runner may still be busy.' : e.message) : String(e);
      setError(msg);
    } finally {
      clearTimeout(timer);
      setPolishing(false);
    }
  }

  async function submit() {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description, priority, instructions, verbose }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={modalBackdrop} onClick={onClose}>
      <div className={cn(modalCard, 'w-[560px]')} onClick={e => e.stopPropagation()}>
        <div className="mb-3.5 flex items-center justify-between">
          <h3 className="text-md font-semibold">New audience</h3>
          <button
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>
        <div className="grid gap-3">
          <Field label="Name">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Marketing" />
          </Field>
          <Field label="Description" hint="optional">
            <Input value={description} onChange={e => setDescription(e.target.value)} />
          </Field>
          <Field label="Priority" hint="lower applies first">
            <Input type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} />
          </Field>
          <Field
            label="Instructions"
            right={(
              <Button
                variant="outline"
                size="sm"
                onClick={polish}
                disabled={polishing || saving}
                title={instructions.trim().length < 8 ? 'Generate from audience name' : 'Polish the current draft'}
              >
                {polishing ? <Spinner size={12} /> : <Sparkles size={12} />}
                {polishing ? 'Drafting…' : instructions.trim().length < 8 ? 'Generate with AI' : 'Polish with AI'}
              </Button>
            )}
          >
            <Textarea
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              rows={4}
              disabled={polishing}
              className="resize-y leading-relaxed"
              placeholder="e.g. Keep replies brief and avoid technical jargon."
            />
          </Field>
          <ToggleRow
            checked={verbose}
            onChange={setVerbose}
            title="Verbose for this audience"
            subtitle="ON: detailed reply for members (overrides agent default). OFF: agent default applies."
          />
          {error && <div className="text-sm text-destructive">{error}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Spinner size={14} className="text-primary-foreground" /> : <Plus size={14} />}
              Create
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Shared className tokens ──────────────────────────────────────────────
const card = 'flex flex-col gap-3.5 rounded-lg border border-border bg-card p-[18px] shadow-sm';
const modalBackdrop = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-[2px]';
const modalCard = 'max-h-[90vh] min-w-[420px] max-w-[90vw] overflow-y-auto rounded-lg border border-border bg-card p-[22px] text-foreground shadow-lg';
