/**
 * @fileoverview Built-in MCP server templates catalog.
 *
 * Pre-configured templates for 50+ popular MCP servers.
 * Users can one-click install these instead of manually configuring
 * command, args, env vars, and transport settings.
 *
 * Categories:
 *   developer    — GitHub, GitLab, Git, code tools
 *   productivity — Notion, Linear, Asana, Jira, Slack
 *   data         — PostgreSQL, MySQL, SQLite, MongoDB, Redis, Supabase
 *   cloud        — AWS, GCP, Azure, Vercel, Cloudflare
 *   design       — Figma, Canva
 *   analytics    — Sentry, Datadog, Amplitude
 *   search       — Brave Search, Exa, Tavily, Context7
 *   automation   — Zapier, n8n, Playwright, Puppeteer
 *   finance      — Stripe, PayPal
 *   ai           — Memory, Sequential Thinking, Firecrawl
 *   communication — Slack, email
 *
 * @module @slackhive/shared/mcp-templates
 */

export interface McpEnvKey {
  /** Environment variable name (e.g., "GITHUB_TOKEN"). */
  key: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Whether this env var is required for the server to work. */
  required: boolean;
  /** Placeholder/hint shown in the input field. */
  placeholder?: string;
}

export interface McpTemplate {
  /** Unique template ID (URL-safe). */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description. */
  description: string;
  /** Category for grouping in the UI. */
  category: McpCategory;
  /** Emoji icon (fallback). */
  icon: string;
  /** Simple Icons slug for brand logo (e.g., 'github', 'notion'). */
  logo?: string;
  /** Transport type. */
  transport: 'stdio' | 'http';
  /** For stdio: the command to execute. */
  command?: string;
  /** For stdio: command arguments. */
  args?: string[];
  /** For http: the server URL. */
  url?: string;
  /** Required/optional environment variables. */
  envKeys: McpEnvKey[];
  /** Tags for search/filtering. */
  tags: string[];
  /** Whether this is an official/first-party integration. */
  official: boolean;
  /** Link to setup documentation. */
  docsUrl?: string;
  /** Auth method: 'oauth' (HTTP servers needing token), 'env' (needs env vars), 'none' (local tools). */
  auth?: 'oauth' | 'env' | 'none';
  /** URL where user can generate/get their token (for oauth templates). */
  tokenUrl?: string;
  /** Hint for what the token looks like. */
  tokenHint?: string;
}

export type McpCategory =
  | 'developer'
  | 'productivity'
  | 'data'
  | 'cloud'
  | 'design'
  | 'analytics'
  | 'search'
  | 'automation'
  | 'finance'
  | 'ai'
  | 'communication';

// =============================================================================
// Template Catalog
// =============================================================================

