'use client';

/**
 * @fileoverview Platform settings page — branding, dashboard, and user management.
 *
 * Tabs: General · Users (admin only)
 *
 * @module web/app/settings
 */

import React, { useEffect, useState } from 'react';
import { KeyRound, SlidersHorizontal, Bot, ShieldCheck, LogIn, Users } from 'lucide-react';
import {
  MODELS,
  DEFAULT_COACH_MODEL,
  COACH_MODEL_SETTING_KEY,
  DEFAULT_EVAL_JUDGE_MODEL,
  EVAL_JUDGE_MODEL_SETTING_KEY,
} from '@slackhive/shared/models';
import { Portal } from '@/lib/portal';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { PageShell } from '@/components/patterns';
import { toast as sonnerToast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import AiProviderSection from './AiProviderSection';

type SettingsSection = 'general' | 'ai' | 'access' | 'signin' | 'users';

interface User {
  id: string;
  username: string;
  role: string;
  createdAt: string;
  fromSlack?: boolean;
  agentCount?: number;
}

interface AgentBasic {
  id: string;
  name: string;
  slug: string;
}

const DEFAULTS: Record<string, string> = {
  appName: 'SlackHive',
  logoUrl: '',
  dashboardTitle: 'Welcome to SlackHive',
  [COACH_MODEL_SETTING_KEY]: DEFAULT_COACH_MODEL,
  [EVAL_JUDGE_MODEL_SETTING_KEY]: DEFAULT_EVAL_JUDGE_MODEL,
};

/**
 * Settings page with General and Users tabs.
 *
 * @returns {JSX.Element}
 */
export default function SettingsPage() {
  const { canManageUsers, role } = useAuth();
  const isSuperadmin = role === 'superadmin';
  const [section, setSection] = useState<SettingsSection>('general');

  const nav = ([
    { id: 'general', label: 'General',            Icon: SlidersHorizontal, show: true },
    { id: 'ai',      label: 'AI Backend',         Icon: Bot,               show: canManageUsers },
    { id: 'access',  label: 'Access Control',      Icon: ShieldCheck,       show: canManageUsers },
    { id: 'signin',  label: 'Sign in with Slack',  Icon: LogIn,             show: canManageUsers && isSuperadmin },
    { id: 'users',   label: 'Users',              Icon: Users,             show: canManageUsers },
  ] as const).filter(n => n.show);

  // Guard against a stale selection if a section becomes hidden (perm change).
  const active: SettingsSection = nav.some(n => n.id === section) ? section : 'general';

  return (
    <PageShell>
      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 text-xl font-bold tracking-tight text-foreground">
          Settings
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure platform branding, appearance, and access.
        </p>
      </div>

      {/* Side-nav + content */}
      <div className="flex flex-wrap items-start gap-7">
        <nav className="flex w-[200px] flex-shrink-0 flex-col gap-0.5">
          {nav.map(n => (
            <button
              key={n.id}
              onClick={() => setSection(n.id)}
              className={cn(
                'inline-flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm',
                active === n.id
                  ? 'bg-secondary font-semibold text-foreground'
                  : 'font-normal text-muted-foreground',
              )}
            ><n.Icon size={15} />{n.label}</button>
          ))}
        </nav>

        <div className="min-w-0 max-w-[760px] flex-1">
          {active === 'general' && <GeneralTab />}
          {active === 'ai'      && canManageUsers && <AITab />}
          {active === 'access'  && canManageUsers && <AccessControlSection />}
          {active === 'signin'  && canManageUsers && isSuperadmin && <AuthTab />}
          {active === 'users'   && canManageUsers && <UsersTab />}
        </div>
      </div>
    </PageShell>
  );
}

// =============================================================================
// General tab
// =============================================================================

function GeneralTab() {
  const [appName, setAppName] = useState(DEFAULTS.appName);
  const [logoUrl, setLogoUrl] = useState(DEFAULTS.logoUrl);
  const [dashboardTitle, setDashboardTitle] = useState(DEFAULTS.dashboardTitle);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((s: Record<string, string>) => {
        if (s.appName) setAppName(s.appName);
        if (s.logoUrl !== undefined && s.logoUrl !== '') setLogoUrl(s.logoUrl);
        if (s.dashboardTitle) setDashboardTitle(s.dashboardTitle);
      })
      .catch(() => {});
  }, []);

  async function save(key: string, value: string) {
    setSaving(true);
    try {
      await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      sonnerToast.success('Saved');
    } finally { setSaving(false); }
  }

  async function saveAll() {
    setSaving(true);
    try {
      await Promise.all([
        fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'appName', value: appName }) }),
        fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'logoUrl', value: logoUrl }) }),
        fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'dashboardTitle', value: dashboardTitle }) }),
      ]);
      sonnerToast.success('All settings saved');
    } finally { setSaving(false); }
  }

  return (
    <>
      <Section title="Branding">
        <Field label="App Name" hint="Displayed in the sidebar header and browser tab." maxLength={30}
          value={appName} onChange={setAppName} onBlur={() => save('appName', appName)} />
        <Field label="Logo URL" hint="URL to a square image (28×28). Leave empty for the default icon." maxLength={500}
          value={logoUrl} onChange={setLogoUrl} onBlur={() => save('logoUrl', logoUrl)} />
        <div className="mt-1 flex items-center gap-3">
          <div className="text-xs font-medium text-muted-foreground">Preview:</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoUrl || '/logo.svg'} alt="Logo" className="h-7 w-7 rounded-lg object-cover" />
          {!logoUrl && <span className="text-2xs italic text-muted-foreground">Using default logo</span>}
        </div>
      </Section>

      <Section title="Dashboard">
        <Field label="Dashboard Title" hint="Main heading on the dashboard page." maxLength={80}
          value={dashboardTitle} onChange={setDashboardTitle} onBlur={() => save('dashboardTitle', dashboardTitle)} />
      </Section>

      <div className="mt-2 flex justify-end">
        <PrimaryBtn onClick={saveAll} loading={saving}>Save All</PrimaryBtn>
      </div>
    </>
  );
}

