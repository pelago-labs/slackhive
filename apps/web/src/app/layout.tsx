import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from './sidebar';

export const metadata: Metadata = {
  title: 'Agent Team',
  description: 'Slack Claude Code Agent Team — control plane',
};

/**
 * Root layout with fixed sidebar navigation.
 * Sidebar contains: logo, primary nav, settings, external links.
 *
 * @param {{ children: React.ReactNode }} props
 * @returns {JSX.Element}
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ display: 'flex', minHeight: '100vh' }}>
        <Sidebar />

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <main style={{ flex: 1, marginLeft: 220, minHeight: '100vh', overflow: 'auto' }}>
          {children}
        </main>
      </body>
    </html>
  );
}

