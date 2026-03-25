'use client';

/**
 * @fileoverview Platform settings page for branding configuration.
 *
 * Allows users to set the app name, tagline, and logo URL.
 * Values are persisted to the `settings` table and consumed by the sidebar.
 *
 * Route: /settings
 * @module web/app/settings
 */

import React, { useEffect, useState } from 'react';

const DEFAULTS: Record<string, string> = {
  appName: 'AI Teams',
  tagline: 'Claude Code Platform',
  logoUrl: '',
  dashboardTitle: 'Welcome to Silicon Valley',
};

/**
 * Settings page — branding configuration.
 *
 * @returns {JSX.Element}
 */
export default function SettingsPage() {
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

  /** Persists a single key-value setting to the API. */
  async function save(key: string, value: string): Promise<void> {
    setSaving(true);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      setToast(`Saved ${key}`);
      setTimeout(() => setToast(''), 2000);
    } finally {
      setSaving(false);
    }
  }

  /** Saves all branding fields at once. */
  async function saveAll(): Promise<void> {
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
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fade-up" style={{ maxWidth: 640, margin: '0 auto', padding: '48px 24px' }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', margin: 0 }}>
          Settings
        </h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          Configure platform branding and appearance.
        </p>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 999,
          background: 'var(--accent)', color: '#fff',
          padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          boxShadow: 'var(--shadow-md)',
        }}>
          {toast}
        </div>
      )}

      {/* Branding section */}
      <Section title="Branding">
        <Field
          label="App Name"
          hint="Displayed in the sidebar header and browser tab."
          value={appName}
          onChange={setAppName}
          onBlur={() => save('appName', appName)}
        />
        <Field
          label="Tagline"
          hint="Short description shown below the app name."
          value={tagline}
          onChange={setTagline}
          onBlur={() => save('tagline', tagline)}
        />
        <Field
          label="Logo URL"
          hint="URL to a square image (28x28). Leave empty for the default icon."
          value={logoUrl}
          onChange={setLogoUrl}
          onBlur={() => save('logoUrl', logoUrl)}
        />
        {/* Logo preview */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>Preview:</div>
          <div style={{
            width: 28, height: 28, borderRadius: 8, flexShrink: 0,
            background: logoUrl ? 'transparent' : '#e5e5e5',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden',
          }}>
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="Logo" style={{ width: 28, height: 28, objectFit: 'cover' }} />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" fill="#a3a3a3"/>
                <path d="M9 11h6a5 5 0 015 5v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2a5 5 0 015-5z" fill="#a3a3a3"/>
                <circle cx="17" cy="6" r="3" fill="#d4d4d4" stroke="#e5e5e5" strokeWidth="1"/>
                <path d="M15.5 6h3M17 4.5v3" stroke="#a3a3a3" strokeWidth="0.8" strokeLinecap="round"/>
              </svg>
            )}
          </div>
          {!logoUrl && (
            <span style={{ fontSize: 11, color: 'var(--subtle)', fontStyle: 'italic' }}>
              Using default icon
            </span>
          )}
        </div>
      </Section>

      {/* Dashboard section */}
      <Section title="Dashboard">
        <Field
          label="Dashboard Title"
          hint="Main heading on the dashboard page."
          value={dashboardTitle}
          onChange={setDashboardTitle}
          onBlur={() => save('dashboardTitle', dashboardTitle)}
        />
      </Section>

      {/* Save all button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <PrimaryBtn onClick={saveAll} loading={saving}>Save All</PrimaryBtn>
      </div>
    </div>
  );
}

// =============================================================================
// Shared UI helpers (same patterns as agent detail page)
// =============================================================================

/** Section wrapper with uppercase title. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 22, paddingBottom: 22,
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em',
        textTransform: 'uppercase', marginBottom: 14,
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  );
}

/** Text input field with label and optional hint. */
function Field({ label, value, onChange, onBlur, hint }: {
  label: string; value: string; onChange: (v: string) => void;
  onBlur?: () => void; hint?: string;
}) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>
        {label}
      </label>
      <input
        type="text" value={value} onChange={e => onChange(e.target.value)}
        onBlur={e => {
          e.currentTarget.style.borderColor = 'var(--border)';
          onBlur?.();
        }}
        style={{
          width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 7, padding: '8px 11px', color: 'var(--text)',
          fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none',
          transition: 'border-color 0.15s',
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
      />
      {hint && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--subtle)' }}>{hint}</p>}
    </div>
  );
}

/** Primary action button. */
function PrimaryBtn({ children, onClick, loading }: {
  children: React.ReactNode; onClick?: () => void; loading?: boolean;
}) {
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