// =============================================================================
// AI tab — agent backend + coach
// =============================================================================

function AITab() {
  const [coachModel, setCoachModel] = useState(DEFAULTS[COACH_MODEL_SETTING_KEY]);
  const [evalJudgeModel, setEvalJudgeModel] = useState(DEFAULTS[EVAL_JUDGE_MODEL_SETTING_KEY]);
  // Coach + judge run on the active backend, so their model options follow it.
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string; sub?: string }[]>([...MODELS]);

  const persist = (key: string, value: string) =>
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) }).catch(() => {});

  // Load settings + the active backend's model list together, then reconcile: if a
  // stored model isn't valid for the current backend, switch to its first model AND
  // persist that correction (so the stored value never diverges from what's shown).
  const load = async () => {
    const [s, d] = await Promise.all([
      fetch('/api/settings').then(r => r.json()).catch(() => ({} as Record<string, string>)),
      fetch('/api/system/models').then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const opts: { value: string; label: string; sub?: string }[] = d?.models?.length ? d.models : [...MODELS];
    setModelOptions(opts);
    const valid = (v: string) => opts.some(m => m.value === v);

    let cm = s[COACH_MODEL_SETTING_KEY] || DEFAULTS[COACH_MODEL_SETTING_KEY];
    if (!valid(cm)) { cm = opts[0].value; persist(COACH_MODEL_SETTING_KEY, cm); }
    setCoachModel(cm);

    let jm = s[EVAL_JUDGE_MODEL_SETTING_KEY] || DEFAULTS[EVAL_JUDGE_MODEL_SETTING_KEY];
    if (!valid(jm)) { jm = opts[0].value; persist(EVAL_JUDGE_MODEL_SETTING_KEY, jm); }
    setEvalJudgeModel(jm);
  };
  useEffect(() => { void load(); }, []);

  const saveCoach = (v: string) => { setCoachModel(v); persist(COACH_MODEL_SETTING_KEY, v); };
  const saveJudge = (v: string) => { setEvalJudgeModel(v); persist(EVAL_JUDGE_MODEL_SETTING_KEY, v); };

  return (
    <>
      <AiProviderSection onSaved={load} />
      <Section title="Coach">
        <SelectField
          label="Coach Model"
          value={coachModel}
          options={modelOptions}
          onChange={saveCoach}
          hint="Model Coach uses to generate prompts and skills — follows the active agent backend."
        />
      </Section>
      <Section title="Evals">
        <SelectField
          label="Evals Judge Model"
          value={evalJudgeModel}
          options={modelOptions}
          onChange={saveJudge}
          hint="Model the Tier 2 regression evals use to judge agent responses against rubrics — follows the active agent backend. Called once per case per run; a cheaper model keeps cost low."
        />
      </Section>
    </>
  );
}

// =============================================================================
// Users & Access tab — access control + users + authentication
// =============================================================================

function AccessControlSection() {
  const [openToWorkspace, setOpenToWorkspace] = useState(true);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then((s: Record<string, string>) => {
      setOpenToWorkspace(s.openToWorkspace !== 'false');
    }).catch(() => {});
  }, []);

  const save = (next: boolean) => {
    setOpenToWorkspace(next);
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'openToWorkspace', value: String(next) }) }).catch(() => {});
  };

  return (
    <Section title="Access Control">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="mb-1 text-sm font-medium text-foreground">Open to Workspace</div>
          <div className="text-xs leading-normal text-muted-foreground">
            {openToWorkspace
              ? <>Any Slack workspace member can message the bot — no account setup needed. Turn off to restrict access to specific imported users with a Trigger grant.</>
              : <>Only imported users with <strong>Trigger</strong> access can use the bot. Others get a message asking them to contact an admin. Import teammates and assign access below.</>
            }
          </div>
          {!openToWorkspace && (
            <div className="mt-2 rounded border-l-[3px] border-amber bg-amber/10 px-2.5 py-1.5 text-xs leading-normal text-muted-foreground">
              <strong className="text-amber">Restricted mode active.</strong> Turn on to allow all workspace members to trigger agents again.
            </div>
          )}
        </div>
        <Switch
          className="mt-0.5 flex-shrink-0"
          checked={openToWorkspace}
          onCheckedChange={(next) => {
            if (!next && !window.confirm('Turning off Open to Workspace will immediately restrict bot access to only imported users with a Trigger grant. Anyone else will be blocked. Continue?')) return;
            save(next);
          }}
        />
      </div>
    </Section>
  );
}

