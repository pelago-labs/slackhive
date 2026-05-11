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
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: bg,
        color: fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.4),
        fontWeight: 600,
        flexShrink: 0,
        letterSpacing: '0.02em',
      }}
    >
      {initials(name)}
    </span>
  );
}

// ─── Switch toggle ────────────────────────────────────────────────────────
function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 999,
        border: 'none',
        background: checked ? 'var(--accent)' : 'var(--surface-3)',
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 120ms ease',
        flexShrink: 0,
        padding: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 999,
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
          transition: 'left 120ms ease',
        }}
      />
    </button>
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
    <div style={{ width: '100%' }}>
      {/* ── Page header ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, marginBottom: 22 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Users size={20} strokeWidth={2.2} /> Audiences
          </h2>
          <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.5, maxWidth: 640 }}>
            Group users so the agent answers them in a different style. Each group's
            instructions are appended in priority order when one of its members messages
            the agent — lower number applies first.
          </p>
        </div>
        {canEdit && (
          <button onClick={() => setCreating(true)} style={{ ...btnPrimary, flexShrink: 0 }}>
            <Plus size={14} strokeWidth={2.5} /> New audience
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: 'var(--red-soft-bg)', color: 'var(--red)', border: '1px solid var(--red-soft-border)', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
          Couldn't load audiences: {error}
        </div>
      )}

      {/* ── Group list ──────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', padding: 24, fontSize: 13 }}>
          <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
        </div>
      ) : groups.length === 0 ? (
        <EmptyState canEdit={canEdit} onCreate={() => setCreating(true)} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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

// ─── Empty state ──────────────────────────────────────────────────────────
function EmptyState({ canEdit, onCreate }: { canEdit: boolean; onCreate: () => void }) {
  return (
    <div style={{
      padding: '48px 24px',
      textAlign: 'center',
      border: '1px dashed var(--border-2)',
      borderRadius: 12,
      background: 'var(--surface)',
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 999,
        background: 'var(--surface-2)', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
        marginBottom: 12, color: 'var(--muted)',
      }}>
        <MessageSquareMore size={20} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text)' }}>No audiences yet</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, maxWidth: 380, marginLeft: 'auto', marginRight: 'auto' }}>
        Create your first audience to make the agent respond differently to specific groups of users.
      </div>
      {canEdit && (
        <button onClick={onCreate} style={{ ...btnPrimary, marginTop: 16 }}>
          <Plus size={14} strokeWidth={2.5} /> New audience
        </button>
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
  const [hover, setHover] = useState(false);
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: 'var(--surface)',
      boxShadow: expanded ? 'var(--shadow-md)' : 'var(--shadow-sm)',
      transition: 'box-shadow 120ms ease, border-color 120ms ease',
      overflow: 'hidden',
    }}>
      <button
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          all: 'unset',
          boxSizing: 'border-box',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          cursor: 'pointer',
          background: hover && !expanded ? 'var(--surface-2)' : 'transparent',
          transition: 'background 100ms ease',
        }}
      >
        <span style={{ color: 'var(--muted)', display: 'inline-flex' }}>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <Avatar name={group.name} size={32} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {group.name}
          </span>
          {group.description && (
            <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
  const tones: Record<string, React.CSSProperties> = {
    accent:  { background: 'var(--surface-3)', color: 'var(--text)' },
    muted:   { background: 'transparent',      color: 'var(--muted)', border: '1px solid var(--border)' },
    success: { background: 'rgba(5,150,105,0.10)',  color: 'var(--green)' },
    warning: { background: 'var(--amber-soft-bg)',  color: 'var(--amber)' },
  };
  return (
    <span style={{
      ...tones[tone],
      fontSize: 11,
      fontWeight: 500,
      padding: '3px 9px',
      borderRadius: 999,
      whiteSpace: 'nowrap',
      lineHeight: 1.4,
    }}>
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
const ACCESS_LEVEL_STYLE: Record<'admin' | 'owner' | 'edit' | 'view' | 'trigger', { bg: string; fg: string }> = {
  admin:   { bg: 'rgba(220,38,38,0.10)',     fg: '#dc2626' },
  owner:   { bg: 'rgba(217,119,6,0.10)',     fg: '#d97706' },
  edit:    { bg: 'rgba(37,99,235,0.10)',     fg: '#2563eb' },
  view:    { bg: 'var(--surface-3)',         fg: 'var(--text)' },
  trigger: { bg: 'rgba(5,150,105,0.10)',     fg: 'var(--green)' },
};
function AccessLevelPill({ level }: { level: 'admin' | 'owner' | 'edit' | 'view' | 'trigger' }) {
  const s = ACCESS_LEVEL_STYLE[level];
  return (
    <span style={{
      background: s.bg, color: s.fg,
      fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
      padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap', lineHeight: 1.4,
    }}>
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
    <div style={{
      borderTop: '1px solid var(--border)',
      padding: 22,
      background: 'var(--surface-2)',
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 380px)',
      gap: 18,
      alignItems: 'start',
    }}>
      {/* ── Settings card ──────────────────────────────────────────── */}
      <section style={card}>
        {/* Identity */}
        <CardHeader title="Identity" />
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <Field label="Name">
            <input
              value={draft.name ?? ''}
              disabled={!canEdit}
              onChange={e => { patchDraft({ name: e.target.value }); setSaveError(null); }}
              style={{ ...inp, border: `1px solid ${saveError?.field === 'name' ? 'var(--red)' : 'var(--border-2)'}` }}
            />
            {saveError?.field === 'name' && (
              <span style={{ color: 'var(--red)', fontSize: 12 }}>{saveError.message}</span>
            )}
          </Field>
          <Field label="Priority" hint="must be unique · lower applies first">
            <input
              type="number"
              value={draft.priority ?? 100}
              disabled={!canEdit}
              onChange={e => {
                const n = Number(e.target.value);
                patchDraft({ priority: Number.isFinite(n) ? n : 100 });
                setSaveError(null);
              }}
              style={{ ...inp, border: `1px solid ${saveError?.field === 'priority' ? 'var(--red)' : 'var(--border-2)'}` }}
            />
            {saveError?.field === 'priority' && (
              <span style={{ color: 'var(--red)', fontSize: 12 }}>{saveError.message}</span>
            )}
          </Field>
        </div>
        <Field label="Description" hint="optional, internal note">
          <input
            value={draft.description ?? ''}
            disabled={!canEdit}
            onChange={e => patchDraft({ description: e.target.value })}
            style={inp}
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
            <button
              onClick={polish}
              disabled={polishing || saving}
              style={{ ...btnGhost, padding: '5px 10px', height: 28, fontSize: 12 }}
              title={saving ? 'Save in progress…' : (draft.instructions ?? '').trim().length < 8 ? 'Generate from audience name' : 'Polish the current draft'}
            >
              {polishing ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={12} />}
              {polishing ? 'Drafting…' : (draft.instructions ?? '').trim().length < 8 ? 'Generate with AI' : 'Polish with AI'}
            </button>
          )}
        >
          <textarea
            value={draft.instructions ?? ''}
            disabled={!canEdit || polishing}
            onChange={e => patchDraft({ instructions: e.target.value })}
            rows={6}
            style={{ ...inp, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.55 }}
            placeholder="e.g. Keep replies under 3 sentences. Avoid jargon. Address the user as 'Dear colleague'."
          />
          {polishError && <span style={{ color: 'var(--red)', fontSize: 12 }}>AI polish failed: {polishError}</span>}
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
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 6,
            paddingTop: 14,
            borderTop: '1px solid var(--border)',
          }}>
            <button onClick={() => setConfirmDelete(true)} style={btnTextDanger}>
              <Trash2 size={13} /> Delete audience
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {savedFlash && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--green)' }}>
                  <Check size={13} strokeWidth={2.5} /> Saved
                </span>
              )}
              {saveError && !saveError.field && (
                <span style={{ fontSize: 12, color: 'var(--red)' }}>{saveError.message}</span>
              )}
              <button
                onClick={saveMeta}
                disabled={saving || polishing}
                style={btnPrimary}
                title={polishing ? 'AI polish in progress…' : undefined}
              >
                {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={14} />}
                Save changes
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── Members card ───────────────────────────────────────────── */}
      <section style={{ ...card, position: 'sticky', top: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <CardHeader title="Members" inline />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Pill tone="muted">{members.length} of {allUsers.length}</Pill>
            {savingMembers && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />}
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--subtle)' }} />
          <input
            placeholder="Search users…"
            value={memberSearch}
            onChange={e => setMemberSearch(e.target.value)}
            style={{ ...inp, paddingLeft: 30 }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
          {membersStatus === 'idle' ? (
            <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13, textAlign: 'center', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading members…
            </div>
          ) : membersStatus === 'error' ? (
            <div style={{ padding: 12, color: 'var(--red)', fontSize: 13, textAlign: 'center', background: 'var(--red-soft-bg)', border: '1px solid var(--red-soft-border)', borderRadius: 6 }}>
              Couldn't load members. Toggling is disabled until this loads — try collapsing and re-expanding the row.
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
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
                style={{
                  all: 'unset',
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  cursor: canEdit ? 'pointer' : 'default',
                  background: selected ? 'var(--surface-2)' : 'transparent',
                  transition: 'background 100ms ease',
                }}
                onMouseEnter={e => { if (canEdit && !selected) e.currentTarget.style.background = 'var(--surface-2)'; }}
                onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
              >
                <Avatar name={u.username} size={28} />
                <span style={{ flex: 1, fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{u.username}</span>
                {/* Effective access on this agent — admin/owner/edit/view/trigger.
                    listAgentEligibleUsers always populates accessLevel. */}
                <AccessLevelPill level={u.accessLevel} />
                <span style={{
                  width: 18, height: 18, borderRadius: 5,
                  border: selected ? '1px solid var(--accent)' : '1px solid var(--border-2)',
                  background: selected ? 'var(--accent)' : 'transparent',
                  color: 'var(--accent-fg)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {selected && <Check size={12} strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {confirmDelete && (
        <div style={modalBackdrop} onClick={() => setConfirmDelete(false)}>
          <div style={modalCard} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Delete "{group.name}"?</h3>
            <p style={{ color: 'var(--muted)', fontSize: 13, margin: '10px 0 18px', lineHeight: 1.5 }}>
              Members will lose this group's instructions on their next message. This can't be undone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setConfirmDelete(false)} style={btnGhost}>Cancel</button>
              <button onClick={deleteGroup} style={btnDanger}>Delete</button>
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
    <div style={{
      fontSize: 11,
      fontWeight: 600,
      color: 'var(--muted)',
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      marginBottom: inline ? 0 : 6,
    }}>
      {title}
    </div>
  );
}

function Field({ label, hint, right, children }: { label: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)' }}>
          {label}
          {hint && <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>· {hint}</span>}
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
    <div
      role="group"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        padding: 14,
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface)',
      }}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{subtitle}</span>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '4px -2px' }} />;
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
    <div style={modalBackdrop} onClick={onClose}>
      <div style={{ ...modalCard, width: 560 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>New audience</h3>
          <button onClick={onClose} style={iconBtn}><X size={16} /></button>
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="Name">
            <input value={name} onChange={e => setName(e.target.value)} style={inp} placeholder="e.g. Marketing" />
          </Field>
          <Field label="Description" hint="optional">
            <input value={description} onChange={e => setDescription(e.target.value)} style={inp} />
          </Field>
          <Field label="Priority" hint="lower applies first">
            <input type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} style={inp} />
          </Field>
          <Field
            label="Instructions"
            right={(
              <button
                onClick={polish}
                disabled={polishing || saving}
                style={{ ...btnGhost, padding: '5px 10px', height: 28, fontSize: 12 }}
                title={instructions.trim().length < 8 ? 'Generate from audience name' : 'Polish the current draft'}
              >
                {polishing ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={12} />}
                {polishing ? 'Drafting…' : instructions.trim().length < 8 ? 'Generate with AI' : 'Polish with AI'}
              </button>
            )}
          >
            <textarea
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              rows={4}
              disabled={polishing}
              style={{ ...inp, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.55 }}
              placeholder="e.g. Keep replies brief and avoid technical jargon."
            />
          </Field>
          <ToggleRow
            checked={verbose}
            onChange={setVerbose}
            title="Verbose for this audience"
            subtitle="ON: detailed reply for members (overrides agent default). OFF: agent default applies."
          />
          {error && <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <button onClick={onClose} style={btnGhost}>Cancel</button>
            <button onClick={submit} disabled={saving} style={btnPrimary}>
              {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />}
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Inline styles ────────────────────────────────────────────────────────
const card: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  minWidth: 0,
  boxShadow: 'var(--shadow-sm)',
};

const inp: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--border-2)',
  borderRadius: 6,
  background: 'var(--surface)',
  color: 'var(--text)',
  fontSize: 13.5,
  fontFamily: 'var(--font-sans)',
  width: '100%',
  boxSizing: 'border-box',
  outline: 'none',
  transition: 'border-color 100ms ease, box-shadow 100ms ease',
};

const btnBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 12px',
  height: 32,
  border: '1px solid var(--border-2)',
  borderRadius: 6,
  background: 'var(--surface)',
  color: 'var(--text)',
  fontSize: 13,
  fontFamily: 'var(--font-sans)',
  fontWeight: 500,
  lineHeight: 1,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background 100ms ease, border-color 100ms ease',
};
const btnPrimary: React.CSSProperties = {
  ...btnBase,
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  border: '1px solid transparent',
  boxShadow: 'var(--shadow-sm)',
};
const btnDanger: React.CSSProperties = {
  ...btnBase,
  color: 'var(--red)',
  borderColor: 'var(--red-soft-border)',
  background: 'var(--red-soft-bg)',
};
const btnTextDanger: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  fontSize: 12.5,
  cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
  borderRadius: 6,
};
const btnGhost: React.CSSProperties = { ...btnBase };
const iconBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--muted)',
  borderRadius: 6,
};
const modalBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
  backdropFilter: 'blur(2px)',
};
const modalCard: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius, 10px)',
  padding: 22,
  minWidth: 420,
  maxWidth: '90vw',
  maxHeight: '90vh',
  overflowY: 'auto',
  boxShadow: 'var(--shadow-modal, 0 20px 60px rgba(0,0,0,0.15))',
  color: 'var(--text)',
};
