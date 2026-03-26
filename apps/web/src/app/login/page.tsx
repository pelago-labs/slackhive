'use client';

/**
 * @fileoverview Login page — simple username/password form.
 *
 * @module web/app/login
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Login page with username/password form.
 *
 * @returns {JSX.Element}
 */
export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      width: '100vw', minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{
        width: 360, background: '#fff', borderRadius: 14,
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)',
        padding: '36px 32px',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12, margin: '0 auto 14px',
            background: '#e5e5e5',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" fill="#a3a3a3"/>
              <path d="M9 11h6a5 5 0 015 5v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2a5 5 0 015-5z" fill="#a3a3a3"/>
              <circle cx="17" cy="6" r="3" fill="#d4d4d4" stroke="#e5e5e5" strokeWidth="1"/>
              <path d="M15.5 6h3M17 4.5v3" stroke="#a3a3a3" strokeWidth="0.8" strokeLinecap="round"/>
            </svg>
          </div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>
            SlackHive
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Sign in to continue
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--surface)',
                fontSize: 14, color: 'var(--text)', outline: 'none',
                fontFamily: 'var(--font-sans)',
                transition: 'border-color 0.15s',
                boxSizing: 'border-box',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--surface)',
                fontSize: 14, color: 'var(--text)', outline: 'none',
                fontFamily: 'var(--font-sans)',
                transition: 'border-color 0.15s',
                boxSizing: 'border-box',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          {error && (
            <div style={{
              fontSize: 13, color: '#dc2626', background: 'rgba(220,38,38,0.06)',
              padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(220,38,38,0.15)',
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            style={{
              width: '100%', padding: '10px', borderRadius: 8, border: 'none',
              background: loading ? 'var(--border-2)' : 'var(--accent)',
              color: '#fff', fontSize: 14, fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-sans)',
              transition: 'opacity 0.15s',
              marginTop: 4,
            }}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
