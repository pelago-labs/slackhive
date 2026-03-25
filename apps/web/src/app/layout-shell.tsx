'use client';

/**
 * @fileoverview Client layout shell — sidebar + main with dynamic margin.
 *
 * @module web/app/layout-shell
 */

import { useContext } from 'react';
import { Sidebar, SidebarContext } from './sidebar';

/**
 * Renders sidebar + main content. Main content margin responds to sidebar state.
 *
 * @param {{ children: React.ReactNode }} props
 */
export function LayoutShell({ children }: { children: React.ReactNode }) {
  return (
    <Sidebar>
      <Main>{children}</Main>
    </Sidebar>
  );
}

function Main({ children }: { children: React.ReactNode }) {
  const { width } = useContext(SidebarContext);
  return (
    <main style={{
      flex: 1,
      marginLeft: width,
      minHeight: '100vh',
      overflow: 'auto',
      transition: 'margin-left 0.25s cubic-bezier(0.16,1,0.3,1)',
    }}>
      {children}
    </main>
  );
}
