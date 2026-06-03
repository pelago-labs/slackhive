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
import { MODELS, DEFAULT_COACH_MODEL, COACH_MODEL_SETTING_KEY } from '@slackhive/shared';
import { Portal } from '@/lib/portal';
import { useAuth } from '@/lib/auth-context';
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
  tagline: 'AI agent teams on Slack',
  logoUrl: '',
  dashboardTitle: 'Welcome to SlackHive',
  [COACH_MODEL_SETTING_KEY]: DEFAULT_COACH_MODEL,
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
    <div className="fade-up" style={{ padding: '36px 40px' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', margin: 0 }}>
          Settings
        </h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          Configure platform branding, appearance, and access.
        </p>
      </div>

      {/* Side-nav + content */}
      <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <nav style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {nav.map(n => (
            <button key={n.id} onClick={() => setSection(n.id)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 9, textAlign: 'left',
              padding: '9px 12px', borderRadius: 9, border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-sans)', fontSize: 13,
              background: active === n.id ? 'var(--surface-2)' : 'transparent',
              color: active === n.id ? 'var(--text)' : 'var(--muted)',
              fontWeight: active === n.id ? 600 : 400,
            }}><n.Icon size={15} />{n.label}</button>
          ))}
        </nav>

        <div style={{ flex: 1, minWidth: 0, maxWidth: 760 }}>
          {active === 'general' && <GeneralTab />}
          {active === 'ai'      && canManageUsers && <AITab />}
          {active === 'access'  && canManageUsers && <AccessControlSection />}
          {active === 'signin'  && canManageUsers && isSuperadmin && <AuthTab />}
          {active === 'users'   && canManageUsers && <UsersTab />}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// General tab
// =============================================================================

