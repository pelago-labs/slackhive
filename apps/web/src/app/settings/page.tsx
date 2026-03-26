'use client';

/**
 * @fileoverview Platform settings page — branding, dashboard, and user management.
 *
 * Tabs: General · Users (admin only)
 *
 * @module web/app/settings
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';

type Tab = 'general' | 'users';

interface User {
  id: string;
  username: string;
  role: string;
  createdAt: string;
}

const DEFAULTS: Record<string, string> = {
  appName: 'SlackHive',
  tagline: 'Claude Code Platform',
  logoUrl: '',
  dashboardTitle: 'Welcome to Silicon Valley',
};

/**
 * Settings page with General and Users tabs.
 *
 * @returns {JSX.Element}
 */
export default function SettingsPage() {
  const { canEdit } = useAuth();
  const [tab, setTab] = useState<Tab>('general');

  return (
    <div className="fade-up" style={{ maxWidth: 680, padding: '36px 40px' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', margin: 0 }}>
          Settings
        </h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          Configure platform branding, appearance, and access.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 24 }}>
        <TabBtn active={tab === 'general'} onClick={() => setTab('general')}>General</TabBtn>
        {canEdit && <TabBtn active={tab === 'users'} onClick={() => setTab('users')}>Users</TabBtn>}
      </div>

      {tab === 'general' && <GeneralTab />}
      {tab === 'users' && canEdit && <UsersTab />}
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
          background: 'var(--accent)', color: '#fff',
          padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          boxShadow: 'var(--shadow-md)',
        }}>{toast}</div>
      )}

      <Section title="Branding">
        <Field label="App Name" hint="Displayed in the sidebar header and browser tab."
          value={appName} onChange={setAppName} onBlur={() => save('appName', appName)} />
        <Field label="Tagline" hint="Short description shown below the app name."
          value={tagline} onChange={setTagline} onBlur={() => save('tagline', tagline)} />
        <Field label="Logo URL" hint="URL to a square image (28×28). Leave empty for the default icon."
          value={logoUrl} onChange={setLogoUrl} onBlur={() => save('logoUrl', logoUrl)} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>Preview:</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoUrl || '/logo.svg'} alt="Logo" style={{ width: 28, height: 28, borderRadius: 8, objectFit: 'cover' }} />
          {!logoUrl && <span style={{ fontSize: 11, color: 'var(--subtle)', fontStyle: 'italic' }}>Using default logo</span>}
        </div>
      </Section>

      <Section title="Dashboard">
        <Field label="Dashboard Title" hint="Main heading on the dashboard page."
          value={dashboardTitle} onChange={setDashboardTitle} onBlur={() => save('dashboardTitle', dashboardTitle)} />
      </Section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <PrimaryBtn onClick={saveAll} loading={saving}>Save All</PrimaryBtn>
      </div>
    </>
  );
}

// =============================================================================
// Users tab
// =============================================================================

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'viewer' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    fetch('/api/auth/users').then(r => r.json()).then(setUsers).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

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

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          Manage platform access. Superadmin is configured via environment variables.
        </p>
        <button onClick={() => setShowForm(true)} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--accent)', color: '#fff',
          padding: '8px 16px', borderRadius: 8,
          fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
          fontFamily: 'var(--font-sans)', flexShrink: 0,
        }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          Add User
        </button>
      </div>

      {/* User list */}
      {loading ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading...</p>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {/* Superadmin row */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
            borderBottom: users.length > 0 ? '1px solid var(--border)' : 'none',
            background: 'var(--surface-2)',
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8, background: '#171717', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 600, color: '#fff',
            }}>S</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>admin</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Environment variable</div>
            </div>
            <span style={{
              fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
              color: '#d97706', background: 'rgba(217,119,6,0.1)',
              padding: '2px 8px', borderRadius: 4,
            }}>superadmin</span>
          </div>

          {users.map((u, i) => (
            <div key={u.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
              borderBottom: i < users.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                background: u.role === 'admin' ? '#171717' : 'var(--surface-2)',
                border: u.role === 'admin' ? 'none' : '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 600, color: u.role === 'admin' ? '#fff' : 'var(--text)',
              }}>{u.username.charAt(0).toUpperCase()}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{u.username}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Created {new Date(u.createdAt).toLocaleDateString()}</div>
              </div>
              <span style={{
                fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                color: u.role === 'admin' ? '#2563eb' : 'var(--muted)',
                background: u.role === 'admin' ? 'rgba(37,99,235,0.1)' : 'var(--surface-2)',
                padding: '2px 8px', borderRadius: 4,
              }}>{u.role}</span>
              <button onClick={() => remove(u.id, u.username)} style={{
                background: 'none', border: 'none', color: '#dc2626',
                fontSize: 12, cursor: 'pointer', opacity: 0.6,
                fontFamily: 'var(--font-sans)', transition: 'opacity 0.12s',
              }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}
              >Delete</button>
            </div>
          ))}

          {users.length === 0 && (
            <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
              No additional users. Only the superadmin account exists.
            </div>
          )}
        </div>
      )}

      {/* Create modal */}
      {showForm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
          backdropFilter: 'blur(2px)',
        }}>
          <div style={{
            background: '#fff', borderRadius: 14, border: '1px solid var(--border)',
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
                style={{ width: '100%', padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', fontSize: 13, outline: 'none', fontFamily: 'var(--font-sans)', background: '#fff' }}>
                <option value="viewer">Viewer — read-only access</option>
                <option value="admin">Admin — full access</option>
              </select>
            </div>
            {error && <div style={{ fontSize: 12, color: '#dc2626', background: 'rgba(220,38,38,0.06)', padding: '6px 10px', borderRadius: 6 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowForm(false); setError(''); }}
                style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid var(--border)', background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>Cancel</button>
              <button onClick={create} disabled={saving}
                style={{ padding: '8px 18px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
                {saving ? 'Creating...' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// =============================================================================
// Shared UI helpers
// =============================================================================

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      background: 'none', border: 'none', cursor: 'pointer',
      padding: '10px 16px', fontSize: 13,
      color: active ? 'var(--text)' : 'var(--muted)',
      fontWeight: active ? 600 : 400,
      fontFamily: 'var(--font-sans)',
      position: 'relative',
      transition: 'color 0.15s',
      borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
      marginBottom: -1,
    }}>{children}</button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22, paddingBottom: 22, borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 14 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  );
}

function Field({ label, value, onChange, onBlur, hint }: {
  label: string; value: string; onChange: (v: string) => void; onBlur?: () => void; hint?: string;
}) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>{label}</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; onBlur?.(); }}
        style={{
          width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 7, padding: '8px 11px', color: 'var(--text)',
          fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none',
          transition: 'border-color 0.15s', boxSizing: 'border-box',
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
      />
      {hint && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>{hint}</p>}
    </div>
  );
}

function PrimaryBtn({ children, onClick, loading }: { children: React.ReactNode; onClick?: () => void; loading?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      background: loading ? 'var(--border)' : 'var(--accent)',
      color: '#fff', border: 'none', borderRadius: 7,
      padding: '8px 18px', fontSize: 13, fontWeight: 500,
      cursor: loading ? 'not-allowed' : 'pointer',
      fontFamily: 'var(--font-sans)', transition: 'opacity 0.15s',
    }}
      onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
    >{loading ? 'Saving...' : children}</button>
  );
}
