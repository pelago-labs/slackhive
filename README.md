<div align="center">

<img src="apps/web/public/logo.svg" alt="SlackHive" width="80" />

# SlackHive

### Build, deploy, and orchestrate teams of Claude Code AI agents on Slack

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ed?logo=docker&logoColor=white)](https://docs.docker.com/compose)
[![Claude Code SDK](https://img.shields.io/badge/Claude_Code-SDK-cc785c?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/agent-sdk)
[![Slack](https://img.shields.io/badge/Slack-Bolt-4A154B?logo=slack&logoColor=white)](https://api.slack.com/bolt)

[Quick Start](#-quick-start) · [Features](#-features) · [Architecture](#-architecture) · [Documentation](#-creating-your-first-agent) · [Contributing](#-contributing)

</div>

---

## Why SlackHive?

Most AI agent frameworks focus on a single agent doing a single task. But real teams have **specialists** — a data analyst who speaks SQL, a writer who crafts announcements, an engineer who reviews code. What if your AI team worked the same way?

**SlackHive** was born from a simple observation: the most powerful AI setup isn't one omniscient agent — it's a **team of specialists** that learn and improve from every interaction.

Inspired by how engineering teams actually collaborate in Slack, we built a platform where:

- **Each agent is a Slack bot** with its own identity, skills, and memory
- **A Boss Agent** knows the entire team and delegates work by @mentioning the right specialist
- **Every agent learns** — memories from conversations are persisted and loaded on the next start
- **Everything is configurable** from a clean web UI — no code changes needed to add agents, assign tools, or edit behavior

Whether you're building an internal AI ops team, a customer support squad, or a research group — SlackHive gives you the infrastructure to make it happen.

<details>
<summary><b>See it in action</b></summary>

```
User:     @boss can you analyze last week's conversion funnel?
Boss:     That's right up @data-analyst's alley. Let me loop them in 👇
          @data-analyst — user wants conversion funnel analysis for last week.
DataBot:  [reads full thread context, runs Redshift query via MCP]
          Here are the results: conversions were up 12% week-over-week...
```

The Boss reads the message, checks its team registry, and delegates to the right specialist. The specialist picks up the **full Slack thread** as context — nothing is lost in the handoff.

</details>

---

## ✨ Features

### Core Platform

| Feature | Description |
|---------|-------------|
| 👑 **Boss Agent** | Orchestrator bot that knows every specialist and delegates by @mention in threads |
| 🧠 **Agent Memory** | Agents learn from every conversation — memories auto-synced to Postgres |
| 🔌 **MCP Server Catalog** | Add tool servers once, assign to any agent — Redshift, GitHub, custom APIs |
| 🧵 **Thread Context** | Tagged agents fetch full thread history — zero context loss in handoffs |
| 💾 **Session Persistence** | Slack thread ↔ Claude session mapping survives restarts |
| 🔁 **Hot Reload** | Edit anything in the UI → agent picks up changes in seconds via Redis pub/sub |

### Web UI

| Feature | Description |
|---------|-------------|
| 🧙 **Onboarding Wizard** | 5-step guided flow: identity → Slack app → permissions → MCPs → skills |
| 📝 **Skill Editor** | In-browser editor for agent markdown skills with file tree and categories |
| 🔐 **Tool Permissions** | Per-agent allowlist/denylist for Claude Code SDK tools |
| 📊 **Live Logs** | SSE-streamed Docker log output per agent with level filters and search |
| ⚙️ **Settings** | Configurable branding (app name, logo, tagline), dashboard title, user management |
| 🧠 **Memory Viewer** | Browse, inspect, and delete agent memories grouped by type |
| 📄 **CLAUDE.md Viewer** | Read and edit the compiled system prompt sent to each agent |
| 📐 **Collapsible Sidebar** | Clean sidebar with live agent roster, status dots, and collapse toggle |
| 📱 **Responsive Design** | Mobile-friendly layout with hamburger menu, overlay sidebar, fluid grids |
| 🔒 **Auth & RBAC** | Login page, superadmin via env vars, admin/viewer roles, API route guards |
| 👥 **User Management** | Create users with admin or viewer roles from Settings, viewers get read-only UI |
| 🏢 **Agent Hierarchy** | "Reports to" field — agents report to the boss, only one boss allowed |

### Agent Capabilities

- **Slack Block Kit formatting** — markdown tables rendered as native Slack table blocks, headings, code blocks
- **Streaming responses** — tool use labels, progress indicators, and rich formatted output
- **MCP tool integration** — stdio, SSE, and HTTP transports supported
- **Customizable personas** — each agent has its own personality and behavior
- **Skill system** — modular markdown files organized by category with sort ordering
- **Auto-generated boss registry** — team roster updated automatically on agent changes
- **Memory system injected into CLAUDE.md** — agents know how to write and organize memories
- **Agent hierarchy** — `reports_to` field tracks which boss each agent reports to

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Slack Workspace                                            │
│  @boss  @data-bot  @writer  @engineer  ...                  │
└────────────────────────────┬────────────────────────────────┘
                             │ Socket Mode (Bolt)
┌────────────────────────────▼────────────────────────────────┐
│  Docker Compose                                             │
│                                                             │
│  ┌─────────────────┐  publish events  ┌─────────────────┐  │
│  │  Web UI         │ ──────────────►  │  Redis 7        │  │
│  │  Next.js 15     │                  │  pub/sub        │  │
│  │  :3000          │                  └────────┬────────┘  │
│  │                 │                           │ subscribe  │
│  │  • Dashboard    │  read/write       ┌───────▼────────┐  │
│  │  • Agent config │ ◄───────────────► │  Runner        │  │
│  │  • Skill editor │                   │                │  │
│  │  • MCP catalog  │                   │  AgentRunner   │  │
│  │  • Memory viewer│                   │  ├─ Boss       │  │
│  │  • Live logs    │                   │  ├─ DataBot    │  │
│  │  • Settings     │                   │  ├─ Writer     │  │
│  └─────────────────┘                   │  └─ ...        │  │
│          │                             └───────┬────────┘  │
│          │ read/write                          │           │
│          ▼                                     ▼           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  PostgreSQL 16                                      │   │
│  │                                                     │   │
│  │  agents · skills · memories · permissions            │   │
│  │  mcp_servers · agent_mcps · sessions                │   │
│  │  settings · users                                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**How it flows:**

1. **User** messages an agent (or `@boss`) in Slack
2. **Runner** receives the event via Bolt Socket Mode
3. **Claude Code SDK** processes the message with the agent's compiled `CLAUDE.md`
4. Agent may use **MCP tools** (Redshift queries, GitHub API, etc.) during processing
5. **Response** is formatted as Slack Block Kit and posted to the thread
6. **Memory files** written during the session are detected by `MemoryWatcher` and synced to Postgres
7. On next conversation, the agent starts with all accumulated **learned knowledge**

---

## 🚀 Quick Start

### Option A: One-command install (recommended)

```bash
npm install -g slackhive
slackhive init
```

The CLI will:
1. Check prerequisites (Docker, Docker Compose, Git)
2. Clone the repository
3. Walk you through configuration (API key, admin credentials)
4. Start all services automatically

### Option B: Manual setup

#### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/)
- An [Anthropic API key](https://console.anthropic.com/) (`ANTHROPIC_API_KEY`)

#### 1. Clone & configure

```bash
git clone https://github.com/amansrivastava17/slackhive.git
cd slackhive
cp .env.example .env
```

Edit `.env` with your Anthropic API key and credentials:

```env
ANTHROPIC_API_KEY=sk-ant-...
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme
POSTGRES_PASSWORD=slackhive
```

#### 2. Start everything

```bash
docker compose up -d --build
```

This launches all four services:

| Service | Port | Description |
|---------|------|-------------|
| **Web UI** | `localhost:3001` | Dashboard and agent management |
| **Runner** | — | Manages all Slack bot connections |
| **PostgreSQL** | `localhost:5432` | Persistent storage |
| **Redis** | `localhost:6379` | Event pub/sub for hot reload |

#### 3. Open the dashboard

```
http://localhost:3001
```

Login with your admin credentials and create your first agent.

### CLI Commands

After installing with `npm install -g slackhive`:

| Command | Description |
|---------|-------------|
| `slackhive init` | Clone, configure, and start SlackHive |
| `slackhive start` | Start all services |
| `slackhive stop` | Stop all services |
| `slackhive status` | Show running containers |
| `slackhive logs` | Tail runner logs |
| `slackhive update` | Pull latest changes and rebuild |

---

## 🔑 Claude Code Authentication

SlackHive supports two authentication modes for the Claude Code SDK. Choose the one that fits your setup.

### Option 1: API Key (pay-per-use)

Best for: teams, production, predictable billing.

Set your Anthropic API key in `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

That's it. Every agent will use this key. You're billed per token via the [Anthropic API](https://console.anthropic.com/).

### Option 2: Claude Code Subscription (Max plan)

Best for: individual developers, Claude Pro/Max subscribers ($100–$200/month unlimited).

If you have a Claude Max subscription with Claude Code access:

**Step 1 — Login on the host machine:**

```bash
claude login
```

This opens a browser for OAuth and saves credentials to `~/.claude/`.

**Step 2 — Mount credentials into the runner container:**

The `docker-compose.yml` runner service needs access to your host's Claude credentials. Add these volume mounts if not already present:

```yaml
runner:
  volumes:
    - ~/.claude:/root/.claude          # Auth credentials
    - /tmp/agents:/tmp/agents          # Agent working dirs
```

**Step 3 — Remove the API key (important):**

Make sure `ANTHROPIC_API_KEY` is **not** set in `.env`. When no API key is present, the SDK falls back to the subscription credentials from `~/.claude/`.

```env
# ANTHROPIC_API_KEY=          ← comment out or remove
```

**Step 4 — Restart:**

```bash
slackhive update
# or: docker compose up -d --build runner
```

### Which should I use?

| | API Key | Subscription |
|---|---------|-------------|
| **Billing** | Per-token (pay what you use) | Flat monthly ($100/$200) |
| **Setup** | Just paste the key | Run `claude login` on host |
| **Best for** | Teams, CI/CD, production | Solo devs, prototyping |
| **Rate limits** | API tier limits | Subscription fair-use limits |
| **Multiple agents** | All share one key | All share one subscription |

> **Note:** If both `ANTHROPIC_API_KEY` and `~/.claude` credentials are present, the API key takes precedence.

---

## 🤖 Creating Your First Agent

Click **New Agent** from the dashboard and follow the 5-step wizard:

### Step 1 — Identity
Set the agent's name, slug (e.g., `data-bot`), persona, and description. The description is used by the Boss for delegation decisions.

### Step 2 — Slack App Setup
The platform generates a `slack-app-manifest.json`. Create a Slack app from this manifest:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Paste the generated JSON
3. **Install to Workspace** → copy the **Bot Token** (`xoxb-...`)
4. **Socket Mode** → Enable → generate the **App-Level Token** (`xapp-...`)
5. **Basic Information** → copy the **Signing Secret**
6. Paste all three back in the wizard

### Step 3 — Permissions
Configure which Claude Code SDK tools the agent can use. Quick-add buttons for common tools like `Read`, `Write`, `Bash`, `WebFetch`.

### Step 4 — MCPs
Select MCP servers from the platform catalog to give your agent access to external tools (databases, APIs, etc.).

### Step 5 — Skills
Choose a starter template or start blank. Skills are modular markdown files that compose the agent's `CLAUDE.md` system prompt.

The agent starts automatically and connects to Slack.

---

## 👑 Boss Agent

Create one agent with the **Boss** toggle enabled. Its `CLAUDE.md` automatically includes a live team registry:

```markdown
## Your Team

- **DataBot** (<@U12345678>) — Data warehouse NLQ, Redshift queries, business metrics
- **Writer** (<@U87654321>) — Content generation, Slack summaries, announcements
```

The registry **auto-regenerates** whenever you add, update, or delete an agent — no manual maintenance needed.

```
User:     @boss help me analyze last week's bookings
Boss:     I'll get @data-bot on this 👇
          @data-bot — user wants booking analysis for last week
DataBot:  [reads full thread, runs Redshift query via MCP]
          Bookings were up 12% to 4,320...
```

---

## 🧠 How Agents Learn

Every conversation is an opportunity for the agent to learn. This is the **primary design goal** of the platform.

```
Conversation
  └─► Claude writes .claude/memory/feedback_xyz.md
        └─► MemoryWatcher detects change (fs.watch)
              └─► Parses YAML frontmatter (name, type, description)
                    └─► Upserts into memories table (Postgres)
                          └─► Included in CLAUDE.md on next start
```

Memory types follow [Claude Code memory conventions](https://docs.anthropic.com/en/claude-code/memory):

| Type | Purpose | Example |
|------|---------|---------|
| `feedback` | Behavioral corrections and validated approaches | "Don't mock the database in integration tests" |
| `user` | Information about people the agent works with | "Kai is the data team lead, prefers concise answers" |
| `project` | Ongoing work context, goals, deadlines | "Merge freeze starts March 5 for mobile release" |
| `reference` | Pointers to external systems and resources | "Pipeline bugs tracked in Linear project INGEST" |

View and manage all memories from **Agents → [name] → Memory**.

---

## 🔒 Authentication & Roles

SlackHive ships with a simple but effective auth system — no external auth provider needed.

### How it works

- **Superadmin** is configured via environment variables (`ADMIN_USERNAME` / `ADMIN_PASSWORD`) — never stored in the database
- **Sessions** use HMAC-signed cookies (no JWTs, no session table)
- **Middleware** protects all routes — unauthenticated requests redirect to `/login`

### Roles

| Role | Dashboard | View agents | Create/edit agents | Manage users | Settings |
|------|-----------|-------------|-------------------|--------------|----------|
| **Superadmin** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Admin** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Viewer** | ✅ | ✅ | ❌ | ❌ | ❌ |

Admins can create viewer/admin users from **Settings → Users**. All mutating API routes return `403` for viewers — enforced server-side, not just hidden in the UI.

---

## 🔌 MCP Server Catalog

MCP servers are managed at the platform level. Add a server once, assign it to any agent.

| Transport | Use Case | Config |
|-----------|----------|--------|
| `stdio` | Local subprocess | `command`, `args`, `env` |
| `sse` | Remote SSE endpoint | `url`, `headers` |
| `http` | Remote HTTP endpoint | `url`, `headers` |

**Example — Redshift MCP:**

```json
{
  "name": "redshift-mcp",
  "type": "stdio",
  "description": "Read-only Redshift query access",
  "config": {
    "command": "node",
    "args": ["/path/to/redshift-mcp-server/dist/index.js"],
    "env": { "DATABASE_URL": "redshift://user:pass@host:5439/db" }
  }
}
```

Tool names follow the pattern `mcp__{serverName}__{toolName}`.

---

## 📁 Project Structure

```
slackhive/
├── apps/
│   ├── web/                        # Next.js 15 — Web UI + API
│   │   └── src/
│   │       ├── app/                # Pages, API routes, settings
│   │       └── lib/
│   │           ├── db.ts           # Postgres + Redis client
│   │           ├── auth.ts         # HMAC cookie sessions, bcrypt
│   │           ├── auth-context.tsx # Client-side auth React context
│   │           ├── api-guard.ts    # Role guard for API routes
│   │           ├── boss-registry.ts # Auto-generated boss team registry
│   │           ├── slack-manifest.ts
│   │           └── skill-templates.ts
│   │
│   └── runner/                     # Agent runner service
│       └── src/
│           ├── agent-runner.ts     # Lifecycle manager
│           ├── claude-handler.ts   # Claude Code SDK integration
│           ├── slack-handler.ts    # Slack Bolt + Block Kit formatting
│           ├── compile-claude-md.ts # Skills + memories → CLAUDE.md
│           ├── memory-watcher.ts   # fs.watch → DB sync (learning)
│           └── logger.ts           # Structured logging
│
├── packages/
│   └── shared/                     # Shared TypeScript types + DB schema
│
├── docker-compose.yml
├── scripts/dev.sh
└── .env.example
```

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Language** | TypeScript 5.x throughout |
| **Web UI** | Next.js 15 (App Router), React 19 |
| **AI Runtime** | Claude Code SDK (`@anthropic-ai/claude-agent-sdk`) |
| **Slack** | Bolt SDK (Socket Mode) |
| **Database** | PostgreSQL 16 |
| **Pub/Sub** | Redis 7 |
| **Infrastructure** | Docker Compose |

---

## 🔮 Roadmap

We're actively building and these are on the horizon:

- [ ] **Local model support** — plug in local LLMs via Claude Code's model routing when available
- [ ] **Agent-to-agent conversations** — agents can directly message each other, not just through Boss
- [ ] **Scheduled tasks** — cron-based agent actions (daily reports, weekly summaries)
- [ ] **Multi-workspace support** — one platform instance serving multiple Slack workspaces
- [ ] **Analytics dashboard** — message volume, response times, memory growth per agent
- [ ] **Webhook triggers** — trigger agent actions from external events (GitHub, Jira, PagerDuty)
- [ ] **Custom tool builder** — define simple tools in the UI without writing an MCP server
- [ ] **Agent templates marketplace** — share and import pre-configured agent setups
- [ ] **Conversation history UI** — browse past conversations and their outcomes in the web UI
- [ ] **RAG integration** — connect agents to document stores for knowledge retrieval

Have an idea? [Open an issue](https://github.com/amansrivastava17/slackhive/issues) — we'd love to hear it.

---

## 🤝 Contributing

Contributions are very welcome! This project is in active development.

```bash
# Clone and install
git clone https://github.com/amansrivastava17/slackhive.git
cd slackhive
npm install

# Start infra
docker compose up postgres redis -d

# Run services locally
cd apps/web && npm run dev      # http://localhost:3000
cd apps/runner && npm run dev   # Connects to Slack
```

Please open an issue before submitting large PRs so we can discuss the approach.

---

## ⭐ Star History

If you find this project useful, please consider giving it a star — it helps others discover it!

<a href="https://star-history.com/#amansrivastava17/slackhive&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=amansrivastava17/slackhive&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=amansrivastava17/slackhive&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=amansrivastava17/slackhive&type=Date" width="600" />
  </picture>
</a>

---

## 📄 License

MIT © 2026 [Aman Srivastava](https://github.com/amansrivastava17)

---

<div align="center">
  <sub>Built with Claude Code SDK, Slack Bolt, and a lot of ☕</sub>
</div>
