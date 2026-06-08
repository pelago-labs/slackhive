import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { LayoutShell } from './layout-shell';

// Self-hosted + preloaded fonts (no runtime Google-Fonts @import → no fallback
// flash, identical rendering on every machine). Exposed as CSS variables that
// globals.css's --font-sans / --font-mono reference.
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], display: 'swap', variable: '--font-jb-mono' });

export const metadata: Metadata = {
  title: 'SlackHive',
  description: 'Claude Code agent control plane',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){var t=localStorage.getItem('slackhive-theme');
          if(!t)t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
          document.documentElement.setAttribute('data-theme',t)})()
        `}} />
        {/*
          ChunkLoadError auto-recovery for stale tabs after a deploy.
          When a user keeps a tab open across a redeploy and then triggers a
          dynamic import (route navigation, lazy panel), the browser fetches
          the OLD content-hashed chunk which now 404s. Catch that one error
          class and reload — once per tab via sessionStorage to avoid loops.
        */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){
            function isChunkErr(e){var m=(e&&(e.message||(e.reason&&e.reason.message)))||'';
              return /ChunkLoadError|Loading chunk \\\\d+ failed|Loading CSS chunk/.test(m);}
            function recover(e){if(!isChunkErr(e))return;
              if(sessionStorage.getItem('slackhive-chunk-reloaded'))return;
              sessionStorage.setItem('slackhive-chunk-reloaded','1');
              location.reload();}
            window.addEventListener('error',recover);
            window.addEventListener('unhandledrejection',recover);
          })()
        `}} />
      </head>
      <body style={{ margin: 0 }}>
        <LayoutShell>{children}</LayoutShell>
      </body>
    </html>
  );
}