export const MCP_TEMPLATES: McpTemplate[] = [
  // ─── Developer ────────────────────────────────────────────────────────────

  {
    id: 'github',
    name: 'GitHub',
    description: 'Manage repos, issues, PRs, code search, and workflows',
    category: 'developer',
    icon: '🐙',
    logo: 'github',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    envKeys: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub Personal Access Token', required: true, placeholder: 'ghp_...' },
    ],
    tags: ['git', 'code', 'pr', 'issues', 'repository'],
    official: true,
    docsUrl: 'https://github.com/github/github-mcp-server',
    auth: 'env',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Manage GitLab repos, merge requests, issues, and pipelines',
    category: 'developer',
    icon: '🦊',
    logo: 'gitlab',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gitlab'],
    envKeys: [
      { key: 'GITLAB_PERSONAL_ACCESS_TOKEN', label: 'GitLab Personal Access Token', required: true, placeholder: 'glpat-...' },
      { key: 'GITLAB_API_URL', label: 'GitLab API URL', required: false, placeholder: 'https://gitlab.com/api/v4' },
    ],
    tags: ['git', 'code', 'merge-request', 'ci-cd'],
    official: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab',
    auth: 'env',
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Read commit history, diffs, branches, and repository analysis',
    category: 'developer',
    icon: '📦',
    logo: 'git',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    envKeys: [
      { key: 'GIT_REPOSITORY_PATH', label: 'Repository Path', required: false, placeholder: '/path/to/repo (optional — uses cwd if empty)' },
    ],
    tags: ['git', 'version-control', 'commits', 'branches'],
    official: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    auth: 'none',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, and search files within allowed directories',
    category: 'developer',
    icon: '📁',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    envKeys: [
      { key: 'FILESYSTEM_PATH', label: 'Allowed Directory Path', required: true, placeholder: '/path/to/project' },
    ],
    tags: ['files', 'directories', 'read', 'write'],
    official: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    auth: 'none',
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date, version-specific library docs and code examples',
    category: 'developer',
    icon: '📚',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    envKeys: [],
    tags: ['documentation', 'libraries', 'code-examples'],
    official: false,
    docsUrl: 'https://github.com/upstash/context7',
    auth: 'none',
  },
  {
    id: 'postman',
    name: 'Postman',
    description: 'Access API collections, environments, and run requests',
    category: 'developer',
    icon: '🧪',
    logo: 'postman',
    transport: 'http',
    url: 'https://mcp.postman.com/minimal',
    envKeys: [],
    tags: ['api', 'testing', 'http', 'collections'],
    official: true,
    docsUrl: 'https://learning.postman.com/docs/postman-ai-agent-builder/mcp/',
    auth: 'oauth',
    tokenUrl: 'https://go.postman.co/settings/me/api-keys',
    tokenHint: 'Settings → API Keys → Generate',
  },

  // ─── Productivity ─────────────────────────────────────────────────────────

  {
    id: 'notion',
    name: 'Notion',
    description: 'Read and write Notion pages, query databases, search workspace',
    category: 'productivity',
    icon: '📝',
    logo: 'notion',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    envKeys: [],
    tags: ['wiki', 'docs', 'database', 'workspace'],
    official: true,
    docsUrl: 'https://developers.notion.com/docs/get-started-with-mcp',
    auth: 'oauth',
    tokenUrl: 'https://www.notion.so/profile/integrations',
    tokenHint: 'Create an internal integration → copy the token (ntn_...)',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Manage issues, projects, cycles, and team workflows',
    category: 'productivity',
    icon: '📐',
    logo: 'linear',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    envKeys: [],
    tags: ['issues', 'project-management', 'sprints', 'bugs'],
    official: true,
    docsUrl: 'https://linear.app/docs/mcp',
    auth: 'oauth',
    tokenUrl: 'https://linear.app/settings/api',
    tokenHint: 'Settings → API → Create key',
  },
  {
    id: 'asana',
    name: 'Asana',
    description: 'Manage tasks, projects, and team workflows',
    category: 'productivity',
    icon: '✅',
    logo: 'asana',
    transport: 'http',
    url: 'https://mcp.asana.com/mcp',
    envKeys: [],
    tags: ['tasks', 'project-management', 'teams'],
    official: true,
    docsUrl: 'https://developers.asana.com/docs/using-asanas-mcp-server',
    auth: 'oauth',
    tokenUrl: 'https://app.asana.com/0/developer-console',
    tokenHint: 'Developer Console → Personal Access Tokens',
  },
  {
    id: 'atlassian',
    name: 'Atlassian (Jira + Confluence)',
    description: 'Manage Jira issues, Confluence pages, and cross-platform search',
    category: 'productivity',
    icon: '🔷',
    logo: 'atlassian',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'atlassian-mcp'],
    envKeys: [
      { key: 'ATLASSIAN_SITE_URL', label: 'Atlassian Site URL', required: true, placeholder: 'https://yoursite.atlassian.net' },
      { key: 'ATLASSIAN_USER_EMAIL', label: 'Atlassian Email', required: true, placeholder: 'you@company.com' },
      { key: 'ATLASSIAN_API_TOKEN', label: 'Atlassian API Token', required: true },
    ],
    tags: ['jira', 'confluence', 'tickets', 'wiki', 'project-management'],
    official: false,
    docsUrl: 'https://github.com/Parthav46/atlassian-mcp',
    auth: 'env',
    tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    tokenHint: 'Create API token at id.atlassian.com → Security → API tokens',
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    description: 'Manage tasks, docs, and projects in ClickUp',
    category: 'productivity',
    icon: '🟣',
    logo: 'clickup',
    transport: 'http',
    url: 'https://mcp.clickup.com/mcp',
    envKeys: [],
    tags: ['tasks', 'project-management', 'docs'],
    official: true,
    docsUrl: 'https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1',
    auth: 'oauth',
    tokenUrl: 'https://app.clickup.com/settings/apps',
    tokenHint: 'Settings → Apps → Generate API Token',
  },
  {
    id: 'monday',
    name: 'Monday.com',
    description: 'Manage boards, items, and workflows on Monday.com',
    category: 'productivity',
    icon: '🟡',
    logo: 'mondaydotcom',
    transport: 'http',
    url: 'https://mcp.monday.com/mcp',
    envKeys: [],
    tags: ['project-management', 'boards', 'workflows'],
    official: true,
    docsUrl: 'https://monday.com/developers/apps',
    auth: 'oauth',
    tokenUrl: 'https://monday.com/developers/apps',
    tokenHint: 'Developers → My Access Tokens',
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    description: 'Drive, Gmail, Calendar, Docs, Sheets, Slides, Forms, Tasks, Chat, Contacts',
    category: 'productivity',
    icon: '📂',
    logo: 'googledrive',
    transport: 'stdio',
    command: 'uvx',
    args: ['workspace-mcp', '--tool-tier', 'core'],
    envKeys: [
      { key: 'GOOGLE_OAUTH_CLIENT_ID', label: 'OAuth Client ID', required: true, placeholder: 'xxxxx.apps.googleusercontent.com' },
      { key: 'GOOGLE_OAUTH_CLIENT_SECRET', label: 'OAuth Client Secret', required: true, placeholder: 'GOCSPX-...' },
      { key: 'OAUTHLIB_INSECURE_TRANSPORT', label: 'Insecure Transport (dev only)', required: false, placeholder: '1' },
    ],
    tags: ['google', 'drive', 'gmail', 'calendar', 'docs', 'sheets', 'workspace'],
    official: false,
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    auth: 'env',
    tokenUrl: 'https://console.cloud.google.com/apis/credentials',
    tokenHint: '1. Google Cloud Console → Create OAuth 2.0 Client ID (Desktop app type) 2. Enable APIs: Drive, Gmail, Calendar, Docs, Sheets 3. Set OAUTHLIB_INSECURE_TRANSPORT=1 for local dev',
  },
  {
    id: 'box',
    name: 'Box',
    description: 'Interact with Box content management via Box AI',
    category: 'productivity',
    icon: '📦',
    logo: 'box',
    transport: 'http',
    url: 'https://mcp.box.com/mcp',
    envKeys: [],
    tags: ['files', 'content-management', 'storage'],
    official: true,
    docsUrl: 'https://developer.box.com/guides/mcp/',
    auth: 'oauth',
    tokenUrl: 'https://app.box.com/developers/console',
    tokenHint: 'Developer Console → Generate Developer Token',
  },

  // ─── Communication ────────────────────────────────────────────────────────

  {
    id: 'slack',
    name: 'Slack',
    description: 'Read/send messages, search history, manage channels and threads',
    category: 'communication',
    icon: '💬',
    logo: 'slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envKeys: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack Bot Token', required: true, placeholder: 'xoxb-...' },
      { key: 'SLACK_TEAM_ID', label: 'Slack Team/Workspace ID', required: true, placeholder: 'T...' },
      { key: 'SLACK_CHANNEL_IDS', label: 'Allowed Channel IDs (comma-separated)', required: false, placeholder: 'C01234,C05678' },
    ],
    tags: ['messaging', 'channels', 'chat', 'team'],
    official: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    auth: 'env',
  },

  // ─── Data ─────────────────────────────────────────────────────────────────

  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query databases, inspect schemas (read-only)',
    category: 'data',
    icon: '🐘',
    logo: 'postgresql',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    envKeys: [
      { key: 'DATABASE_URL', label: 'PostgreSQL Connection String', required: true, placeholder: 'postgresql://user:pass@host:5432/db' },
    ],
    tags: ['database', 'sql', 'schema', 'queries'],
    official: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    auth: 'env',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and analyze local SQLite databases',
    category: 'data',
    icon: '🗃️',
    logo: 'sqlite',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite'],
    envKeys: [
      { key: 'SQLITE_PATH', label: 'SQLite Database File Path', required: true, placeholder: '/path/to/database.db' },
    ],
    tags: ['database', 'sql', 'local'],
    official: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    auth: 'none',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Query Postgres, manage edge functions, inspect schemas',
    category: 'data',
    icon: '⚡',
    logo: 'supabase',
    transport: 'http',
    url: 'https://mcp.supabase.com/mcp',
    envKeys: [],
    tags: ['database', 'postgres', 'edge-functions', 'auth'],
    official: true,
    docsUrl: 'https://supabase.com/docs/guides/getting-started/byo-mcp',
    auth: 'oauth',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    tokenHint: 'Account → Access Tokens → Generate',
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    description: 'Query collections, inspect schemas, manage documents',
    category: 'data',
    icon: '🍃',
    logo: 'mongodb',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mongodb-mcp-server'],
    envKeys: [
      { key: 'MDB_MCP_CONNECTION_STRING', label: 'MongoDB Connection String', required: true, placeholder: 'mongodb://localhost:27017/mydb' },
    ],
    tags: ['database', 'nosql', 'documents'],
    official: false,
    docsUrl: 'https://github.com/mongodb-js/mongodb-mcp-server',
    auth: 'env',
  },
  {
    id: 'redis',
    name: 'Redis',
    description: 'Query keys, manage data structures, inspect Redis',
    category: 'data',
    icon: '🔴',
    logo: 'redis',
    transport: 'stdio',
    command: 'uvx',
    args: ['--from', 'redis-mcp-server@latest', 'redis-mcp-server'],
    envKeys: [
      { key: 'REDIS_URL', label: 'Redis Connection URL', required: true, placeholder: 'redis://localhost:6379' },
    ],
    tags: ['cache', 'key-value', 'pubsub'],
    official: true,
    docsUrl: 'https://github.com/redis/mcp-redis',
    auth: 'env',
    tokenHint: 'Redis-official MCP. Requires uvx (uv tool). Pass --url via REDIS_URL env var.',
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'Query MySQL databases and inspect schemas',
    category: 'data',
    icon: '🐬',
    logo: 'mysql',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@benborla29/mcp-server-mysql'],
    envKeys: [
      { key: 'MYSQL_HOST', label: 'MySQL Host', required: true, placeholder: 'localhost' },
      { key: 'MYSQL_USER', label: 'MySQL User', required: true },
      { key: 'MYSQL_PASSWORD', label: 'MySQL Password', required: true },
      { key: 'MYSQL_DATABASE', label: 'MySQL Database', required: true },
    ],
    tags: ['database', 'sql'],
    official: false,
    docsUrl: 'https://github.com/benborla29/mcp-server-mysql',
    auth: 'env',
  },

  // ─── Design ───────────────────────────────────────────────────────────────

  {
    id: 'figma',
    name: 'Figma',
    description: 'Read designs, components, styles, and layout information',
    category: 'design',
    icon: '🎨',
    logo: 'figma',
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
    envKeys: [],
    tags: ['design', 'ui', 'components', 'layouts'],
    official: true,
    docsUrl: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
    auth: 'oauth',
    tokenUrl: 'https://www.figma.com/developers',
    tokenHint: 'Create a Figma app → get OAuth credentials, or use the Figma MCP plugin in Claude Code first',
  },

  // ─── Cloud & Infrastructure ───────────────────────────────────────────────

  {
    id: 'aws',
    name: 'AWS',
    description: 'Manage S3, Lambda, EC2, CloudWatch, and other AWS services',
    category: 'cloud',
    icon: '☁️',
    logo: 'amazonaws',
    transport: 'stdio',
    command: 'uvx',
    args: ['awslabs.aws-api-mcp-server@latest'],
    envKeys: [
      { key: 'AWS_ACCESS_KEY_ID', label: 'AWS Access Key ID', required: true },
      { key: 'AWS_SECRET_ACCESS_KEY', label: 'AWS Secret Access Key', required: true },
      { key: 'AWS_REGION', label: 'AWS Region', required: false, placeholder: 'us-east-1' },
    ],
    tags: ['aws', 's3', 'lambda', 'ec2', 'cloud'],
    official: true,
    docsUrl: 'https://github.com/awslabs/mcp',
    auth: 'env',
    tokenHint: 'Requires uvx (uv tool). AWS Labs official MCP — covers all AWS APIs.',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Manage deployments, projects, and serverless functions',
    category: 'cloud',
    icon: '▲',
    logo: 'vercel',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@vercel/mcp-adapter'],
    envKeys: [
      { key: 'VERCEL_TOKEN', label: 'Vercel Access Token', required: true },
    ],
    tags: ['deployment', 'serverless', 'hosting'],
    official: true,
    docsUrl: 'https://vercel.com/docs/mcp',
    auth: 'env',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Manage Workers, KV, R2, D1, and DNS',
    category: 'cloud',
    icon: '🟠',
    logo: 'cloudflare',
    transport: 'http',
    url: 'https://mcp.cloudflare.com/mcp',
    envKeys: [],
    tags: ['cdn', 'workers', 'dns', 'edge'],
    official: true,
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    auth: 'oauth',
    tokenHint: 'Cloudflare-hosted MCP. OAuth flow handles auth — no API token needed.',
  },
  {
    id: 'docker',
    name: 'Docker',
    description: 'Manage containers, images, volumes, and networks',
    category: 'cloud',
    icon: '🐳',
    logo: 'docker',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'docker-mcp-server'],
    envKeys: [],
    tags: ['containers', 'images', 'docker-compose'],
    official: false,
    docsUrl: 'https://github.com/ckreiling/mcp-server-docker',
    auth: 'none',
  },

  // ─── Analytics & Monitoring ───────────────────────────────────────────────

  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Query error tracking, issues, and performance data',
    category: 'analytics',
    icon: '🐛',
    logo: 'sentry',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server'],
    envKeys: [
      { key: 'SENTRY_AUTH_TOKEN', label: 'Sentry Auth Token', required: true },
      { key: 'SENTRY_HOST', label: 'Sentry Host', required: false, placeholder: 'sentry.io' },
    ],
    tags: ['errors', 'monitoring', 'performance', 'debugging'],
    official: true,
    docsUrl: 'https://github.com/getsentry/sentry-mcp',
    auth: 'env',
    tokenUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    tokenHint: 'Sentry official MCP — create token with org:read, project:read, event:read scopes',
  },
  {
    id: 'datadog',
    name: 'Datadog',
    description: 'Query metrics, logs, traces, and monitors',
    category: 'analytics',
    icon: '🐕',
    logo: 'datadog',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'datadog-mcp'],
    envKeys: [
      { key: 'DD_API_KEY', label: 'Datadog API Key', required: true },
      { key: 'DD_APP_KEY', label: 'Datadog Application Key', required: true },
      { key: 'DD_SITE', label: 'Datadog Site', required: false, placeholder: 'datadoghq.com' },
    ],
    tags: ['metrics', 'logs', 'apm', 'monitoring'],
    official: false,
    docsUrl: 'https://github.com/TANTIOPE/datadog-mcp-server',
    auth: 'env',
    tokenUrl: 'https://app.datadoghq.com/organization-settings/api-keys',
  },
  {
    id: 'amplitude',
    name: 'Amplitude',
    description: 'Query product analytics, events, and user behavior',
    category: 'analytics',
    icon: '📊',
    logo: 'amplitude',
    transport: 'http',
    url: 'https://mcp.amplitude.com/mcp',
    envKeys: [],
    tags: ['analytics', 'events', 'product', 'metrics'],
    official: true,
    docsUrl: 'https://www.docs.developers.amplitude.com/mcp/',
    auth: 'oauth',
    tokenUrl: 'https://analytics.amplitude.com/settings/profile',
    tokenHint: 'Settings → API Keys',
  },

  // ─── Search ───────────────────────────────────────────────────────────────

  {
    id: 'google-search',
    name: 'Google Search',
    description: 'Web search via Google Custom Search API',
    category: 'search',
    icon: '🔎',
    logo: 'google',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-google-search'],
    envKeys: [
      { key: 'GOOGLE_API_KEY', label: 'Google API Key', required: true, placeholder: 'AIzaSy...' },
      { key: 'GOOGLE_CX', label: 'Custom Search Engine ID', required: true, placeholder: 'cx ID from cse.google.com' },
    ],
    tags: ['search', 'web', 'google'],
    official: false,
    docsUrl: 'https://www.npmjs.com/package/mcp-google-search',
    auth: 'env',
    tokenUrl: 'https://console.cloud.google.com/apis/credentials',
    tokenHint: '1. Enable Custom Search API in Google Cloud Console 2. Create API key 3. Create Programmable Search Engine at cse.google.com → get cx ID',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web search and local business search via Brave',
    category: 'search',
    icon: '🦁',
    logo: 'brave',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envKeys: [
      { key: 'BRAVE_API_KEY', label: 'Brave Search API Key', required: true },
    ],
    tags: ['search', 'web', 'local'],
    official: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    auth: 'env',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    description: 'AI-optimized search and research engine',
    category: 'search',
    icon: '🔍',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'tavily-mcp'],
    envKeys: [
      { key: 'TAVILY_API_KEY', label: 'Tavily API Key', required: true },
    ],
    tags: ['search', 'research', 'ai-search'],
    official: true,
    docsUrl: 'https://github.com/tavily-ai/tavily-mcp',
    auth: 'env',
    tokenUrl: 'https://app.tavily.com/home',
  },
  {
    id: 'exa',
    name: 'Exa',
    description: 'Neural search engine for finding relevant content',
    category: 'search',
    icon: '🧠',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'exa-mcp-server'],
    envKeys: [
      { key: 'EXA_API_KEY', label: 'Exa API Key', required: true },
    ],
    tags: ['search', 'neural', 'semantic'],
    official: false,
    docsUrl: 'https://docs.exa.ai/reference/mcp',
    auth: 'env',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Retrieve and convert web content for LLM usage',
    category: 'search',
    icon: '🌐',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@mokei/mcp-fetch'],
    envKeys: [],
    tags: ['web', 'scraping', 'content', 'html'],
    official: false,
    docsUrl: 'https://github.com/mokei-jp/mcp-fetch',
    auth: 'none',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    description: 'Web scraping and crawling with clean Markdown output',
    category: 'search',
    icon: '🔥',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'firecrawl-mcp'],
    envKeys: [
      { key: 'FIRECRAWL_API_KEY', label: 'Firecrawl API Key', required: true },
    ],
    tags: ['scraping', 'crawling', 'markdown'],
    official: false,
    docsUrl: 'https://docs.firecrawl.dev/mcp',
    auth: 'env',
  },

  // ─── Automation ───────────────────────────────────────────────────────────

  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation for testing and web interaction',
    category: 'automation',
    icon: '🎭',
    logo: 'playwright',
    transport: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    envKeys: [],
    tags: ['browser', 'testing', 'automation', 'e2e'],
    official: true,
    docsUrl: 'https://playwright.dev/docs/mcp',
    auth: 'none',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Browser automation, screenshots, and DOM interaction',
    category: 'automation',
    icon: '🤖',
    logo: 'puppeteer',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    envKeys: [],
    tags: ['browser', 'screenshots', 'automation'],
    official: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
    auth: 'none',
  },
  {
    id: 'zapier',
    name: 'Zapier',
    description: 'Automate 8,000+ app integrations via Zapier actions',
    category: 'automation',
    icon: '⚡',
    logo: 'zapier',
    transport: 'http',
    url: 'https://actions.zapier.com/mcp/',
    envKeys: [],
    tags: ['automation', 'integrations', 'workflows', 'zaps'],
    official: true,
    docsUrl: 'https://zapier.com/mcp',
    auth: 'oauth',
    tokenUrl: 'https://zapier.com/mcp',
    tokenHint: 'MCP Setup page → Get server ID',
  },
  {
    id: 'apify',
    name: 'Apify',
    description: 'Extract data from websites, e-commerce, and social media',
    category: 'automation',
    icon: '🕷️',
    logo: 'apify',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@apify/actors-mcp-server'],
    envKeys: [
      { key: 'APIFY_TOKEN', label: 'Apify API Token', required: true },
    ],
    tags: ['scraping', 'data-extraction', 'crawling'],
    official: true,
    docsUrl: 'https://docs.apify.com/platform/integrations/mcp',
    auth: 'env',
  },

  // ─── Finance ──────────────────────────────────────────────────────────────

  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Manage payments, customers, subscriptions, and invoices',
    category: 'finance',
    icon: '💳',
    logo: 'stripe',
    transport: 'http',
    url: 'https://mcp.stripe.com',
    envKeys: [],
    tags: ['payments', 'billing', 'subscriptions', 'invoices'],
    official: true,
    docsUrl: 'https://docs.stripe.com/mcp',
    auth: 'oauth',
    tokenUrl: 'https://dashboard.stripe.com/apikeys',
    tokenHint: 'Dashboard → API Keys → Secret key (sk_...)',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    description: 'Manage PayPal payments, orders, and transactions',
    category: 'finance',
    icon: '💰',
    logo: 'paypal',
    transport: 'http',
    url: 'https://mcp.paypal.com/http',
    envKeys: [],
    tags: ['payments', 'orders', 'transactions'],
    official: true,
    docsUrl: 'https://docs.paypal.ai/developer/tools/ai/mcp-quickstart',
    auth: 'oauth',
    tokenUrl: 'https://developer.paypal.com/dashboard/applications',
    tokenHint: 'Developer Dashboard → REST API apps → Client ID & Secret',
  },

  // ─── CRM & Sales ─────────────────────────────────────────────────────────

  {
    id: 'salesforce',
    name: 'Salesforce',
    description: 'Query and manage Salesforce CRM data, leads, and reports',
    category: 'productivity',
    icon: '☁️',
    logo: 'salesforce',
    transport: 'http',
    url: 'https://mcp.salesforce.com/mcp',
    envKeys: [],
    tags: ['crm', 'sales', 'leads', 'reports'],
    official: true,
    docsUrl: 'https://developer.salesforce.com/docs/einstein/genai/guide/mcp.html',
    auth: 'oauth',
    tokenUrl: 'https://login.salesforce.com/',
    tokenHint: 'Setup → Apps → Connected Apps → get access token',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Manage contacts, deals, tickets, and marketing in HubSpot',
    category: 'productivity',
    icon: '🟧',
    logo: 'hubspot',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'hubspot-mcp'],
    envKeys: [
      { key: 'HUBSPOT_ACCESS_TOKEN', label: 'HubSpot Private App Token', required: true },
    ],
    tags: ['crm', 'marketing', 'sales', 'contacts'],
    official: false,
    docsUrl: 'https://github.com/yespark/hubspot-mcp',
    auth: 'env',
    tokenUrl: 'https://app.hubspot.com/private-apps',
    tokenHint: 'HubSpot → Settings → Integrations → Private Apps → create app',
  },

  // ─── AI & Knowledge ───────────────────────────────────────────────────────

  {
    id: 'memory',
    name: 'Memory (Knowledge Graph)',
    description: 'Persistent knowledge graph for storing entities and relationships',
    category: 'ai',
    icon: '🧠',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    envKeys: [
      { key: 'MEMORY_FILE_PATH', label: 'Memory Storage File Path', required: false, placeholder: '/path/to/memory.json (optional — uses default if empty)' },
    ],
    tags: ['memory', 'knowledge-graph', 'persistence'],
    official: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    auth: 'none',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured reasoning framework for complex problem-solving',
    category: 'ai',
    icon: '💭',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envKeys: [],
    tags: ['reasoning', 'thinking', 'problem-solving'],
    official: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    auth: 'none',
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    description: 'Text-to-speech generation with realistic AI voices',
    category: 'ai',
    icon: '🔊',
    logo: 'elevenlabs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@angelogiacco/elevenlabs-mcp-server'],
    envKeys: [
      { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API Key', required: true },
    ],
    tags: ['tts', 'voice', 'audio', 'speech'],
    official: false,
    docsUrl: 'https://github.com/angelogiacco/elevenlabs-mcp-server',
    auth: 'env',
    tokenUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },

  // ─── SEO & Marketing ─────────────────────────────────────────────────────

  {
    id: 'ahrefs',
    name: 'Ahrefs',
    description: 'SEO analytics, backlinks, keyword research, and site audits',
    category: 'analytics',
    icon: '📈',
    logo: 'ahrefs',
    transport: 'http',
    url: 'https://api.ahrefs.com/mcp/mcp',
    envKeys: [],
    tags: ['seo', 'backlinks', 'keywords', 'analytics'],
    official: true,
    docsUrl: 'https://ahrefs.com/api',
    auth: 'oauth',
    tokenUrl: 'https://app.ahrefs.com/user/api',
    tokenHint: 'Account → API → Generate token',
  },
  {
    id: 'semrush',
    name: 'Semrush',
    description: 'SEO, competitive analysis, and marketing insights',
    category: 'analytics',
    icon: '🔎',
    logo: 'semrush',
    transport: 'http',
    url: 'https://mcp.semrush.com/v1/mcp',
    envKeys: [],
    tags: ['seo', 'marketing', 'competitive-analysis'],
    official: true,
    docsUrl: 'https://www.semrush.com/api-analytics/',
    auth: 'oauth',
    tokenUrl: 'https://www.semrush.com/api-analytics/',
    tokenHint: 'API Analytics → Get API key',
  },

  // ─── E-Commerce ───────────────────────────────────────────────────────────

  {
    id: 'shopify',
    name: 'Shopify',
    description: 'Manage products, orders, customers, inventory, metafields via Shopify Admin API',
    category: 'finance',
    icon: '🛍️',
    logo: 'shopify',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'shopify-mcp'],
    envKeys: [
      { key: 'SHOPIFY_CLIENT_ID', label: 'Client ID (Dev Dashboard app)', required: false, placeholder: 'For OAuth — recommended' },
      { key: 'SHOPIFY_CLIENT_SECRET', label: 'Client Secret', required: false, placeholder: 'Required if using Client ID' },
      { key: 'SHOPIFY_ACCESS_TOKEN', label: 'Admin API Token (legacy)', required: false, placeholder: 'shpat_... — alternative to OAuth' },
      { key: 'MYSHOPIFY_DOMAIN', label: 'Store Domain', required: true, placeholder: 'mystore.myshopify.com' },
    ],
    tags: ['ecommerce', 'products', 'orders', 'customers', 'inventory'],
    official: false,
    docsUrl: 'https://github.com/GeLi2001/shopify-mcp',
    auth: 'env',
    tokenUrl: 'https://shopify.dev/docs/apps/auth/get-access-tokens',
    tokenHint: 'Either OAuth (Client ID + Secret from Dev Dashboard) or legacy Admin API token. Domain always required.',
  },

  // ─── Misc Utilities ───────────────────────────────────────────────────────

  {
    id: 'time',
    name: 'Time',
    description: 'Time and timezone conversion utilities',
    category: 'ai',
    icon: '⏰',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'time-mcp'],
    envKeys: [],
    tags: ['time', 'timezone', 'conversion'],
    official: false,
    docsUrl: 'https://www.npmjs.com/package/time-mcp',
    auth: 'none',
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    description: 'Geocoding, places, routing, elevation, timezone via Google Maps Platform APIs',
    category: 'search',
    icon: '🗺️',
    logo: 'googlemaps',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'google-maps-mcp-server'],
    envKeys: [
      { key: 'GOOGLE_MAPS_API_KEY', label: 'Google Maps API Key', required: true, placeholder: 'AIzaSy...' },
    ],
    tags: ['maps', 'geocoding', 'directions', 'places', 'routing'],
    official: false,
    docsUrl: 'https://github.com/david-pivonka/google-maps-mcp-server',
    auth: 'env',
    tokenUrl: 'https://console.cloud.google.com/apis/credentials',
    tokenHint: 'Google Cloud Console → Enable Maps APIs (Places API New, Routes API, Geocoding API) → Create API Key',
  },
  {
    id: 'hex',
    name: 'Hex',
    description: 'Run data notebooks, SQL queries, and Python analysis',
    category: 'data',
    icon: '🔮',
    transport: 'http',
    url: 'https://mcp.hex.tech/mcp',
    envKeys: [],
    tags: ['data', 'notebooks', 'sql', 'python', 'analytics'],
    official: true,
    docsUrl: 'https://learn.hex.tech/docs/develop-logic/hex-api',
    auth: 'oauth',
    tokenUrl: 'https://app.hex.tech/settings/tokens',
    tokenHint: 'Settings → API Tokens → Create',
  },
  {
    id: 'clay',
    name: 'Clay',
    description: 'Enrich contacts and automate data workflows',
    category: 'automation',
    icon: '🧱',
    transport: 'http',
    url: 'https://mcp.clay.com/mcp',
    envKeys: [],
    tags: ['enrichment', 'contacts', 'data', 'automation'],
    official: true,
    docsUrl: 'https://clay.com/university',
    auth: 'oauth',
    tokenUrl: 'https://app.clay.com/settings',
    tokenHint: 'Settings → API → Generate key',
  },
];

