# Slack Claude Code Agent Team

> Open-source platform for running and managing teams of Claude Code AI agents on Slack, with a boss agent that orchestrates specialists.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://typescriptlang.org)

---

## What is this?

This platform lets you onboard any number of Claude Code agents as Slack bots — each with their own identity, skills, MCPs, and memory — managed through a web UI. A special **Boss Agent** knows all other agents and delegates requests by tagging the right specialist in Slack threads.

Every agent **learns from interactions**: memories written during conversations are automatically persisted to Postgres and included in the agent's context on future conversations.

```
┌─────────────────────────────────────────────────────────────┐
│                    Slack Workspace                          │
│                                                             │
│  User: @boss help with last week's bookings data            │
│  Boss: Let me get @gilfoyle on this 👇                      │
│  Gilfoyle: *fetches thread context, runs Redshift queries*  │
│            Here are the results: ...                        │
└─────────────────────────────────────────────────────────────┘
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                Docker Compose                            │
│                                                          │
│  ┌───────────────┐     ┌──────────────────────────────┐  │
│  │  Next.js Web  │────▶│  Postgres 16                 │  │
│  │  (port 3000)  │     │  agents, skills, memories,   │  │
│  │               │     │  sessions, mcps, permissions │  │
│  │  - Dashboard  │     └──────────────────────────────┘  │
│  │  - Wizard     │                  │                     │
│  │  - Skill ed.  │     ┌────────────▼─────────────────┐  │
│  │  - MCP mgmt   │     │  Redis 7                     │  │
│  │  - Memory UI  │────▶│  Agent lifecycle events      │  │
│  └───────────────┘     │  (start/stop/reload)         │  │
│                        └────────────┬─────────────────┘  │
│                                     │                     │
│  ┌──────────────────────────────────▼─────────────────┐  │
│  │  Runner Service                                     │  │
│  │                                                     │  │
│  │  AgentRunner                                        │  │
│  │  ├── Boss Agent (Bolt App + ClaudeHandler)         │  │
│  │  │   └── Delegates to specialists via @mention     │  │
│  │  ├── Gilfoyle Agent (Bolt App + ClaudeHandler)     │  │
│  │  │   ├── MCP: redshift-mcp, openmetadata           │  │
│  │  │   └── MemoryWatcher → DB sync                  │  │
│  │  └── ... more agents                               │  │
│  │                                                     │  │
│  │  /tmp/agents/{slug}/CLAUDE.md (compiled from DB)   │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Features

- **5-step onboarding wizard** — guided Slack app creation with manifest generation
- **Boss agent** — knows all agents, delegates by @mentioning specialists in threads
- **Agents learn from interactions** — memories synced from runtime to Postgres
- **Global MCP catalog** — add MCP servers once, use on any agent
- **Skill editor** — edit markdown skill files in-browser (Monaco editor)
- **Memory viewer** — see and manage everything your agents have learned
- **Hot reload** — edit config in the UI, agent reloads without restart
- **Live logs** — SSE-streamed logs per agent

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/amansrivastava17/slack-claude-code-agent-team.git
cd slack-claude-code-agent-team

# 2. Start everything
sh scripts/dev.sh

# 3. Open the web UI
open http://localhost:3000
```

On first run, `dev.sh` creates `.env` from `.env.example`. Update it with your Postgres password.

## Creating Your First Agent

1. Open `http://localhost:3000` → click **New Agent**
2. **Step 1 — Identity**: Set name, slug, and persona
3. **Step 2 — Slack Setup**: The wizard generates a Slack app manifest. Paste it at `api.slack.com/apps`, install, and copy back the tokens
4. **Step 3 — Permissions**: Confirm OAuth scopes are installed
5. **Step 4 — MCPs**: Pick MCP servers from the global catalog (add servers first at Settings → MCP Servers)
6. **Step 5 — Skills**: Choose a template (blank / data-analyst / writer / developer)

The agent starts automatically and appears in the dashboard.

## Boss Agent

The boss agent is a special agent (`is_boss: true`) whose CLAUDE.md includes a registry of all other agents. When it receives a message it cannot or should not handle itself, it tags the right specialist in the Slack thread:

```
@boss: who can help me analyze conversion rates?
Boss: That's @gilfoyle's specialty. Let me get them 👇
      @gilfoyle can you help with this?
Gilfoyle: [picks up thread context, responds with data]
```

The boss's registry is automatically updated whenever you add or update an agent.

## How Agents Learn

Every conversation is an opportunity to learn. During a session, the Claude Code SDK may write memory files to the agent's working directory. The runner watches for these writes and immediately persists them to Postgres:

```
Conversation → SDK writes memory file → MemoryWatcher detects change
→ DB upsert → Included in CLAUDE.md on next start
```

Manage learned memories at `Agents → [agent] → Memory`.

## MCP Server Management

MCP servers are managed globally at **Settings → MCP Servers**. Add a server once and assign it to any agent.

Supports:
- **stdio** — Local subprocess (`node`, `uvx`, `python`, etc.)
- **SSE** — Remote Server-Sent Events endpoint
- **HTTP** — Remote HTTP endpoint

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Web UI | Next.js 15 (App Router), TypeScript, Tailwind CSS |
| Agent Runner | Node.js, `@anthropic-ai/claude-agent-sdk`, `@slack/bolt` |
| Database | PostgreSQL 16 |
| Pub/Sub | Redis 7 |
| Infrastructure | Docker Compose |

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
# Install dependencies
npm install

# Run web UI in dev mode (requires postgres + redis running)
cd apps/web && npm run dev

# Run runner in dev mode
cd apps/runner && npm run dev
```

## License

MIT — see [LICENSE](LICENSE).
