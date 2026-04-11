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
      { key: 'GITHUB_TOKEN', label: 'GitHub Personal Access Token', required: true, placeholder: 'ghp_...' },
    ],
    tags: ['git', 'code', 'pr', 'issues', 'repository'],
    official: true,
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
    envKeys: [],
    tags: ['git', 'version-control', 'commits', 'branches'],
    official: true,
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
    envKeys: [
      { key: 'POSTMAN_API_KEY', label: 'Postman API Key', required: true, placeholder: 'PMAK-...' },
    ],
    tags: ['api', 'testing', 'http', 'collections'],
    official: true,
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
    envKeys: [
      { key: 'NOTION_API_KEY', label: 'Notion Integration Token', required: true, placeholder: 'ntn_...' },
    ],
    tags: ['wiki', 'docs', 'database', 'workspace'],
    official: true,
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
    envKeys: [
      { key: 'LINEAR_API_KEY', label: 'Linear API Key', required: true, placeholder: 'lin_api_...' },
    ],
    tags: ['issues', 'project-management', 'sprints', 'bugs'],
    official: true,
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
    envKeys: [
      { key: 'ASANA_ACCESS_TOKEN', label: 'Asana Personal Access Token', required: true },
    ],
    tags: ['tasks', 'project-management', 'teams'],
    official: true,
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
    args: ['-y', '@anthropic-ai/atlassian-mcp-server'],
    envKeys: [
      { key: 'ATLASSIAN_SITE_URL', label: 'Atlassian Site URL', required: true, placeholder: 'https://yoursite.atlassian.net' },
      { key: 'ATLASSIAN_USER_EMAIL', label: 'Atlassian Email', required: true, placeholder: 'you@company.com' },
      { key: 'ATLASSIAN_API_TOKEN', label: 'Atlassian API Token', required: true },
    ],
    tags: ['jira', 'confluence', 'tickets', 'wiki', 'project-management'],
    official: true,
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
    envKeys: [
      { key: 'CLICKUP_API_TOKEN', label: 'ClickUp API Token', required: true },
    ],
    tags: ['tasks', 'project-management', 'docs'],
    official: true,
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
    envKeys: [
      { key: 'MONDAY_API_TOKEN', label: 'Monday.com API Token', required: true },
    ],
    tags: ['project-management', 'boards', 'workflows'],
    official: true,
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Search and access files in Google Drive',
    category: 'productivity',
    icon: '📂',
    logo: 'googledrive',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
    envKeys: [
      { key: 'GOOGLE_CLIENT_ID', label: 'Google OAuth Client ID', required: true },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'Google OAuth Client Secret', required: true },
    ],
    tags: ['google', 'drive', 'files', 'docs', 'sheets'],
    official: true,
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
    envKeys: [
      { key: 'BOX_ACCESS_TOKEN', label: 'Box Developer Token', required: true },
    ],
    tags: ['files', 'content-management', 'storage'],
    official: true,
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
    ],
    tags: ['messaging', 'channels', 'chat', 'team'],
    official: true,
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
    envKeys: [
      { key: 'SUPABASE_ACCESS_TOKEN', label: 'Supabase Access Token', required: true },
    ],
    tags: ['database', 'postgres', 'edge-functions', 'auth'],
    official: true,
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
      { key: 'MONGODB_URI', label: 'MongoDB Connection String', required: true, placeholder: 'mongodb://localhost:27017/mydb' },
    ],
    tags: ['database', 'nosql', 'documents'],
    official: false,
  },
  {
    id: 'redis',
    name: 'Redis',
    description: 'Query keys, manage data structures, inspect Redis',
    category: 'data',
    icon: '🔴',
    logo: 'redis',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'redis-mcp-server'],
    envKeys: [
      { key: 'REDIS_URL', label: 'Redis Connection URL', required: true, placeholder: 'redis://localhost:6379' },
    ],
    tags: ['cache', 'key-value', 'pubsub'],
    official: false,
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
    envKeys: [
      { key: 'FIGMA_ACCESS_TOKEN', label: 'Figma Personal Access Token', required: true },
    ],
    tags: ['design', 'ui', 'components', 'layouts'],
    official: true,
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
    command: 'npx',
    args: ['-y', '@anthropic-ai/aws-mcp-server'],
    envKeys: [
      { key: 'AWS_ACCESS_KEY_ID', label: 'AWS Access Key ID', required: true },
      { key: 'AWS_SECRET_ACCESS_KEY', label: 'AWS Secret Access Key', required: true },
      { key: 'AWS_REGION', label: 'AWS Region', required: false, placeholder: 'us-east-1' },
    ],
    tags: ['aws', 's3', 'lambda', 'ec2', 'cloud'],
    official: true,
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
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Manage Workers, KV, R2, D1, and DNS',
    category: 'cloud',
    icon: '🟠',
    logo: 'cloudflare',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic-ai/cloudflare-mcp-server'],
    envKeys: [
      { key: 'CLOUDFLARE_API_TOKEN', label: 'Cloudflare API Token', required: true },
      { key: 'CLOUDFLARE_ACCOUNT_ID', label: 'Cloudflare Account ID', required: true },
    ],
    tags: ['cdn', 'workers', 'dns', 'edge'],
    official: true,
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
    args: ['-y', '@modelcontextprotocol/server-sentry'],
    envKeys: [
      { key: 'SENTRY_AUTH_TOKEN', label: 'Sentry Auth Token', required: true },
      { key: 'SENTRY_ORG', label: 'Sentry Organization Slug', required: true },
    ],
    tags: ['errors', 'monitoring', 'performance', 'debugging'],
    official: true,
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
    args: ['-y', '@anthropic-ai/datadog-mcp-server'],
    envKeys: [
      { key: 'DD_API_KEY', label: 'Datadog API Key', required: true },
      { key: 'DD_APP_KEY', label: 'Datadog Application Key', required: true },
      { key: 'DD_SITE', label: 'Datadog Site', required: false, placeholder: 'datadoghq.com' },
    ],
    tags: ['metrics', 'logs', 'apm', 'monitoring'],
    official: true,
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
    envKeys: [
      { key: 'AMPLITUDE_API_KEY', label: 'Amplitude API Key', required: true },
    ],
    tags: ['analytics', 'events', 'product', 'metrics'],
    official: true,
  },

  // ─── Search ───────────────────────────────────────────────────────────────

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
  },
  {
    id: 'tavily',
    name: 'Tavily',
    description: 'AI-optimized search and research engine',
    category: 'search',
    icon: '🔍',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'tavily-mcp-server'],
    envKeys: [
      { key: 'TAVILY_API_KEY', label: 'Tavily API Key', required: true },
    ],
    tags: ['search', 'research', 'ai-search'],
    official: false,
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
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Retrieve and convert web content for LLM usage',
    category: 'search',
    icon: '🌐',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    envKeys: [],
    tags: ['web', 'scraping', 'content', 'html'],
    official: true,
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
    envKeys: [
      { key: 'ZAPIER_MCP_SERVER_ID', label: 'Zapier MCP Server ID (from zapier.com/mcp)', required: true },
    ],
    tags: ['automation', 'integrations', 'workflows', 'zaps'],
    official: true,
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
    args: ['-y', '@apify/mcp'],
    envKeys: [
      { key: 'APIFY_TOKEN', label: 'Apify API Token', required: true },
    ],
    tags: ['scraping', 'data-extraction', 'crawling'],
    official: true,
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
    envKeys: [
      { key: 'STRIPE_SECRET_KEY', label: 'Stripe Secret Key', required: true, placeholder: 'sk_...' },
    ],
    tags: ['payments', 'billing', 'subscriptions', 'invoices'],
    official: true,
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
    envKeys: [
      { key: 'PAYPAL_CLIENT_ID', label: 'PayPal Client ID', required: true },
      { key: 'PAYPAL_CLIENT_SECRET', label: 'PayPal Client Secret', required: true },
    ],
    tags: ['payments', 'orders', 'transactions'],
    official: true,
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
    envKeys: [
      { key: 'SALESFORCE_ACCESS_TOKEN', label: 'Salesforce Access Token', required: true },
    ],
    tags: ['crm', 'sales', 'leads', 'reports'],
    official: true,
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
    args: ['-y', '@anthropic-ai/hubspot-mcp-server'],
    envKeys: [
      { key: 'HUBSPOT_ACCESS_TOKEN', label: 'HubSpot Private App Token', required: true },
    ],
    tags: ['crm', 'marketing', 'sales', 'contacts'],
    official: false,
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
    envKeys: [],
    tags: ['memory', 'knowledge-graph', 'persistence'],
    official: true,
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
    args: ['-y', '@anthropic-ai/elevenlabs-mcp-server'],
    envKeys: [
      { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API Key', required: true },
    ],
    tags: ['tts', 'voice', 'audio', 'speech'],
    official: true,
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
    envKeys: [
      { key: 'AHREFS_API_KEY', label: 'Ahrefs API Key', required: true },
    ],
    tags: ['seo', 'backlinks', 'keywords', 'analytics'],
    official: true,
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
    envKeys: [
      { key: 'SEMRUSH_API_KEY', label: 'Semrush API Key', required: true },
    ],
    tags: ['seo', 'marketing', 'competitive-analysis'],
    official: true,
  },

  // ─── E-Commerce ───────────────────────────────────────────────────────────

  {
    id: 'shopify',
    name: 'Shopify',
    description: 'Manage products, orders, customers, and store configuration',
    category: 'finance',
    icon: '🛍️',
    logo: 'shopify',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic-ai/shopify-mcp-server'],
    envKeys: [
      { key: 'SHOPIFY_ACCESS_TOKEN', label: 'Shopify Admin API Token', required: true },
      { key: 'SHOPIFY_STORE_URL', label: 'Shopify Store URL', required: true, placeholder: 'mystore.myshopify.com' },
    ],
    tags: ['ecommerce', 'products', 'orders', 'store'],
    official: false,
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
    args: ['-y', '@modelcontextprotocol/server-time'],
    envKeys: [],
    tags: ['time', 'timezone', 'conversion'],
    official: true,
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    description: 'Geocoding, directions, place search, and distance calculations',
    category: 'search',
    icon: '🗺️',
    logo: 'googlemaps',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    envKeys: [
      { key: 'GOOGLE_MAPS_API_KEY', label: 'Google Maps API Key', required: true },
    ],
    tags: ['maps', 'geocoding', 'directions', 'places'],
    official: true,
  },
  {
    id: 'hex',
    name: 'Hex',
    description: 'Run data notebooks, SQL queries, and Python analysis',
    category: 'data',
    icon: '🔮',
    transport: 'http',
    url: 'https://mcp.hex.tech/mcp',
    envKeys: [
      { key: 'HEX_API_TOKEN', label: 'Hex API Token', required: true },
    ],
    tags: ['data', 'notebooks', 'sql', 'python', 'analytics'],
    official: true,
  },
  {
    id: 'clay',
    name: 'Clay',
    description: 'Enrich contacts and automate data workflows',
    category: 'automation',
    icon: '🧱',
    transport: 'http',
    url: 'https://mcp.clay.com/mcp',
    envKeys: [
      { key: 'CLAY_API_KEY', label: 'Clay API Key', required: true },
    ],
    tags: ['enrichment', 'contacts', 'data', 'automation'],
    official: true,
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
