'use client';

/**
 * @fileoverview Client layout shell — auth provider + responsive sidebar + main.
 *
 * On mobile (<768px), sidebar is hidden by default and shown as an overlay.
 * A hamburger button is shown in the top-left of the main area.
 *
 * @module web/app/layout-shell
 */

import { useContext, useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar, SidebarContext } from './sidebar';
import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider } from '@/lib/theme-context';

/**
 * Renders auth provider + sidebar + main content.
 * Login page gets no sidebar.
 *
 * @param {{ children: React.ReactNode }} props
 */
export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === '/login') {
    return <>{children}</>;
  }

  return (
    <ThemeProvider>
      <AuthProvider>
        <ResponsiveLayout>{children}</ResponsiveLayout>
      </AuthProvider>
    </ThemeProvider>
  );
}

function ResponsiveLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Close mobile sidebar on navigation
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  return (
    <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)}>
      <Main isMobile={isMobile} onHamburger={() => setMobileOpen(true)}>
        {children}
      </Main>
    </Sidebar>
  );
}

function Main({ children, isMobile, onHamburger }: { children: React.ReactNode; isMobile: boolean; onHamburger: () => void }) {
  const { width } = useContext(SidebarContext);
  return (
    <main style={{
      marginLeft: isMobile ? 0 : width,
      transition: 'margin-left 0.25s cubic-bezier(0.16,1,0.3,1)',
    }}>
      {/* Mobile hamburger */}
      {isMobile && (
        <button
          onClick={onHamburger}
          style={{
            position: 'fixed', top: 12, left: 12, zIndex: 48,
            width: 36, height: 36, borderRadius: 8,
            background: 'var(--surface)', border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-md)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'var(--text)',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </button>
      )}
      {children}
    </main>
  );
}
