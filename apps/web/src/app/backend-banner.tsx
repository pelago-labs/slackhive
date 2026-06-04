'use client';

/**
 * @fileoverview Platform-wide credential banner. Polls the ACTIVE agent
 * backend's connection status and, when it's expired or not connected, shows a
 * thin red strip at the top of every page prompting re-login. Self-clears the
 * moment the status returns to "connected" (e.g. after a Detect/re-login), so
 * the operator always knows when agents can't actually run.
 *
 * Only admins can read the status endpoint; for everyone else the fetch is
 * denied and the banner stays hidden.
 *
 * @module web/app/backend-banner
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

interface Status { backend: string; label: string; status: string; hint?: string }

const POLL_MS = 30_000;

export function BackendBanner() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let alive = true;
    const check = () => {
      fetch('/api/system/backend-status', { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(s => { if (alive) setStatus(s); })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, POLL_MS);
    // Re-check when the tab regains focus, so a fresh terminal login reflects fast.
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, []);

  if (!status || status.status === 'connected') return null;

  const expired = status.status === 'expired';
  const label = status.label || 'Agent backend';
  const message = expired
    ? `${label} session expired — agents can't run until you re-authenticate.`
    : `No ${label} account connected — agents can't run until you connect one.`;

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 45,
      background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 500,
      padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 10,
      fontFamily: 'var(--font-sans)',
    }}>
      <AlertTriangle size={15} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      <Link href="/settings" style={{
        color: '#fff', fontWeight: 600, textDecoration: 'underline', textUnderlineOffset: 2,
        whiteSpace: 'nowrap', flexShrink: 0,
      }}>
        {expired ? 'Re-authenticate' : 'Connect'}
      </Link>
    </div>
  );
}
