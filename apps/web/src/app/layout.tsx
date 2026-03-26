import type { Metadata } from 'next';
import './globals.css';
import { LayoutShell } from './layout-shell';

export const metadata: Metadata = {
  title: 'SlackHive',
  description: 'Claude Code agent control plane',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <LayoutShell>{children}</LayoutShell>
      </body>
    </html>
  );
}
