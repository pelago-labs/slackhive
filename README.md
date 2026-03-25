# Slack Claude Code Agent Team

**An open-source platform to run, manage, and orchestrate teams of Claude Code AI agents on Slack.**

Each agent is a standalone Slack bot powered by the [Claude Code SDK](https://docs.anthropic.com/en/agent-sdk). A special **Boss Agent** knows every specialist on the team and delegates requests by tagging them in Slack threads. Every agent continuously **learns from conversations** — memories are automatically persisted to Postgres and loaded on the next start.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ed)](https://docs.docker.com/compose)

---

## Table of Contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Features](#features)
- [Quick Start](#quick-start)
- [Creating Your First Agent](#creating-your-first-agent)
- [Boss Agent](#boss-agent)
- [How Agents Learn](#how-agents-learn)
- [MCP Server Catalog](#mcp-server-catalog)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)
- [License](#license)

---

## How it works

```
User → @boss help me analyze last week's bookings
Boss → I'll get @gilfoyle on this 👇  (tags specialist in thread)
Gilfoyle → [reads full thread context, runs Redshift query via MCP]
         → Here are the results: bookings were up 12% to 4,320...
```

The **Boss Agent** is just another Slack bot, but its system prompt (CLAUDE.md) includes a live registry of every other agent — their names, Slack user IDs, and what they specialize in. It uses this to decide who to tag. The tagged agent reads the **full thread history** as context, so nothing is lost in the handoff.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Your Slack Workspace                                            │
│  @boss  @gilfoyle  @writer  @engineer  ...                       │
└──────────────────────────┬───────────────────────────────────────┘
                           │  Socket Mode (Bolt)
┌──────────────────────────▼───────────────────────────────────────┐
│  Docker Compose                                                  │
│                                                                  │
│  ┌──────────────────┐   publish events   ┌──────────────────┐   │
│  │   Web UI         │ ─────────────────► │   Redis 7        │   │
│  │   Next.js 15     │                    │   pub/sub        │   │
│  │   :3000          │                    └────────┬─────────┘   │
│  │                  │                             │ subscribe   │
│  │  • Dashboard     │   read/write        ┌───────▼──────────┐  │
│  │  • Agent wizard  │ ◄──────────────────►│   Runner         │  │
│  │  • Skill editor  │                     │                  │  │
│  │  • MCP catalog   │                     │  AgentRunner     │  │
│  │  • Memory viewer │                     │  ├─ Boss (Bolt)  │  │
│  │  • Live logs     │                     │  ├─ Gilfoyle     │  │
│  └──────────────────┘                     │  ├─ Writer       │  │
│           │                               │  └─ ...          │  │
│           │  read/write                   └───────┬──────────┘  │
│           ▼                                       │             │
│  ┌──────────────────────────────────────────────┐ │             │
│  │  PostgreSQL 16                               │◄┘             │
│  │                                              │               │
│  │  agents       — registered bots              │               │
│  │  mcp_servers  — global MCP catalog           │               │
│  │  agent_mcps   — which MCPs each agent uses   │               │
│  │  skills       — markdown skill files         │               │
│  │  permissions  — tool allowlists              │               │
│  │  memories     — learned knowledge ← KEY      │               │
│  │  sessions     — thread ↔ Claude session IDs  │               │
│  └──────────────────────────────────────────────┘               │
│                                                                  │
│  /tmp/agents/{slug}/CLAUDE.md  (compiled at runtime, ephemeral) │
└──────────────────────────────────────────────────────────────────┘
```

---

## Features

| Feature | Description |
|---------|-------------|
| 🧙 **Onboarding Wizard** | 5-step guided flow: identity → Slack app setup (with manifest generation) → permissions → MCPs → skills |
| 👑 **Boss Agent** | Slack bot that knows all agents, delegates by @mention in threads |
| 🧠 **Agent Memory** | SDK memory writes are watched and synced to Postgres automatically |
| 🔌 **Global MCP Catalog** | Add MCP servers once at platform level; assign to any agent |
| 📝 **Skill Editor** | In-browser Monaco editor for agent markdown skills |
| 🔐 **Tool Permissions** | Per-agent allowlist/denylist for Claude Code SDK tools |
| 🔁 **Hot Reload** | Edit config in UI → Redis event → runner recompiles + restarts agent |
| 📊 **Live Logs** | SSE-streamed log output per agent |
| 🧵 **Thread Context** | Tagged agents fetch full thread history — no context lost in handoffs |
| 💾 **Session Persistence** | Slack thread → Claude session ID stored in Postgres, survives restarts |

---

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/)
- Node.js ≥ 20 (for local development only)

### 1. Clone

```bash
git clone https://github.com/amansrivastava17/slack-claude-code-agent-team.git
cd slack-claude-code-agent-team
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set a secure POSTGRES_PASSWORD
```

### 3. Start all services

```bash
sh scripts/dev.sh
```

This starts:
- PostgreSQL on `localhost:5432`
- Redis on `localhost:6379`
- Web UI on `http://localhost:3000`
- Runner service (manages all Slack bots)

The Postgres schema is applied automatically on first start.

### 4. Open the web UI

```
http://localhost:3000
```

---

## Creating Your First Agent

Click **New Agent** from the dashboard and follow the 5-step wizard:

### Step 1 — Identity
Set the agent's name, URL-safe slug (e.g., `gilfoyle`), persona, and a short description of what it does. The description is used by the Boss Agent's registry.

### Step 2 — Slack App Setup
The platform generates a ready-to-use `slack-app-manifest.json`. Follow the in-wizard instructions:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Paste the generated manifest JSON
3. **Install to Workspace** → copy the **Bot Token** (`xoxb-...`)
4. Go to **Socket Mode** → Enable → generate and copy the **App-Level Token** (`xapp-...`)
5. Go to **Basic Information** → copy the **Signing Secret**
6. Paste all three back in the wizard → click **Test Connection**

### Step 3 — Slack Permissions
Confirm all required OAuth scopes are installed. Add any extra scopes your agent needs.

### Step 4 — MCPs & Tools
Select which MCP servers from the [global catalog](#mcp-server-catalog) this agent should use. Tool permissions are auto-populated from your selection.

### Step 5 — Skills
Choose a starter template:
- **blank** — minimal identity only
- **data-analyst** — SQL/query patterns (based on the NLQ bot)
- **writer** — content generation style guide
- **developer** — code review and engineering standards

The agent starts automatically. Edit skills, memory, and MCP assignments any time from the agent's detail page.

---

## Boss Agent

Create one agent with the **Boss** toggle enabled. Its CLAUDE.md automatically includes:

```markdown
## Your Team

- @gilfoyle (U12345678) — Data warehouse NLQ, Redshift queries, business metrics
- @writer (U87654321) — Content generation, Slack summaries, announcements
```

When the Boss receives a message it should delegate:
```
User: @boss can you analyze last week's conversion funnel?
Boss: That's right up @gilfoyle's alley. Let me loop them in 👇
      @gilfoyle — user wants conversion funnel analysis for last week.
Gilfoyle: [picks up thread, runs queries, responds]
```

The Boss's team registry is automatically regenerated whenever you add or update an agent.

---

## How Agents Learn

Every conversation is an opportunity for the agent to learn. This is the **primary design goal** of the platform.

During a session, the Claude Code SDK may write memory files to the agent's working directory. The `MemoryWatcher` in the runner service watches for these writes:

```
Conversation
  └─► Claude writes .claude/memory/feedback_xyz.md
        └─► MemoryWatcher detects change (fs.watch)
              └─► Parses frontmatter (name, type)
                    └─► Upserts into memories table (Postgres)
                          └─► Included in CLAUDE.md on next start
```

Memory types follow the [auto-memory system](https://docs.anthropic.com/en/claude-code/memory) conventions:

| Type | Description |
|------|-------------|
| `feedback` | How the agent should behave — corrections, validated approaches |
| `user` | Information about the users the agent works with |
| `project` | Ongoing work context, goals, deadlines |
| `reference` | Pointers to external systems and resources |

View and manage all memories at **Agents → [agent name] → Memory**.

---

## MCP Server Catalog

MCP servers are managed at the platform level at **Settings → MCP Servers**. Add a server once, use it on any agent.

Supported transport types:

| Type | Use case | Config fields |
|------|----------|---------------|
| `stdio` | Local subprocess | `command`, `args`, `env` |
| `sse` | Remote SSE endpoint | `url`, `headers` |
| `http` | Remote HTTP endpoint | `url`, `headers` |

### Example: adding Redshift MCP

```json
{
  "name": "redshift-mcp",
  "type": "stdio",
  "description": "Read-only Redshift query access",
  "config": {
    "command": "node",
    "args": ["/path/to/redshift-mcp-server/dist/index.js"],
    "env": {
      "DATABASE_URL": "redshift://user:pass@host:5439/dbname"
    }
  }
}
```

Tool names follow the pattern: `mcp__{name}__{toolName}` (e.g., `mcp__redshift-mcp__query`).

---

## Project Structure

```
slack-claude-code-agent-team/
├── apps/
│   ├── web/                        # Next.js 15 web UI
│   │   └── src/
│   │       ├── app/
│   │       │   ├── page.tsx        # Dashboard
│   │       │   ├── agents/new/     # Onboarding wizard
│   │       │   ├── settings/mcps/  # MCP catalog management
│   │       │   └── api/            # REST API routes
│   │       └── lib/
│   │           ├── db.ts           # Postgres + Redis client
│   │           ├── slack-manifest.ts
│   │           └── skill-templates.ts
│   │
│   └── runner/                     # Agent runner service
│       └── src/
│           ├── index.ts            # Entry point
│           ├── agent-runner.ts     # AgentRunner (lifecycle manager)
│           ├── claude-handler.ts   # Claude Code SDK integration ← core
│           ├── slack-handler.ts    # Slack Bolt event handlers
│           ├── compile-claude-md.ts # Skills + memories → CLAUDE.md
│           ├── memory-watcher.ts   # fs.watch → DB sync ← learning
│           ├── db.ts               # Postgres queries
│           └── logger.ts           # Winston structured logging
│
├── packages/
│   └── shared/                     # Shared TypeScript types
│       └── src/
│           ├── types.ts            # All interfaces and type definitions
│           └── db/schema.sql       # PostgreSQL schema
│
├── docker-compose.yml
├── scripts/dev.sh
└── .env.example
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript 5.x throughout |
| Web UI | Next.js 15 (App Router), React 19, Tailwind CSS |
| AI | `@anthropic-ai/claude-agent-sdk` (Claude Code SDK) |
| Slack | `@slack/bolt` (Socket Mode) |
| Database | PostgreSQL 16 |
| Pub/Sub | Redis 7 |
| Logging | Winston |
| Infrastructure | Docker Compose |
| Node.js | ≥ 20.0.0 |

---

## Contributing

Contributions are very welcome! This project is in early development and there is a lot to build.

```bash
# Install all workspace dependencies
npm install

# Local dev (requires Postgres + Redis running via Docker):
docker compose up postgres redis -d

# Run web UI
cd apps/web && npm run dev      # http://localhost:3000

# Run runner
cd apps/runner && npm run dev
```

Please open an issue before submitting large PRs so we can discuss the approach.

---

## License

MIT © 2026 Aman Srivastava — see [LICENSE](LICENSE).
