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
import { guardAdmin } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';

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
  const denied = guardAdmin(req);
  if (denied) return denied;
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

    // Some MCPs need env values as command args, not env vars
    // Map: env key → how to add as args (simple = just value, prefixed = --flag value)
    const ARG_MAP: Record<string, string | null> = {
      FILESYSTEM_PATH: null,           // just append value
      DATABASE_URL: null,              // just append value
      SQLITE_PATH: null,               // just append value
      GIT_REPOSITORY_PATH: '--repository',  // --repository /path
      MEMORY_FILE_PATH: '--file',           // --file /path (if set)
    };
    if (envValues) {
      for (const [key, value] of Object.entries(envValues)) {
        if (key in ARG_MAP && value) {
          const flag = ARG_MAP[key];
          if (flag) args.push(flag, value);
          else args.push(value);
          delete envRefs[key];
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

    // Handle OAuth token (pasted by user)
    const oauthToken = envValues?.['__OAUTH_ACCESS_TOKEN'];
    if (oauthToken) {
      const storeKey = `MCP_${template.id.toUpperCase()}_TOKEN`;
      await setEnvVar(storeKey, oauthToken, `OAuth token for ${template.name}`);
      config.headers = { Authorization: 'Bearer ' };
      config.envRefs = { Authorization: storeKey };
    } else if (Object.keys(envRefs).length > 0) {
      // For env-based HTTP auth (e.g. GitHub PAT)
      const firstRef = Object.entries(envRefs)[0];
      if (firstRef) {
        config.headers = { Authorization: 'Bearer ' };
        config.envRefs = { Authorization: firstRef[1] };
      }
    }
  }

  // Create the MCP server in the catalog
  const session = getSessionFromRequest(req);
  const server = await createMcpServer({
    name: template.id,
    type,
    config: config as any,
    description: template.description,
    enabled: true,
  }, session?.username ?? 'admin');

  return NextResponse.json(server, { status: 201 });
}