function GeneralTab() {
  const [appName, setAppName] = useState(DEFAULTS.appName);
  const [tagline, setTagline] = useState(DEFAULTS.tagline);
  const [logoUrl, setLogoUrl] = useState(DEFAULTS.logoUrl);
  const [dashboardTitle, setDashboardTitle] = useState(DEFAULTS.dashboardTitle);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((s: Record<string, string>) => {
        if (s.appName) setAppName(s.appName);
        if (s.tagline) setTagline(s.tagline);
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
      setToast(`Saved`);
      setTimeout(() => setToast(''), 2000);
    } finally { setSaving(false); }
  }

  async function saveAll() {
    setSaving(true);
    try {
      await Promise.all([
        fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'appName', value: appName }) }),
        fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'tagline', value: tagline }) }),
        fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'logoUrl', value: logoUrl }) }),
        fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'dashboardTitle', value: dashboardTitle }) }),
      ]);
      setToast('All settings saved');
      setTimeout(() => setToast(''), 2000);
    } finally { setSaving(false); }
  }

  return (
    <>
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 999,
          background: 'var(--accent)', color: 'var(--accent-fg)',
          padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          boxShadow: 'var(--shadow-md)',
        }}>{toast}</div>
      )}

      <Section title="Branding">
        <Field label="App Name" hint="Displayed in the sidebar header and browser tab." maxLength={30}
          value={appName} onChange={setAppName} onBlur={() => save('appName', appName)} />
        <Field label="Tagline" hint="Short description shown below the app name." maxLength={60}
          value={tagline} onChange={setTagline} onBlur={() => save('tagline', tagline)} />
        <Field label="Logo URL" hint="URL to a square image (28×28). Leave empty for the default icon." maxLength={500}
          value={logoUrl} onChange={setLogoUrl} onBlur={() => save('logoUrl', logoUrl)} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>Preview:</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoUrl || '/logo.svg'} alt="Logo" style={{ width: 28, height: 28, borderRadius: 8, objectFit: 'cover' }} />
          {!logoUrl && <span style={{ fontSize: 11, color: 'var(--subtle)', fontStyle: 'italic' }}>Using default logo</span>}
        </div>
      </Section>

      <Section title="Dashboard">
        <Field label="Dashboard Title" hint="Main heading on the dashboard page." maxLength={80}
          value={dashboardTitle} onChange={setDashboardTitle} onBlur={() => save('dashboardTitle', dashboardTitle)} />
      </Section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
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
  // Coach runs on the active backend, so its model options follow that backend.
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string; sub?: string }[]>([...MODELS]);

  const load = () => {
    fetch('/api/settings').then(r => r.json()).then((s: Record<string, string>) => {
      if (s[COACH_MODEL_SETTING_KEY]) setCoachModel(s[COACH_MODEL_SETTING_KEY]);
    }).catch(() => {});
    fetch('/api/system/models').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.models?.length) setModelOptions(d.models);
    }).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const saveCoach = (v: string) => {
    setCoachModel(v);
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: COACH_MODEL_SETTING_KEY, value: v }) }).catch(() => {});
  };

  // If the saved coach model isn't valid for the active backend, default to its first model.
  useEffect(() => {
    if (!modelOptions.length) return;
    setCoachModel(cm => modelOptions.some(m => m.value === cm) ? cm : modelOptions[0].value);
  }, [modelOptions]);

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
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>Open to Workspace</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            {openToWorkspace
              ? <>Any Slack workspace member can message the bot — no account setup needed. Turn off to restrict access to specific imported users with a Trigger grant.</>
              : <>Only imported users with <strong>Trigger</strong> access can use the bot. Others get a message asking them to contact an admin. Import teammates and assign access below.</>
            }
          </div>
          {!openToWorkspace && (
            <div style={{ fontSize: 12, marginTop: 8, padding: '7px 10px', background: 'rgba(234,179,8,0.08)', borderRadius: 6, borderLeft: '3px solid #ca8a04', color: 'var(--muted)', lineHeight: 1.5 }}>
              <strong style={{ color: '#ca8a04' }}>Restricted mode active.</strong> Turn on to allow all workspace members to trigger agents again.
            </div>
          )}
        </div>
        <button
          onClick={() => {
            const next = !openToWorkspace;
            if (!next && !window.confirm('Turning off Open to Workspace will immediately restrict bot access to only imported users with a Trigger grant. Anyone else will be blocked. Continue?')) return;
            save(next);
          }}
          style={{
            width: 44, height: 24, borderRadius: 12, border: 'none', flexShrink: 0, marginTop: 2,
            background: openToWorkspace ? '#3b82f6' : 'var(--border-2)',
            cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
          }}
        >
          <div style={{
            position: 'absolute', top: 3, left: openToWorkspace ? 23 : 3,
            width: 18, height: 18, borderRadius: '50%', background: 'var(--surface)',
            transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }} />
        </button>
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>Team members</div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>{users.length + 1} member{users.length !== 0 ? 's' : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={openImport} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--surface)', color: 'var(--text)',
            padding: '9px 16px', borderRadius: 10,
            fontSize: 13, fontWeight: 500, border: '1px solid var(--border)', cursor: 'pointer',
            fontFamily: 'var(--font-sans)', boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Import from Slack
          </button>
          <button onClick={() => setShowForm(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--accent)', color: 'var(--accent-fg)',
            padding: '9px 16px', borderRadius: 10,
            fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
            fontFamily: 'var(--font-sans)', boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
          }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
            Add member
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 14, position: 'relative' }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }}>
          <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <input
          value={userSearch}
          onChange={e => setUserSearch(e.target.value)}
          placeholder="Search members..."
          style={{
            width: '100%', padding: '8px 12px 8px 30px', fontSize: 13,
            border: '1px solid var(--border)', borderRadius: 10,
            background: 'var(--surface)', color: 'var(--text)',
            fontFamily: 'var(--font-sans)', outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {[1,2,3].map(i => (
            <div key={i} style={{ height: 52, borderRadius: 8, background: 'var(--surface-2)', opacity: 0.5 }} />
          ))}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)' }}>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>Member</th>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>Source</th>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>Role</th>
                <th style={{ padding: '10px 16px', textAlign: 'center', fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>Agents</th>
                <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Superadmin row */}
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 8, background: 'var(--accent)', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, fontWeight: 700, color: 'var(--accent-fg)',
                    }}>A</div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>admin</span>
                  </div>
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>Environment variable</span>
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#d97706', background: 'rgba(217,119,6,0.1)', padding: '3px 8px', borderRadius: 6 }}>Owner</span>
                </td>
                <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span>
                </td>
                <td style={{ padding: '12px 16px' }} />
              </tr>

              {filteredUsers.map((u, idx) => {
                const initials = u.username.slice(0, 2).toUpperCase();
                const avatarBg = u.role === 'admin' ? '#18181b' : u.role === 'editor' ? '#0f766e' : '#6366f1';
                const roleColor = u.role === 'admin' ? { color: '#2563eb', bg: 'rgba(37,99,235,0.08)' } : u.role === 'editor' ? { color: '#0f766e', bg: 'rgba(15,118,110,0.08)' } : { color: 'var(--muted)', bg: 'var(--surface-2)' };
                const isLast = idx === filteredUsers.length - 1;
                return (
                  <tr key={u.id} style={{ borderBottom: isLast ? 'none' : '1px solid var(--border)', background: 'var(--surface)' }}>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{
                          width: 32, height: 32, borderRadius: 8, background: avatarBg, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 12, fontWeight: 700, color: '#fff',
                        }}>{initials}</div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{u.username}</div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{new Date(u.createdAt).toLocaleDateString()}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      {u.fromSlack ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text)', fontWeight: 500 }}>
                          <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/d/d5/Slack_icon_2019.svg/3840px-Slack_icon_2019.svg.png" width="13" height="13" alt="Slack" />
                          Slack
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Manual</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <select
                        value={u.role}
                        disabled={updatingRole === u.id}
                        onChange={e => changeRole(u.id, e.target.value)}
                        style={{
                          fontSize: 12, fontWeight: 600, padding: '5px 8px', borderRadius: 7,
                          border: '1px solid var(--border)', cursor: 'pointer',
                          background: roleColor.bg, color: roleColor.color,
                          fontFamily: 'var(--font-sans)', outline: 'none',
                          opacity: updatingRole === u.id ? 0.5 : 1,
                        }}
                      >
                        <option value="admin">Admin</option>
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                      {(u.agentCount ?? 0) > 0 ? (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          minWidth: 22, height: 22, borderRadius: 11,
                          background: 'rgba(59,130,246,0.1)', color: '#3b82f6',
                          fontSize: 11, fontWeight: 700, padding: '0 6px',
                        }}>{u.agentCount}</span>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                        {(u.role === 'editor' || u.role === 'viewer') && (
                          <button onClick={() => toggleExpand(u.id)} title="Agent Access" style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                            fontSize: 12, fontWeight: 500, padding: '6px 10px', borderRadius: 7,
                            border: '1px solid var(--border)', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                            background: expandedUser === u.id ? 'rgba(59,130,246,0.08)' : 'var(--surface-2)',
                            color: expandedUser === u.id ? '#3b82f6' : 'var(--muted)',
                            whiteSpace: 'nowrap',
                          }}>
                            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/></svg>
                            Agent Access
                          </button>
                        )}
                        {isSuperadmin && !u.fromSlack && (
                          <button onClick={() => openReset(u)} title="Reset password" style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 30, height: 30, borderRadius: 7, flexShrink: 0,
                            background: 'var(--surface-2)', border: '1px solid var(--border)',
                            color: 'var(--muted)', cursor: 'pointer',
                          }}><KeyRound size={13} /></button>
                        )}
                        <button onClick={() => remove(u.id, u.username)} title="Remove member" style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 30, height: 30, borderRadius: 7, flexShrink: 0,
                          background: 'var(--surface-2)', border: '1px solid var(--border)',
                          color: '#dc2626', cursor: 'pointer', opacity: 0.7,
                        }}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
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
          <div onClick={() => setExpandedUser(null)} style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 9990,
            backdropFilter: 'blur(1px)',
          }} />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 400,
            background: 'var(--surface)', borderLeft: '1px solid var(--border)',
            zIndex: 9991, display: 'flex', flexDirection: 'column',
            boxShadow: '-8px 0 32px rgba(0,0,0,0.12)',
          }}>
            {/* Panel header */}
            <div style={{ padding: '24px 24px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  background: accessUser.role === 'admin' ? '#18181b' : accessUser.role === 'editor' ? '#0f766e' : '#6366f1',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 15, fontWeight: 700, color: '#fff', flexShrink: 0,
                }}>{accessUser.username.slice(0, 2).toUpperCase()}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{accessUser.username}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1, textTransform: 'capitalize' }}>{accessUser.role}</div>
                </div>
                <button onClick={() => setExpandedUser(null)} style={{
                  background: 'none', border: 'none', color: 'var(--muted)',
                  fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: 4,
                }}>&times;</button>
              </div>
              {/* Open-to-workspace hint */}
              {openToWorkspace && (
                <div style={{ marginTop: 10, padding: '7px 10px', background: 'rgba(59,130,246,0.08)', borderRadius: 6, borderLeft: '3px solid #3b82f6', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                  <strong style={{ color: '#3b82f6' }}>Open to Workspace is on</strong> — any Slack workspace member can already trigger agents. Grants here control <strong>SlackHive dashboard access</strong> only (View / Edit). Existing grants are preserved and will apply automatically when you turn restriction on.
                </div>
              )}
              {/* Legend */}
              <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                {[
                  { label: 'None', color: 'var(--muted)', desc: 'No access' },
                  { label: 'Trigger', color: '#d97706', desc: 'Slack only' },
                  { label: 'View', color: '#0f766e', desc: '+ SlackHive' },
                  { label: 'Edit', color: '#3b82f6', desc: 'Full access' },
                ].map(({ label, color, desc }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color }}>{label}</span>
                    <span style={{ fontSize: 11, color: 'var(--subtle)' }}>{desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Agent list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {loadingGrants === accessUser.id ? (
                <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginTop: 40 }}>Loading…</div>
              ) : agents.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginTop: 40 }}>No agents yet.</div>
              ) : agents.map(a => {
                const isOwner = ownerAgents[accessUser.id]?.has(a.id) ?? false;
                const level = accessGrants[accessUser.id]?.[a.id] ?? 'none';
                const levels: ('none' | 'trigger' | 'view' | 'edit')[] = accessUser.role === 'viewer' ? ['none', 'trigger', 'view'] : ['none', 'trigger', 'view', 'edit'];
                const dotColor = level === 'edit' ? '#3b82f6' : level === 'view' ? '#0f766e' : level === 'trigger' ? '#d97706' : 'var(--border)';

                return (
                  <div key={a.id} style={{
                    borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-2)',
                    padding: '14px 16px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: isOwner ? 0 : 12 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                        <div style={{ fontSize: 11, color: dotColor, fontWeight: 500, marginTop: 1 }}>
                          {isOwner ? 'Owner' : level === 'none' ? 'No access' : level === 'trigger' ? 'Trigger only' : level === 'view' ? 'View + Slack' : 'Full edit'}
                        </div>
                      </div>
                      {isOwner && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                          color: '#d97706', background: 'rgba(217,119,6,0.1)',
                        }}>Owner</span>
                      )}
                    </div>
                    {!isOwner && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        {levels.map(lvl => {
                          const active = level === lvl;
                          const c = lvl === 'edit' ? '#3b82f6' : lvl === 'view' ? '#0f766e' : lvl === 'trigger' ? '#d97706' : 'var(--muted)';
                          return (
                            <button key={lvl} onClick={() => setAccess(accessUser.id, a.id, lvl)} style={{
                              flex: 1, padding: '7px 4px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                              border: `1px solid ${active ? c : 'var(--border)'}`,
                              background: active ? `${c}18` : 'var(--surface)',
                              color: active ? c : 'var(--subtle)',
                              cursor: 'pointer', fontFamily: 'var(--font-sans)',
                              transition: 'all 0.12s',
                            }}>
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
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
          backdropFilter: 'blur(2px)',
        }}>
          <div style={{
            background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)',
            padding: 28, width: 380, boxShadow: 'var(--shadow-lg)',
            display: 'flex', flexDirection: 'column', gap: 16,
            maxHeight: '90vh', overflow: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>New User</h3>
              <button onClick={() => { setShowForm(false); setError(''); }}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>&times;</button>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>Username</label>
              <input type="text" value={newUser.username} onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'var(--font-sans)' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>Password</label>
              <input type="password" value={newUser.password} onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'var(--font-sans)' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>Role</label>
              <select value={newUser.role} onChange={e => setNewUser(u => ({ ...u, role: e.target.value }))}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', fontSize: 13, outline: 'none', fontFamily: 'var(--font-sans)', background: 'var(--surface)' }}>
                <option value="viewer">Viewer — read-only access</option>
                <option value="editor">Editor — create/edit agents, jobs, settings</option>
                <option value="admin">Admin — full access including user management</option>
              </select>
            </div>
            {error && <div style={{ fontSize: 12, color: '#dc2626', background: 'rgba(220,38,38,0.06)', padding: '6px 10px', borderRadius: 6 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowForm(false); setError(''); }}
                style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>Cancel</button>
              <button onClick={create} disabled={saving}
                style={{ padding: '8px 18px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: 'var(--accent-fg)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
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
        <div onClick={() => { if (!onboarding) setImportModal(false); }} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
          backdropFilter: 'blur(2px)',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)',
            padding: 28, width: 460, boxShadow: 'var(--shadow-lg)',
            display: 'flex', flexDirection: 'column', gap: 16,
            maxHeight: '80vh',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>Import from Slack</h3>
              <button onClick={() => setImportModal(false)} disabled={onboarding}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>&times;</button>
            </div>

            {askToken && (
              <>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
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
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 7, border: '1px solid var(--border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'var(--font-mono, monospace)', background: 'var(--surface)' }}
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => setImportModal(false)}
                    style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>Cancel</button>
                  <button onClick={submitToken} disabled={!tokenInput.trim()} style={{
                    padding: '8px 18px', borderRadius: 7, border: 'none',
                    background: 'var(--accent)', color: 'var(--accent-fg)',
                    fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
                    opacity: tokenInput.trim() ? 1 : 0.5,
                  }}>Continue</button>
                </div>
              </>
            )}

            {importLoading && <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Fetching workspace members…</p>}
            {importError && <div style={{ fontSize: 12, color: '#dc2626', background: 'rgba(220,38,38,0.06)', padding: '8px 12px', borderRadius: 6 }}>{importError}</div>}

            {!askToken && !importLoading && !importError && (
              <>
                {slackMembers.length > 0 && (
                  <input
                    type="text"
                    placeholder="Search by name or email…"
                    value={importSearch}
                    onChange={e => setImportSearch(e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'var(--font-sans)', background: 'var(--surface)' }}
                  />
                )}
                {slackMembers.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 2px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12, color: 'var(--muted)', userSelect: 'none' }}>
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ cursor: 'pointer' }} />
                      Select all not onboarded ({notOnboarded.length})
                    </label>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--subtle)' }}>{slackMembers.length} total · {slackMembers.filter(m => m.onboarded).length} onboarded</span>
                  </div>
                )}
                {slackMembers.length === 0 && <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>No members found in workspace.</p>}
                {filteredMembers.length > 0 && (
                  <div style={{ overflowY: 'auto', maxHeight: 340, border: '1px solid var(--border)', borderRadius: 8 }}>
                    {filteredMembers.map((m, i) => (
                      <div key={m.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
                        borderBottom: i < filteredMembers.length - 1 ? '1px solid var(--border)' : 'none',
                        background: m.onboarded ? 'var(--surface-2)' : 'var(--surface)',
                        opacity: m.onboarded ? 0.6 : 1,
                      }}>
                        <input
                          type="checkbox"
                          checked={selected.has(m.id)}
                          disabled={m.onboarded}
                          onChange={() => toggleSelect(m.id)}
                          style={{ cursor: m.onboarded ? 'default' : 'pointer', flexShrink: 0 }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                          {m.email && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{m.email}</div>}
                        </div>
                        {m.onboarded
                          ? <span style={{ fontSize: 10, fontWeight: 600, color: '#059669', background: 'rgba(5,150,105,0.1)', padding: '2px 8px', borderRadius: 4, flexShrink: 0 }}>Onboarded</span>
                          : null}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                  <button onClick={() => { setTokenInput(''); setAskToken(true); setSlackMembers([]); setImportError(''); }} style={{
                    background: 'none', border: 'none', fontSize: 12, color: 'var(--muted)', cursor: 'pointer', marginRight: 'auto', fontFamily: 'var(--font-sans)', textDecoration: 'underline',
                  }}>Change token</button>
                  <button onClick={() => setImportModal(false)} disabled={onboarding}
                    style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>Close</button>
                  {selected.size > 0 && (
                    <button onClick={onboardSelected} disabled={onboarding} style={{
                      padding: '8px 18px', borderRadius: 7, border: 'none',
                      background: 'var(--accent)', color: 'var(--accent-fg)',
                      fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      opacity: onboarding ? 0.6 : 1,
                    }}>
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
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
            backdropFilter: 'blur(2px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)',
              padding: 28, width: 380, boxShadow: 'var(--shadow-lg)',
              display: 'flex', flexDirection: 'column', gap: 16,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>Reset password</h3>
              <button onClick={closeReset} disabled={resetting}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>&times;</button>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
              Set a new password for <strong style={{ color: 'var(--text)' }}>{resetUser.username}</strong>. They&apos;ll need the new password on their next login.
            </p>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>New password</label>
              <input
                type="password"
                autoFocus
                value={resetPwd}
                disabled={resetting || resetSuccess}
                onChange={e => setResetPwd(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitReset(); }}
                placeholder="Minimum 8 characters"
                style={{ width: '100%', padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'var(--font-sans)' }}
              />
            </div>
            {resetError && <div style={{ fontSize: 12, color: '#dc2626', background: 'rgba(220,38,38,0.06)', padding: '6px 10px', borderRadius: 6 }}>{resetError}</div>}
            {resetSuccess && <div style={{ fontSize: 12, color: '#059669', background: 'rgba(5,150,105,0.08)', padding: '6px 10px', borderRadius: 6 }}>Password updated</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={closeReset} disabled={resetting}
                style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>Cancel</button>
              <button onClick={submitReset} disabled={resetting || resetSuccess || !resetPwd}
                style={{ padding: '8px 18px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: 'var(--accent-fg)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)', opacity: (resetting || resetSuccess || !resetPwd) ? 0.6 : 1 }}>
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

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--surface)',
    fontSize: 13, color: 'var(--text)', outline: 'none',
    fontFamily: 'var(--font-sans)', boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 6,
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', margin: '0 0 4px' }}>Sign in with Slack</h2>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 24px' }}>
        Allow users to log in using their Slack account. Get these from{' '}
        <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>api.slack.com/apps</a>
        {' '}→ your app → Basic Information. Add user token scopes: <code>openid</code>, <code>profile</code>, <code>email</code>.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={labelStyle}>Redirect URI <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(add this in Slack → OAuth & Permissions)</span></label>
          <input
            style={{ ...inputStyle, color: 'var(--muted)', cursor: 'text' }}
            value={redirectUri}
            readOnly
            onFocus={e => e.currentTarget.select()}
          />
        </div>
        <div>
          <label style={labelStyle}>Client ID</label>
          <input
            style={inputStyle}
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            placeholder="123456789012.123456789012"
          />
        </div>
        <div>
          <label style={labelStyle}>Client Secret</label>
          <input
            style={inputStyle}
            type="password"
            value={clientSecret}
            onChange={e => setClientSecret(e.target.value)}
            placeholder="••••••••••••••••••••••••••••••••"
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          <input
            type="checkbox"
            id="slack-login-open"
            checked={loginOpen}
            onChange={e => setLoginOpen(e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
          <label htmlFor="slack-login-open" style={{ fontSize: 13, color: 'var(--text)', cursor: 'pointer', flex: 1 }}>
            <strong style={{ fontWeight: 600 }}>Allow any workspace member to sign in</strong>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              When off (default), only users imported via Settings → Users can log in with Slack.
            </div>
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={save}
            disabled={saving || !clientId || !clientSecret}
            style={{
              padding: '8px 18px', borderRadius: 8, border: 'none',
              background: 'var(--accent)', color: 'var(--accent-fg)',
              fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {toast && <span style={{ fontSize: 13, color: 'var(--success, #16a34a)' }}>{toast}</span>}
        </div>
        {clientId && (
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
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
    <div style={{ marginBottom: 22, paddingBottom: 22, borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 14 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  );
}

function Field({ label, value, onChange, onBlur, hint, maxLength }: {
  label: string; value: string; onChange: (v: string) => void; onBlur?: () => void; hint?: string; maxLength?: number;
}) {
  const overLimit = maxLength !== undefined && value.length > maxLength;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>{label}</label>
        {maxLength !== undefined && (
          <span style={{ fontSize: 10, color: overLimit ? 'var(--red)' : 'var(--subtle)', fontFamily: 'var(--font-mono)' }}>
            {value.length}/{maxLength}
          </span>
        )}
      </div>
      <input type="text" value={value} maxLength={maxLength} onChange={e => onChange(e.target.value)}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; onBlur?.(); }}
        style={{
          width: '100%', background: 'var(--surface)',
          border: `1px solid ${overLimit ? 'var(--red)' : 'var(--border)'}`,
          borderRadius: 7, padding: '8px 11px', color: 'var(--text)',
          fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none',
          transition: 'border-color 0.15s', boxSizing: 'border-box',
        }}
        onFocus={e => { if (!overLimit) e.currentTarget.style.borderColor = 'var(--accent)'; }}
      />
      {hint && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>{hint}</p>}
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
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 7, padding: '8px 11px', color: 'var(--text)',
          fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none',
          transition: 'border-color 0.15s', boxSizing: 'border-box',
          cursor: 'pointer',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}{o.sub ? ` — ${o.sub}` : ''}
          </option>
        ))}
      </select>
      {hint && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>{hint}</p>}
    </div>
  );
}

function PrimaryBtn({ children, onClick, loading }: { children: React.ReactNode; onClick?: () => void; loading?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      background: loading ? 'var(--border)' : 'var(--accent)',
      color: 'var(--accent-fg)', border: 'none', borderRadius: 7,
      padding: '8px 18px', fontSize: 13, fontWeight: 500,
      cursor: loading ? 'not-allowed' : 'pointer',
      fontFamily: 'var(--font-sans)', transition: 'opacity 0.15s',
    }}
      onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
    >{loading ? 'Saving...' : children}</button>
  );
}