// =============================================================================
// Users tab
// =============================================================================

function UsersTab() {
  const { role: currentRole } = useAuth();
  const isSuperadmin = currentRole === 'superadmin';
  const [users, setUsers] = useState<User[]>([]);
  const [agents, setAgents] = useState<AgentBasic[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'viewer' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [updatingRole, setUpdatingRole] = useState<string | null>(null);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  // Map of userId → map of agentId → 'none' | 'trigger' | 'view' | 'edit'
  const [accessGrants, setAccessGrants] = useState<Record<string, Record<string, 'none' | 'trigger' | 'view' | 'edit'>>>({});
  // Map of userId → set of agentIds where user is the creator (owner)
  const [ownerAgents, setOwnerAgents] = useState<Record<string, Set<string>>>({});
  const [loadingGrants, setLoadingGrants] = useState<string | null>(null);
  // Password reset modal state
  const [resetUser, setResetUser] = useState<User | null>(null);
  const [resetPwd, setResetPwd] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);

  const [openToWorkspace, setOpenToWorkspaceLocal] = useState(true);

  // Slack import
  const [importToken, setImportToken] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [slackMembers, setSlackMembers] = useState<Array<{ id: string; name: string; email: string; onboarded: boolean }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importError, setImportError] = useState('');
  const [onboarding, setOnboarding] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [askToken, setAskToken] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/auth/users').then(r => r.json()),
      fetch('/api/agents').then(r => r.json()),
    ]).then(([u, a]) => { setUsers(u); setAgents(a); }).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then((s: Record<string, string>) => {
      if (s.slack_import_bot_token) setImportToken(s.slack_import_bot_token);
      setOpenToWorkspaceLocal(s.openToWorkspace !== 'false');
    }).catch(() => {});
  }, []);

  const doFetchMembers = async () => {
    setImportError('');
    setAskToken(false);
    setImportLoading(true);
    setImportModal(true);
    try {
      const r = await fetch('/api/admin/slack-workspace-users');
      const data = await r.json();
      if (!r.ok) { setImportError(data.error || 'Failed to fetch Slack users'); setSlackMembers([]); return; }
      const members = data.members ?? [];
      setSlackMembers(members);
      setSelected(new Set(members.filter((m: { onboarded: boolean; id: string }) => !m.onboarded).map((m: { id: string }) => m.id)));
    } catch { setImportError('Network error'); } finally { setImportLoading(false); }
  };

  const openImport = async () => {
    if (importToken) {
      await doFetchMembers();
    } else {
      setTokenInput('');
      setImportError('');
      setAskToken(true);
      setImportModal(true);
    }
  };

  const submitToken = async () => {
    if (!tokenInput.trim()) return;
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'slack_import_bot_token', value: tokenInput.trim() }) });
    setImportToken(tokenInput.trim());
    await doFetchMembers();
  };

  const onboardSelected = async () => {
    const toOnboard = slackMembers.filter(m => selected.has(m.id));
    if (!toOnboard.length) return;
    setOnboarding(true);
    try {
      await fetch('/api/admin/slack-workspace-users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ users: toOnboard }) });
      setSlackMembers(prev => prev.map(m => selected.has(m.id) ? { ...m, onboarded: true } : m));
      setSelected(new Set());
      load();
    } finally { setOnboarding(false); }
  };

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const [importSearch, setImportSearch] = useState('');
  const filteredMembers = slackMembers.filter(m =>
    !importSearch || m.name.toLowerCase().includes(importSearch.toLowerCase()) || m.email.toLowerCase().includes(importSearch.toLowerCase())
  );
  const notOnboarded = slackMembers.filter(m => !m.onboarded);
  const allSelected = notOnboarded.length > 0 && notOnboarded.every(m => selected.has(m.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(notOnboarded.map(m => m.id)));

  const create = async () => {
    if (!newUser.username || !newUser.password) { setError('Username and password required'); return; }
    setSaving(true); setError('');
    try {
      const r = await fetch('/api/auth/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || 'Failed'); return; }
      setShowForm(false);
      setNewUser({ username: '', password: '', role: 'viewer' });
      load();
    } finally { setSaving(false); }
  };

  const remove = async (id: string, username: string) => {
    if (!confirm(`Delete user "${username}"?`)) return;
    await fetch(`/api/auth/users/${id}`, { method: 'DELETE' });
    load();
  };

  const changeRole = async (id: string, role: string) => {
    setUpdatingRole(id);
    await fetch(`/api/auth/users/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    setUpdatingRole(null);
    load();
  };

  const openReset = (u: User) => {
    setResetUser(u);
    setResetPwd('');
    setResetError('');
    setResetSuccess(false);
  };

  const closeReset = () => {
    if (resetting) return;
    setResetUser(null);
    setResetPwd('');
    setResetError('');
    setResetSuccess(false);
  };

  const submitReset = async () => {
    if (!resetUser) return;
    if (resetPwd.length < 8) { setResetError('Password must be at least 8 characters'); return; }
    setResetting(true); setResetError('');
    try {
      const r = await fetch(`/api/auth/users/${resetUser.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: resetPwd }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setResetError(data.error || 'Failed to reset password');
        return;
      }
      setResetSuccess(true);
      setTimeout(() => { setResetUser(null); setResetPwd(''); setResetSuccess(false); }, 1200);
    } finally { setResetting(false); }
  };

  const toggleExpand = async (userId: string) => {
    if (expandedUser === userId) { setExpandedUser(null); return; }
    setExpandedUser(userId);
    if (accessGrants[userId]) return; // already loaded
    setLoadingGrants(userId);
    // Load all access grants for this user across all agents
    const grants: Record<string, 'none' | 'trigger' | 'view' | 'edit'> = {};
    const owners = new Set<string>();
    await Promise.all(agents.map(async (a) => {
      const r = await fetch(`/api/agents/${a.id}/access`);
      const data = await r.json();
      const match = data.writeUsers?.find((w: { userId: string; accessLevel?: string; canWrite?: boolean; isOwner: boolean }) => w.userId === userId);
      if (match) {
        const lvl = (match.accessLevel as 'trigger' | 'view' | 'edit' | undefined) ?? (match.canWrite ? 'edit' : 'view');
        grants[a.id] = lvl;
        if (match.isOwner) owners.add(a.id);
      }
    }));
    setAccessGrants(prev => ({ ...prev, [userId]: grants }));
    setOwnerAgents(prev => ({ ...prev, [userId]: owners }));
    setLoadingGrants(null);
  };

  const setAccess = async (userId: string, agentId: string, level: 'none' | 'trigger' | 'view' | 'edit') => {
    if (level === 'none') {
      await fetch(`/api/agents/${agentId}/access`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
    } else {
      await fetch(`/api/agents/${agentId}/access`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, accessLevel: level }),
      });
    }
    setAccessGrants(prev => ({
      ...prev,
      [userId]: { ...prev[userId], [agentId]: level },
    }));
  };

  const accessUser = expandedUser ? users.find(u => u.id === expandedUser) : null;

  const [userSearch, setUserSearch] = React.useState('');
  const filteredUsers = users.filter(u =>
    u.username.toLowerCase().includes(userSearch.toLowerCase())
  );

  return (
    <>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="mb-0.5 text-base font-semibold text-foreground">Team members</div>
          <div className="text-sm text-muted-foreground">{users.length + 1} member{users.length !== 0 ? 's' : ''}</div>
        </div>
        <div className="flex gap-2">
          <button onClick={openImport} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground shadow-sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Import from Slack
          </button>
          <button onClick={() => setShowForm(true)} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
            Add member
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-3.5">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
          <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <input
          value={userSearch}
          onChange={e => setUserSearch(e.target.value)}
          placeholder="Search members..."
          className="w-full rounded-lg border border-border bg-card py-2 pl-[30px] pr-3 text-sm text-foreground outline-none"
        />
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex flex-col gap-px">
          {[1,2,3].map(i => (
            <div key={i} className="h-[52px] rounded-lg bg-secondary opacity-50" />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-secondary">
                <th className="border-b border-border px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">Member</th>
                <th className="border-b border-border px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">Source</th>
                <th className="border-b border-border px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">Role</th>
                <th className="border-b border-border px-4 py-2.5 text-center text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">Agents</th>
                <th className="border-b border-border px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Superadmin row */}
              <tr className="border-b border-border bg-card">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">A</div>
                    <span className="text-sm font-semibold text-foreground">admin</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs text-muted-foreground">Environment variable</span>
                </td>
                <td className="px-4 py-3">
                  <span className="rounded bg-amber/10 px-2 py-0.5 text-2xs font-bold uppercase tracking-[0.05em] text-amber">Owner</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <span className="text-xs text-muted-foreground">—</span>
                </td>
                <td className="px-4 py-3" />
              </tr>

              {filteredUsers.map((u, idx) => {
                const initials = u.username.slice(0, 2).toUpperCase();
                const avatarBg = u.role === 'admin' ? '#18181b' : u.role === 'editor' ? '#0f766e' : '#6366f1';
                const roleColor = u.role === 'admin' ? { color: '#2563eb', bg: 'rgba(37,99,235,0.08)' } : u.role === 'editor' ? { color: '#0f766e', bg: 'rgba(15,118,110,0.08)' } : { color: 'var(--muted)', bg: 'var(--surface-2)' };
                const isLast = idx === filteredUsers.length - 1;
                return (
                  <tr key={u.id} className={cn('bg-card', !isLast && 'border-b border-border')}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div
                          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
                          style={{ background: avatarBg }}
                        >{initials}</div>
                        <div>
                          <div className="text-sm font-semibold text-foreground">{u.username}</div>
                          <div className="mt-px text-2xs text-muted-foreground">{new Date(u.createdAt).toLocaleDateString()}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {u.fromSlack ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                          <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/d/d5/Slack_icon_2019.svg/3840px-Slack_icon_2019.svg.png" width="13" height="13" alt="Slack" />
                          Slack
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Manual</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        disabled={updatingRole === u.id}
                        onChange={e => changeRole(u.id, e.target.value)}
                        className={cn('cursor-pointer rounded-md border border-border px-2 py-1 text-xs font-semibold outline-none', updatingRole === u.id && 'opacity-50')}
                        style={{ background: roleColor.bg, color: roleColor.color }}
                      >
                        <option value="admin">Admin</option>
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {(u.agentCount ?? 0) > 0 ? (
                        <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-blue/10 px-1.5 text-2xs font-bold text-blue">{u.agentCount}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        {(u.role === 'editor' || u.role === 'viewer') && (
                          <button
                            onClick={() => toggleExpand(u.id)}
                            title="Agent Access"
                            className={cn(
                              'inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-xs font-medium',
                              expandedUser === u.id ? 'bg-blue/10 text-blue' : 'bg-secondary text-muted-foreground',
                            )}
                          >
                            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/></svg>
                            Agent Access
                          </button>
                        )}
                        {isSuperadmin && !u.fromSlack && (
                          <button onClick={() => openReset(u)} title="Reset password" className="inline-flex h-[30px] w-[30px] flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground"><KeyRound size={13} /></button>
                        )}
                        <button onClick={() => remove(u.id, u.username)} title="Remove member" className="inline-flex h-[30px] w-[30px] flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-secondary text-red opacity-70">
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-10 text-center text-sm text-muted-foreground">
                    {userSearch ? 'No members match your search.' : 'No members yet. Add one or import from Slack.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Agent access side panel */}
      {accessUser && (
        <Portal>
          <div onClick={() => setExpandedUser(null)} className="fixed inset-0 z-[9990] bg-black/25 backdrop-blur-[1px]" />
          <div className="fixed bottom-0 right-0 top-0 z-[9991] flex w-[400px] flex-col border-l border-border bg-card shadow-lg">
            {/* Panel header */}
            <div className="flex-shrink-0 border-b border-border px-6 pb-4 pt-6">
              <div className="mb-1 flex items-center gap-3">
                <div
                  className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-base font-bold text-white"
                  style={{ background: accessUser.role === 'admin' ? '#18181b' : accessUser.role === 'editor' ? '#0f766e' : '#6366f1' }}
                >{accessUser.username.slice(0, 2).toUpperCase()}</div>
                <div className="min-w-0 flex-1">
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-md font-bold text-foreground">{accessUser.username}</div>
                  <div className="mt-px text-xs capitalize text-muted-foreground">{accessUser.role}</div>
                </div>
                <button onClick={() => setExpandedUser(null)} className="cursor-pointer p-1 text-xl leading-none text-muted-foreground">&times;</button>
              </div>
              {/* Open-to-workspace hint */}
              {openToWorkspace && (
                <div className="mt-2.5 rounded border-l-[3px] border-blue bg-blue/10 px-2.5 py-1.5 text-2xs leading-normal text-muted-foreground">
                  <strong className="text-blue">Open to Workspace is on</strong> — any Slack workspace member can already trigger agents. Grants here control <strong>SlackHive dashboard access</strong> only (View / Edit). Existing grants are preserved and will apply automatically when you turn restriction on.
                </div>
              )}
              {/* Legend */}
              <div className="mt-3 flex flex-wrap gap-3">
                {[
                  { label: 'None', color: 'var(--muted)', desc: 'No access' },
                  { label: 'Trigger', color: '#d97706', desc: 'Slack only' },
                  { label: 'View', color: '#0f766e', desc: '+ SlackHive' },
                  { label: 'Edit', color: '#3b82f6', desc: 'Full access' },
                ].map(({ label, color, desc }) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <div className="h-2 w-2 rounded-full" style={{ background: color }} />
                    <span className="text-2xs font-semibold" style={{ color }}>{label}</span>
                    <span className="text-2xs text-muted-foreground">{desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Agent list */}
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-6 py-4">
              {loadingGrants === accessUser.id ? (
                <div className="mt-10 text-center text-sm text-muted-foreground">Loading…</div>
              ) : agents.length === 0 ? (
                <div className="mt-10 text-center text-sm text-muted-foreground">No agents yet.</div>
              ) : agents.map(a => {
                const isOwner = ownerAgents[accessUser.id]?.has(a.id) ?? false;
                const level = accessGrants[accessUser.id]?.[a.id] ?? 'none';
                const levels: ('none' | 'trigger' | 'view' | 'edit')[] = accessUser.role === 'viewer' ? ['none', 'trigger', 'view'] : ['none', 'trigger', 'view', 'edit'];
                const dotColor = level === 'edit' ? '#3b82f6' : level === 'view' ? '#0f766e' : level === 'trigger' ? '#d97706' : 'var(--border)';

                return (
                  <div key={a.id} className="rounded-xl border border-border bg-secondary px-4 py-3.5">
                    <div className={cn('flex items-center gap-2.5', isOwner ? 'mb-0' : 'mb-3')}>
                      <div className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: dotColor }} />
                      <div className="min-w-0 flex-1">
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-foreground">{a.name}</div>
                        <div className="mt-px text-2xs font-medium" style={{ color: dotColor }}>
                          {isOwner ? 'Owner' : level === 'none' ? 'No access' : level === 'trigger' ? 'Trigger only' : level === 'view' ? 'View + Slack' : 'Full edit'}
                        </div>
                      </div>
                      {isOwner && (
                        <span className="rounded bg-amber/10 px-2 py-0.5 text-[10px] font-bold text-amber">Owner</span>
                      )}
                    </div>
                    {!isOwner && (
                      <div className="flex gap-1.5">
                        {levels.map(lvl => {
                          const active = level === lvl;
                          const c = lvl === 'edit' ? '#3b82f6' : lvl === 'view' ? '#0f766e' : lvl === 'trigger' ? '#d97706' : 'var(--muted)';
                          return (
                            <button
                              key={lvl}
                              onClick={() => setAccess(accessUser.id, a.id, lvl)}
                              className={cn('flex-1 cursor-pointer rounded-lg border px-1 py-1.5 text-2xs font-semibold transition-all', !active && 'border-border bg-card text-muted-foreground')}
                              style={active ? { borderColor: c, background: `${c}18`, color: c } : undefined}
                            >
                              {lvl === 'none' ? 'None' : lvl === 'trigger' ? 'Trigger' : lvl === 'view' ? 'View' : 'Edit'}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </Portal>
      )}

      {/* Create modal */}
      {showForm && (
        <Portal>
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
          <div className="flex max-h-[90vh] w-[380px] flex-col gap-4 overflow-auto rounded-xl border border-border bg-card p-7 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="m-0 text-md font-semibold text-foreground">New User</h3>
              <button onClick={() => { setShowForm(false); setError(''); }}
                className="cursor-pointer text-lg text-muted-foreground">&times;</button>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Username</label>
              <input type="text" value={newUser.username} onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))}
                className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Password</label>
              <input type="password" value={newUser.password} onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))}
                className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Role</label>
              <select value={newUser.role} onChange={e => setNewUser(u => ({ ...u, role: e.target.value }))}
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none">
                <option value="viewer">Viewer — read-only access</option>
                <option value="editor">Editor — create/edit agents, jobs, settings</option>
                <option value="admin">Admin — full access including user management</option>
              </select>
            </div>
            {error && <div className="rounded bg-red/10 px-2.5 py-1.5 text-xs text-red">{error}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowForm(false); setError(''); }}
                className="cursor-pointer rounded-md border border-border bg-card px-4 py-2 text-sm">Cancel</button>
              <button onClick={create} disabled={saving}
                className="cursor-pointer rounded-md bg-primary px-[18px] py-2 text-sm font-medium text-primary-foreground">
                {saving ? 'Creating...' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Import from Slack modal */}
      {importModal && (
        <Portal>
        <div onClick={() => { if (!onboarding) setImportModal(false); }} className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
          <div onClick={e => e.stopPropagation()} className="flex max-h-[80vh] w-[460px] flex-col gap-4 rounded-xl border border-border bg-card p-7 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="m-0 text-md font-semibold text-foreground">Import from Slack</h3>
              <button onClick={() => setImportModal(false)} disabled={onboarding}
                className="cursor-pointer text-lg text-muted-foreground">&times;</button>
            </div>

            {askToken && (
              <>
                <p className="m-0 text-sm text-muted-foreground">
                  Enter a Slack bot token with <code>users:read</code> and <code>users:read.email</code> scopes.<br />
                  Find it in your Slack app → <strong>OAuth &amp; Permissions → Bot User OAuth Token</strong>.
                </p>
                <input
                  autoFocus
                  type="password"
                  value={tokenInput}
                  onChange={e => setTokenInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitToken(); }}
                  placeholder="xoxb-..."
                  className="w-full rounded-md border border-border bg-card px-3 py-2.5 font-mono text-sm outline-none"
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setImportModal(false)}
                    className="cursor-pointer rounded-md border border-border bg-card px-4 py-2 text-sm">Cancel</button>
                  <button onClick={submitToken} disabled={!tokenInput.trim()} className={cn('cursor-pointer rounded-md bg-primary px-[18px] py-2 text-sm font-medium text-primary-foreground', !tokenInput.trim() && 'opacity-50')}>Continue</button>
                </div>
              </>
            )}

            {importLoading && <p className="m-0 text-sm text-muted-foreground">Fetching workspace members…</p>}
            {importError && <div className="rounded bg-red/10 px-3 py-2 text-xs text-red">{importError}</div>}

            {!askToken && !importLoading && !importError && (
              <>
                {slackMembers.length > 0 && (
                  <input
                    type="text"
                    placeholder="Search by name or email…"
                    value={importSearch}
                    onChange={e => setImportSearch(e.target.value)}
                    className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none"
                  />
                )}
                {slackMembers.length > 0 && (
                  <div className="flex items-center gap-2.5 px-0.5 py-1.5">
                    <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} className="cursor-pointer" />
                      Select all not onboarded ({notOnboarded.length})
                    </label>
                    <span className="ml-auto text-xs text-muted-foreground">{slackMembers.length} total · {slackMembers.filter(m => m.onboarded).length} onboarded</span>
                  </div>
                )}
                {slackMembers.length === 0 && <p className="m-0 text-sm text-muted-foreground">No members found in workspace.</p>}
                {filteredMembers.length > 0 && (
                  <div className="max-h-[340px] overflow-y-auto rounded-lg border border-border">
                    {filteredMembers.map((m, i) => (
                      <div
                        key={m.id}
                        className={cn(
                          'flex items-center gap-2.5 px-3.5 py-2.5',
                          i < filteredMembers.length - 1 && 'border-b border-border',
                          m.onboarded ? 'bg-secondary opacity-60' : 'bg-card',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(m.id)}
                          disabled={m.onboarded}
                          onChange={() => toggleSelect(m.id)}
                          className={cn('flex-shrink-0', m.onboarded ? 'cursor-default' : 'cursor-pointer')}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-foreground">{m.name}</div>
                          {m.email && <div className="text-2xs text-muted-foreground">{m.email}</div>}
                        </div>
                        {m.onboarded
                          ? <span className="flex-shrink-0 rounded bg-green/10 px-2 py-0.5 text-[10px] font-semibold text-green">Onboarded</span>
                          : null}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-end gap-2">
                  <button onClick={() => { setTokenInput(''); setAskToken(true); setSlackMembers([]); setImportError(''); }} className="mr-auto cursor-pointer text-xs text-muted-foreground underline">Change token</button>
                  <button onClick={() => setImportModal(false)} disabled={onboarding}
                    className="cursor-pointer rounded-md border border-border bg-card px-4 py-2 text-sm">Close</button>
                  {selected.size > 0 && (
                    <button onClick={onboardSelected} disabled={onboarding} className={cn('cursor-pointer rounded-md bg-primary px-[18px] py-2 text-sm font-medium text-primary-foreground', onboarding && 'opacity-60')}>
                      {onboarding ? 'Onboarding…' : `Onboard Selected (${selected.size})`}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        </Portal>
      )}

      {/* Reset password modal (superadmin only) */}
      {resetUser && (
        <Portal>
        <div
          onClick={closeReset}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="flex w-[380px] flex-col gap-4 rounded-xl border border-border bg-card p-7 shadow-lg"
          >
            <div className="flex items-center justify-between">
              <h3 className="m-0 text-md font-semibold text-foreground">Reset password</h3>
              <button onClick={closeReset} disabled={resetting}
                className="cursor-pointer text-lg text-muted-foreground">&times;</button>
            </div>
            <p className="m-0 text-sm text-muted-foreground">
              Set a new password for <strong className="text-foreground">{resetUser.username}</strong>. They&apos;ll need the new password on their next login.
            </p>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">New password</label>
              <input
                type="password"
                autoFocus
                value={resetPwd}
                disabled={resetting || resetSuccess}
                onChange={e => setResetPwd(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitReset(); }}
                placeholder="Minimum 8 characters"
                className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none"
              />
            </div>
            {resetError && <div className="rounded bg-red/10 px-2.5 py-1.5 text-xs text-red">{resetError}</div>}
            {resetSuccess && <div className="rounded bg-green/10 px-2.5 py-1.5 text-xs text-green">Password updated</div>}
            <div className="flex justify-end gap-2">
              <button onClick={closeReset} disabled={resetting}
                className="cursor-pointer rounded-md border border-border bg-card px-4 py-2 text-sm">Cancel</button>
              <button onClick={submitReset} disabled={resetting || resetSuccess || !resetPwd}
                className={cn('cursor-pointer rounded-md bg-primary px-[18px] py-2 text-sm font-medium text-primary-foreground', (resetting || resetSuccess || !resetPwd) && 'opacity-60')}>
                {resetting ? 'Saving…' : 'Reset password'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}
    </>
  );
}

// =============================================================================
// Authentication tab (superadmin only)
// =============================================================================

const SLACK_CLIENT_ID_KEY = 'slack_client_id';
const SLACK_CLIENT_SECRET_KEY = 'slack_client_secret';

function AuthTab() {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  useEffect(() => { setRedirectUri(`${window.location.origin}/api/auth/slack/callback`); }, []);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((s: Record<string, string>) => {
        if (s[SLACK_CLIENT_ID_KEY]) setClientId(s[SLACK_CLIENT_ID_KEY]);
        if (s[SLACK_CLIENT_SECRET_KEY]) setClientSecret(s[SLACK_CLIENT_SECRET_KEY]);
        setLoginOpen(s.slack_login_open === 'true');
      })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    try {
      const saves = [
        fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: SLACK_CLIENT_ID_KEY, value: clientId }) }),
        fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: SLACK_CLIENT_SECRET_KEY, value: clientSecret }) }),
      ];
      if (clientId && clientSecret) {
        saves.push(fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'slack_login_open', value: loginOpen ? 'true' : 'false' }) }));
      }
      await Promise.all(saves);
      setToast('Saved');
      setTimeout(() => setToast(''), 2000);
    } finally { setSaving(false); }
  }

  const inputClass = 'w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none';
  const labelClass = 'mb-1.5 block text-xs font-medium text-muted-foreground';

  return (
    <div className="max-w-[560px]">
      <h2 className="m-0 mb-1 text-base font-semibold text-foreground">Sign in with Slack</h2>
      <p className="m-0 mb-6 text-sm text-muted-foreground">
        Allow users to log in using their Slack account. Get these from{' '}
        <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-primary">api.slack.com/apps</a>
        {' '}→ your app → Basic Information. Add user token scopes: <code>openid</code>, <code>profile</code>, <code>email</code>.
      </p>

      <div className="flex flex-col gap-4">
        <div>
          <label className={labelClass}>Redirect URI <span className="font-normal text-muted-foreground">(add this in Slack → OAuth & Permissions)</span></label>
          <input
            className={cn(inputClass, 'cursor-text text-muted-foreground')}
            value={redirectUri}
            readOnly
            onFocus={e => e.currentTarget.select()}
          />
        </div>
        <div>
          <label className={labelClass}>Client ID</label>
          <input
            className={inputClass}
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            placeholder="123456789012.123456789012"
          />
        </div>
        <div>
          <label className={labelClass}>Client Secret</label>
          <input
            className={inputClass}
            type="password"
            value={clientSecret}
            onChange={e => setClientSecret(e.target.value)}
            placeholder="••••••••••••••••••••••••••••••••"
          />
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary px-4 py-3">
          <input
            type="checkbox"
            id="slack-login-open"
            checked={loginOpen}
            onChange={e => setLoginOpen(e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          <label htmlFor="slack-login-open" className="flex-1 cursor-pointer text-sm text-foreground">
            <strong className="font-semibold">Allow any workspace member to sign in</strong>
            <div className="mt-0.5 text-xs text-muted-foreground">
              When off (default), only users imported via Settings → Users can log in with Slack.
            </div>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving || !clientId || !clientSecret}
            className={cn('rounded-lg bg-primary px-[18px] py-2 text-sm font-semibold text-primary-foreground', saving ? 'cursor-not-allowed' : 'cursor-pointer')}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {toast && <span className="text-sm text-green">{toast}</span>}
        </div>
        {clientId && (
          <p className="m-0 text-xs text-muted-foreground">
            ✓ Sign in with Slack is enabled. Users will see the button on the login page.
          </p>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Shared UI helpers
// =============================================================================

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-[22px] border-b border-border pb-[22px]">
      <div className="mb-3.5 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function Field({ label, value, onChange, onBlur, hint, maxLength }: {
  label: string; value: string; onChange: (v: string) => void; onBlur?: () => void; hint?: string; maxLength?: number;
}) {
  const overLimit = maxLength !== undefined && value.length > maxLength;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        {maxLength !== undefined && (
          <span className={cn('font-mono text-[10px]', overLimit ? 'text-red' : 'text-muted-foreground')}>
            {value.length}/{maxLength}
          </span>
        )}
      </div>
      <input type="text" value={value} maxLength={maxLength} onChange={e => onChange(e.target.value)}
        onBlur={() => onBlur?.()}
        className={cn(
          'w-full rounded-md border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors',
          overLimit ? 'border-red' : 'border-border focus:border-primary',
        )}
      />
      {hint && <p className="m-0 mt-1 text-2xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SelectField({ label, value, options, onChange, hint }: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; sub?: string }[];
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full cursor-pointer rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}{o.sub ? ` — ${o.sub}` : ''}
          </option>
        ))}
      </select>
      {hint && <p className="m-0 mt-1 text-2xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PrimaryBtn({ children, onClick, loading }: { children: React.ReactNode; onClick?: () => void; loading?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading} className={cn(
      'rounded-md px-[18px] py-2 text-sm font-medium text-primary-foreground transition-opacity',
      loading ? 'cursor-not-allowed bg-border' : 'cursor-pointer bg-primary hover:opacity-85',
    )}
    >{loading ? 'Saving...' : children}</button>
  );
}
