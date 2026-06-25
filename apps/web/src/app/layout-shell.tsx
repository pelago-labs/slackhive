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
import { Menu } from 'lucide-react';
import { Sidebar, SidebarContext } from './sidebar';
import { BackendBanner } from './backend-banner';
import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider } from '@/lib/theme-context';
import { Toaster } from '@/components/ui/sonner';

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
        <Toaster position="bottom-right" />
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
          aria-label="Open navigation"
          className="fixed left-3 top-3 z-[48] flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-foreground shadow-md"
        >
          <Menu size={18} strokeWidth={1.75} />
        </button>
      )}
      <BackendBanner />
      {children}
    </main>
  );
}
