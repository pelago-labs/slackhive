/**
 * @fileoverview GET /api/mcps/detected
 * Detects MCPs already configured in Claude Code CLI.
 * Reads from ~/.claude/settings.json (MCP servers) and
 * ~/.claude/.credentials.json (OAuth tokens).
 *
 * Returns: { mcps: [{ name, url, type, hasToken }], oauthTokens: [{ name, url, hasToken }] }
 *
 * @module web/api/mcps/detected
 */

import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

interface DetectedMcp {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  url?: string;
  command?: string;
  hasToken: boolean;
}

export async function GET(): Promise<NextResponse> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  const claudeDir = path.join(home, '.claude');
  const detected: DetectedMcp[] = [];

  // Read Claude CLI MCP settings
  try {
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      for (const [name, cfg] of Object.entries(settings.mcpServers ?? {})) {
        const c = cfg as any;
        detected.push({
          name,
          type: c.type ?? (c.url ? 'http' : 'stdio'),
          url: c.url,
          command: c.command,
          hasToken: true, // If it's in settings, it's configured
        });
      }
    }
  } catch { /* ignore */ }

  // Read OAuth tokens
  try {
    const credPath = path.join(claudeDir, '.credentials.json');
    if (fs.existsSync(credPath)) {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      for (const [key, val] of Object.entries(creds.mcpOAuth ?? {})) {
        const v = val as any;
        const name = v.serverName ?? key.split('|')[0].replace('plugin:', '');
        const url = v.serverUrl ?? '';
        const hasToken = !!(v.accessToken && v.accessToken.length > 0 && v.expiresAt > Date.now());

        // Only include if token is valid; skip empty/expired OAuth entries
        if (!hasToken) continue;
        // Don't duplicate if already in settings
        if (!detected.find(d => d.url === url || d.name === name)) {
          detected.push({ name, type: 'http', url, hasToken });
        }
      }
    }
  } catch { /* ignore */ }

  return NextResponse.json({ detected });
}
