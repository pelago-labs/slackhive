import type { Metadata } from 'next';
import './globals.css';
import { LayoutShell } from './layout-shell';

export const metadata: Metadata = {
  title: 'SlackHive',
  description: 'Claude Code agent control plane',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){var t=localStorage.getItem('slackhive-theme');
          if(!t)t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
          document.documentElement.setAttribute('data-theme',t)})()
        `}} />
      </head>
      <body style={{ margin: 0 }}>
        <LayoutShell>{children}</LayoutShell>
      </body>
    </html>
  );
}
