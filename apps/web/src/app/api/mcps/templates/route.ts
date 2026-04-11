/**
 * @fileoverview GET /api/mcps/templates
 * Returns the built-in MCP server template catalog.
 * Supports optional ?q= search and ?category= filter.
 *
 * POST /api/mcps/templates
 * Creates an MCP server from a template. Accepts { templateId, envValues }.
 *
 * @module web/api/mcps/templates
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  MCP_TEMPLATES,
  MCP_CATEGORIES,
  getTemplateById,
  searchTemplates,
  getTemplatesByCategory,
} from '@slackhive/shared';
import type { McpCategory } from '@slackhive/shared';
import { createMcpServer, setEnvVar } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mcps/templates
 * Returns templates with optional filtering.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams.get('q');
  const category = req.nextUrl.searchParams.get('category') as McpCategory | null;

  let templates = MCP_TEMPLATES;
  if (q) {
    templates = searchTemplates(q);
  } else if (category && category in MCP_CATEGORIES) {
    templates = getTemplatesByCategory(category);
  }

  return NextResponse.json({
    templates,
    categories: MCP_CATEGORIES,
    total: MCP_TEMPLATES.length,
  });
}

/**
 * POST /api/mcps/templates
 * Creates an MCP server from a template.
 *
 * Body: {
 *   templateId: string,
 *   envValues?: Record<string, string>  // Values for required env vars
 * }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json();
  const { templateId, envValues } = body as {
    templateId: string;
    envValues?: Record<string, string>;
  };

  const template = getTemplateById(templateId);
  if (!template) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  }

  // Validate required env vars are provided
  for (const envKey of template.envKeys) {
    if (envKey.required && (!envValues || !envValues[envKey.key])) {
      return NextResponse.json(
        { error: `Missing required value: ${envKey.label}` },
        { status: 400 }
      );
    }
  }

  // Store env var values in the encrypted env vars store
  const envRefs: Record<string, string> = {};
  if (envValues) {
    for (const [key, value] of Object.entries(envValues)) {
      if (value) {
        // Store in platform env_vars with a namespaced key
        const storeKey = `MCP_${template.id.toUpperCase()}_${key}`;
        await setEnvVar(storeKey, value, `Auto-created for ${template.name} MCP template`);
        envRefs[key] = storeKey;
      }
    }
  }

  // Build MCP server config based on transport type
  let config: Record<string, unknown>;
  let type: 'stdio' | 'sse' | 'http';

  if (template.transport === 'stdio') {
    type = 'stdio';
    const args = [...(template.args ?? [])];

    // Some MCPs need env values as command args (e.g. filesystem path, postgres connection string)
    const ARG_KEYS = new Set(['FILESYSTEM_PATH', 'DATABASE_URL', 'SQLITE_PATH']);
    if (envValues) {
      for (const [key, value] of Object.entries(envValues)) {
        if (ARG_KEYS.has(key) && value) {
          args.push(value);
          delete envRefs[key]; // Don't also set as env var
        }
      }
    }

    config = {
      command: template.command,
      args,
    };
    if (Object.keys(envRefs).length > 0) {
      config.envRefs = envRefs;
    }
  } else {
    // HTTP transport
    type = 'http';
    config = {
      url: template.url,
    };
    // For HTTP servers with auth tokens, set them as headers via envRefs
    if (Object.keys(envRefs).length > 0) {
      config.headers = {};
      config.envRefs = envRefs;
    }
  }

  // Create the MCP server in the catalog
  const server = await createMcpServer({
    name: template.id,
    type,
    config: config as any,
    description: `${template.icon} ${template.name} — ${template.description}`,
    enabled: true,
  });

  return NextResponse.json(server, { status: 201 });
}