// =============================================================================
// Helpers
// =============================================================================

/** Category display names and descriptions. */
export const MCP_CATEGORIES: Record<McpCategory, { label: string; description: string }> = {
  developer: { label: 'Developer Tools', description: 'Git, GitHub, GitLab, code tools' },
  productivity: { label: 'Productivity', description: 'Notion, Linear, Jira, Asana, project management' },
  data: { label: 'Databases', description: 'PostgreSQL, MySQL, SQLite, MongoDB, Redis' },
  cloud: { label: 'Cloud & Infra', description: 'AWS, Vercel, Cloudflare, Docker' },
  design: { label: 'Design', description: 'Figma, Canva, design tools' },
  analytics: { label: 'Analytics & Monitoring', description: 'Sentry, Datadog, Amplitude, SEO' },
  search: { label: 'Search & Web', description: 'Brave Search, Fetch, web scraping' },
  automation: { label: 'Automation', description: 'Playwright, Zapier, browser automation' },
  finance: { label: 'Finance & Commerce', description: 'Stripe, PayPal, Shopify' },
  ai: { label: 'AI & Knowledge', description: 'Memory, reasoning, text-to-speech' },
  communication: { label: 'Communication', description: 'Slack, email, messaging' },
};

/** Returns templates filtered by category. */
export function getTemplatesByCategory(category: McpCategory): McpTemplate[] {
  return MCP_TEMPLATES.filter((t) => t.category === category);
}

/** Returns a template by ID, or undefined if not found. */
export function getTemplateById(id: string): McpTemplate | undefined {
  return MCP_TEMPLATES.find((t) => t.id === id);
}

/** Search templates by name, description, or tags. */
export function searchTemplates(query: string): McpTemplate[] {
  const q = query.toLowerCase();
  return MCP_TEMPLATES.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.includes(q))
  );
}
