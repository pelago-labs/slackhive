<div align="center">

<img src="apps/web/public/logo.svg" alt="SlackHive" width="80" />

# SlackHive

### Build, deploy, and orchestrate teams of Claude Code AI agents on Slack

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/slackhive?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/slackhive)
[![npm downloads](https://img.shields.io/npm/dt/slackhive?color=cb3837&logo=npm&logoColor=white&label=installs)](https://www.npmjs.com/package/slackhive)
[![Node.js](https://img.shields.io/badge/Node.js-≥20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ed?logo=docker&logoColor=white)](https://docs.docker.com/compose)
[![Claude Code SDK](https://img.shields.io/badge/Claude_Code-SDK-cc785c?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/agent-sdk)
[![Slack](https://img.shields.io/badge/Slack-Bolt-4A154B?logo=slack&logoColor=white)](https://api.slack.com/bolt)
[![Security Audit](https://github.com/pelago-labs/slackhive/actions/workflows/audit.yml/badge.svg)](https://github.com/pelago-labs/slackhive/actions/workflows/audit.yml)
[![Dependencies](https://img.shields.io/badge/dependencies-up%20to%20date-brightgreen?logo=dependabot)](https://github.com/pelago-labs/slackhive/security/dependabot)
[![Documentation](https://img.shields.io/badge/docs-slackhive.mintlify.app-D97757?logo=gitbook&logoColor=white)](https://slackhive.mintlify.app)

[Quick Start](#-quick-start) · [Features](#-features) · [Architecture](#-architecture) · [Documentation](https://slackhive.mintlify.app) · [Contributing](#-contributing)

</div>

---

## Why SlackHive?

Slack is where your company already works. Every decision, every question, every escalation — it all happens there. We believe the future of AI at work isn't a separate tool you switch to — it's agents that are **part of the team**, living where work already happens.

In the near future, every Slack team will have AI members alongside humans. An AI engineer who fixes bugs and reviews code. A data analyst who runs queries and surfaces insights on demand. A fraud analyst who monitors transactions and reports anomalies before anyone asks. A support agent who resolves tickets and escalates edge cases. Not tools you prompt — **teammates you @mention**.

SlackHive is built on this belief. It gives you the infrastructure to deploy, manage, and grow a team of AI agents on Slack — each with their own identity, memory, skills, and tools. The more they work with your team, the smarter they get.

The AI-native team isn't a future concept. It's something you can build today.

<details>
<summary><b>See it in action</b></summary>

```
User:       @boss can you analyze last week's conversion funnel?
Boss:       That's right up @data-analyst's alley. Let me loop them in 👇
            @data-analyst — user wants conversion funnel analysis for last week.
            When you're done, please tag @boss.
DataBot:    [reads full thread context, runs Redshift query via MCP]
            Here are the results: conversions were up 12% WoW, driven by
            a 3× improvement in checkout step completion. @boss — done!
Boss:       Great find @data-analyst! To summarize for you —
            conversions are up 12% week-over-week. The big win was
            checkout: completion rate jumped 3×. Want me to dig into
            which channels drove that, or pull a cohort breakdown?
```

The Boss reads the message, checks its team registry, delegates to the right specialist, and **confirms the result** before responding to the user. The specialist picks up the **full Slack thread** as context — nothing is lost in the handoff.

You can also tag specialists directly — no boss needed:

```
User:       @data-analyst pull last week's conversion funnel
DataBot:    [reads thread, runs Redshift query via MCP]
            Conversions were up 12% WoW. Checkout completion
            jumped 3×. Want a channel or cohort breakdown?
```

</details>

---

## ✨ Features

### 🤖 Claude Code Agents — The Real Thing

Every agent in SlackHive is a full **Claude Code SDK** agent — not a chatbot wrapper, not a prompt chain. Each one runs with its own identity, memory, tools, and instructions. When you @mention one in Slack, you're talking to a real AI agent that can use tools, remember context across conversations, and get smarter over time.

| | |
|---|---|
| 🧠 **Persistent Memory** | Agents write memories during conversations — feedback, user context, project state. Synced to Postgres, injected on next start. They don't forget. |
| 🔌 **MCP Tool Integration** | Connect any MCP server (Redshift, GitHub, custom APIs) — stdio, SSE, or HTTP. Agents use real tools, not hallucinated ones. |
| 📝 **Inline TypeScript MCPs** | Paste TypeScript source directly into the UI — the runner compiles and executes it with `tsx`. No deployment needed. |
| 🧵 **Full Thread Context** | When tagged, agents fetch the entire Slack thread — zero context lost in handoffs between agents. |
| 💾 **Session Continuity** | Slack thread ↔ Claude session mapping survives restarts. Pick up exactly where you left off. |
| 🔐 **Encrypted Secret Store** | API keys and credentials encrypted at rest (pgcrypto). MCPs reference secrets by name — raw values never touch the API or UI. |
| 🔁 **Hot Reload** | Edit an agent's instructions, skills, or tools in the UI — it picks up changes in seconds via Redis pub/sub. No restart needed. |

---

### 👑 Boss + Specialist Hierarchy

Think of it like a real Slack team: **managers who know their direct reports**. Each Boss agent has a built-in roster of specialists it can delegate to. Each agent's `CLAUDE.md` is its system prompt — its identity, instructions, and accumulated knowledge. Skills are modular capabilities bolted on top.

| | |
|---|---|
| 👑 **Boss Orchestration** | The Boss reads your message, checks its team registry, and delegates to the right specialist by @mention — all in the same thread. |
| 🏢 **Multi-Boss Support** | Run multiple Boss agents for different domains (engineering, data, support). Specialists can report to more than one boss. |
| 📋 **Auto-Generated Registries** | Every Boss gets a live `CLAUDE.md` roster of its reportees — auto-regenerated whenever the team changes. No manual maintenance. |
| 📄 **CLAUDE.md as System Prompt** | Each agent's `CLAUDE.md` is its core identity — role, behavior, memories, and instructions. Edit it live; the agent picks it up instantly. |
| 🛠 **Skills as Capabilities** | Skills are markdown files deployed as Claude Code slash commands. Give an agent SQL rules, writing guidelines, or domain playbooks — modular and reusable. |
| ⏰ **Scheduled Jobs** | Cron-based recurring tasks sent to the Boss — daily reports, weekly digests, monitoring alerts — posted to any Slack channel or DM. |

---

### ⚙️ Platform Capabilities

Everything you need to build, manage, and scale a team of AI agents — without writing infrastructure.

| | |
|---|---|
| 🧙 **Onboarding Wizard** | 5-step guided setup: identity → Slack app → credentials → tools & skills → review. Live in minutes. |
| 📝 **Skill System** | Write agent skills as markdown — deployed as real Claude Code slash commands in `.claude/commands/`. |
| 📄 **CLAUDE.md Editor** | Dedicated editor for agent identity and instructions, separate from skills. Version-controlled. |
| 🕓 **Version Control** | Every save auto-snapshots the full agent state. Browse history with line-level diffs, restore any point in one click. |
| 🔒 **Auth & RBAC** | 4 roles (superadmin / admin / editor / viewer), HMAC-signed sessions, per-agent write access grants. No external auth provider needed. |
| 🚦 **Channel Restrictions** | Lock agents to specific Slack channels. Bot silently ignores messages outside its allowlist and auto-leaves uninvited channels with a notice. |
| 📊 **Live Logs** | SSE-streamed Docker log output per agent — with level filters and search, right in the dashboard. |
| 🧠 **Memory Viewer** | Browse, inspect, and delete agent memories by type — feedback, user, project, reference. |
| 🔐 **Tool Permissions** | Per-agent allowlist/denylist for Claude Code SDK tools. Control exactly what each agent can do. |
| 🧪 **220+ Tests** | Vitest unit tests across web and runner. CI runs on every push and PR. |

### Agent Capabilities

- **Slack Block Kit formatting** — markdown tables rendered as native Slack table blocks, headings, code blocks
- **Streaming responses** — tool use labels, progress indicators, and rich formatted output
- **MCP tool integration** — stdio, SSE, and HTTP transports supported; persistent MCP process manager keeps servers alive across queries
- **Encrypted environment variables** — `ENV_SECRET_KEY`-based pgcrypto encryption; MCP configs reference store keys via `envRefs` instead of embedding raw secrets
- **Inline TypeScript MCPs** — paste TS source in the UI; runner writes to disk and executes with `tsx` + `NODE_PATH` resolution
- **Customizable personas** — each agent has its own personality and behavior
- **Skill system** — modular markdown files deployed as Claude Code slash commands in `.claude/commands/`
- **Separate CLAUDE.md** — agent identity/instructions stored independently from skills; boss registries auto-generated
- **Full version control** — auto-snapshot on every change (skills, CLAUDE.md, permissions, MCPs); line-level diff view; one-click restore; capped at 10 snapshots per agent
- **Auto-generated boss registry** — each boss gets a team roster compiled from agents that report to it
- **Memory system injected into CLAUDE.md** — agents know how to write and organize memories
- **Multi-boss hierarchy** — `reports_to` is a UUID array; an agent can report to multiple bosses
- **Channel restrictions** — per-agent allowlist enforced at the message handler level; outbound job DMs bypass restrictions; bot auto-leaves non-allowed channels with an admin notice

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
│  ┌─────────────────┐  publish events  ┌─────────────────┐   │
│  │  Web UI         │ ──────────────►  │  Redis 7        │   │
│  │  Next.js 15     │                  │  pub/sub        │   │
│  │  :3000          │                  └────────┬────────┘   │
│  │                 │                           │ subscribe  │
│  │  • Dashboard    │  read/write       ┌───────▼────────┐   │
│  │  • Agent config │ ◄───────────────► │  Runner        │   │
│  │  • Skill editor │                   │                │   │
│  │  • MCP catalog  │                   │  AgentRunner   │   │
│  │  • Memory viewer│                   │  ├─ Boss       │   │
│  │  • Live logs    │                   │  ├─ DataBot    │   │
│  │  • Settings     │                   │  ├─ Writer     │   │
│  └─────────────────┘                   │  └─ ...        │   │
│          │                             └───────┬────────┘   │
│          │ read/write                          │            │
│          ▼                                     ▼            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  PostgreSQL 16                                      │    │
│  │                                                     │    │
│  │  agents · skills · memories · permissions           │    │
│  │  mcp_servers · agent_mcps · sessions · env_vars     │    │
│  │  settings · users · scheduled_jobs · job_runs       │    │
│  │  agent_snapshots · agent_access · agent_restrictions  │    │
│  └─────────────────────────────────────────────────────┘    │
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
git clone https://github.com/pelago-labs/slackhive.git
cd slackhive
cp .env.example .env
```

Edit `.env` with your Anthropic API key and credentials:

```env
ANTHROPIC_API_KEY=sk-ant-...
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme
POSTGRES_PASSWORD=slackhive
ENV_SECRET_KEY=<generate with: openssl rand -hex 32>
```

> `ENV_SECRET_KEY` is required for the encrypted env vars store. The `slackhive init` CLI generates this automatically.

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

## 🔐 Encrypted Environment Variables

SlackHive includes a platform-level secret store for values that MCP servers need (API keys, database URLs, etc.). Values are encrypted at rest using pgcrypto with a key you control.

### Setup

Add `ENV_SECRET_KEY` to your `.env` (the `slackhive init` CLI generates this automatically):

```env
ENV_SECRET_KEY=$(openssl rand -hex 32)
```

For existing installs, run the migration:

```bash
docker exec -i slackhive-postgres-1 psql -U <db_user> -d <db_name> < packages/shared/src/db/migrate-env-vars.sql
```

### Usage

1. Open **Env Vars** in the sidebar
2. Add a key (e.g. `REDSHIFT_DATABASE_URL`) and its value — stored encrypted, never returned via API
3. In your MCP server config, use **Env Refs** to map the store key to the env var the process needs:
   ```json
   { "envRefs": { "DATABASE_URL": "REDSHIFT_DATABASE_URL" } }
   ```
4. The runner resolves and injects the decrypted value at agent start time

---

## 📝 Inline TypeScript MCPs

Instead of deploying a separate MCP server binary, you can paste TypeScript source directly into the UI. The runner writes it to disk and executes it with `tsx`.

**Use case**: internal MCP servers that you don't want to expose as file paths in config.

In the MCP editor, select **TypeScript inline script** as the transport and paste your source. The runner handles compilation and execution — no `command` or `args` needed.

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

### Step 1 — Name & Role
Set the agent's name (slug auto-generated), optional description, persona, and model. Toggle **Boss** if this agent orchestrates others — boss agents auto-generate their `CLAUDE.md` from the team registry and skip the Tools step. For specialist agents, select which boss(es) they report to.

### Step 2 — Slack App
The wizard generates a manifest JSON. In another tab:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Select your workspace, paste the manifest, click **Create**
3. **Install to workspace** — you'll grab the tokens in the next step

### Step 3 — Credentials
Paste the three values from your Slack app settings:
- **Bot Token (`xoxb-…`)** — OAuth & Permissions → Bot User OAuth Token
- **App-Level Token (`xapp-…`)** — Basic Information → App-Level Tokens → scope `connections:write`
- **Signing Secret** — Basic Information → App Credentials

### Step 4 — Tools
Select MCP servers from the platform catalog and pick a starter skill template (Blank / Data Analyst / Writer / Developer). Both can be changed at any time from the agent detail page.

### Step 5 — Review
Confirm the summary and click **Create Agent**. The runner picks it up automatically and connects to Slack.

The agent starts automatically and connects to Slack.

---

## 👑 Boss Agents

Create one or more agents with the **Boss** toggle enabled. Each boss gets its own `CLAUDE.md` team registry listing the agents that report to it:

```markdown
## Your Team

- **DataBot** (<@U12345678>) — Data warehouse NLQ, Redshift queries, business metrics
- **Writer** (<@U87654321>) — Content generation, Slack summaries, announcements
```

The registry **auto-regenerates** for every boss whenever you add, update, or delete an agent — no manual maintenance needed.

You can have **multiple boss agents** for different domains or teams. When creating a specialist agent, check the bosses it should report to — it will appear in each selected boss's registry. A specialist can report to more than one boss.

```
User:       @boss help me analyze last week's bookings
Boss:       I'll get @data-bot on this 👇
            @data-bot — user wants booking analysis for last week.
            When you're done, please tag @boss.
DataBot:    [reads full thread, runs Redshift query via MCP]
            Bookings were up 12% to 4,320 last week. @boss — done!
Boss:       Bookings hit 4,320 last week — up 12% 📈
            Want a breakdown by channel, region, or product?
```

---

## 🧠 How Agents Learn

Every conversation is an opportunity for the agent to learn. This is the **primary design goal** of the platform.

```
Conversation
  └─► Claude writes memory/feedback_xyz.md
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

## ⏰ Scheduled Jobs

Scheduled jobs let the boss agent run recurring tasks on a cron schedule and post results to Slack.

### How it works

1. Create a job from the **Jobs** page in the web UI
2. Set a **prompt** (what to tell the boss), **schedule** (cron expression), and **target** (channel or DM)
3. The runner's `JobScheduler` fires on schedule and sends the prompt to the boss agent
4. Boss processes it like any normal message — may delegate to specialists, run MCP tools, etc.
5. Result is posted to the target Slack channel or DM
6. Run history (status, output, duration) is tracked and visible in the UI

### Example

| Field | Value |
|-------|-------|
| **Name** | Daily Booking Report |
| **Prompt** | Generate a summary of yesterday's bookings with key metrics |
| **Schedule** | `0 8 * * *` (daily at 8:00 AM) |
| **Target** | `#analytics` channel |

The UI includes schedule presets (hourly, daily, weekdays, weekly) and shows cron expressions in human-readable form.

### Job run states

| Status | Meaning |
|--------|---------|
| **Running** | Job is currently executing |
| **Success** | Completed and result posted to Slack |
| **Error** | Failed — boss not running, Claude error, or Slack API failure |

---

## 🚦 Channel Restrictions

By default, a SlackHive agent will respond in any channel it's invited to. Channel restrictions let you lock each agent to a specific set of channels.

### How it works

1. Open **Agents → [name] → Overview** and scroll to **Allowed Channels**
2. Enter one or more Slack channel IDs (e.g. `C12345678`) — find these in Slack by right-clicking the channel → **Copy link**, or from the channel URL
3. Save — the agent now only responds in those channels

When a channel list is set:
- **Messages in unlisted channels are silently ignored** — the bot does not reply
- **If the bot is invited to a non-allowed channel**, it posts a polite notice (`This agent is restricted to specific channels. Please contact an admin to request access.`) and immediately leaves
- **Outbound job DMs are not affected** — scheduled jobs can still DM any user
- **Empty list = unrestricted** — the bot responds everywhere (default behaviour)

### Finding channel IDs

In Slack: open the channel → right-click the channel name → **Copy link**. The ID is the `C…` segment at the end of the URL (e.g. `https://app.slack.com/client/T.../C12345678`).

---

## 🔒 Authentication & Roles

SlackHive ships with a simple but effective auth system — no external auth provider needed.

### How it works

- **Superadmin** is configured via environment variables (`ADMIN_USERNAME` / `ADMIN_PASSWORD`) — never stored in the database
- **Sessions** use HMAC-signed cookies (no JWTs, no session table)
- **Middleware** protects all routes — unauthenticated requests redirect to `/login`

### Roles

| Role | View all agents | Edit agents | Manage jobs | Settings | Manage users |
|------|----------------|-------------|-------------|----------|-------------|
| **Superadmin** | ✅ | ✅ all | ✅ | ✅ | ✅ |
| **Admin** | ✅ | ✅ all | ✅ | ✅ | ✅ |
| **Editor** | ✅ | ✅ own + granted | ✅ | ✅ | ❌ |
| **Viewer** | ✅ | ❌ | ❌ | ❌ | ❌ |

- **Superadmin**: configured via env vars, never stored in DB
- **Admin**: full access — can create users, change roles, and grant per-agent write access
- **Editor**: read all agents by default; write access on own created agents and any agents an admin explicitly grants. Role can be changed by admin.
- **Viewer**: read-only access to everything

### Per-agent write access

Admins can grant editors write access to specific agents from **Settings → Users → Agent Access**. Each editor gets a checklist of agents — checking one grants them full edit rights (skills, CLAUDE.md, permissions, MCPs, history restore) for that agent.

Editors always have write access to agents they created themselves.

All permissions are enforced server-side via API route guards — not just hidden in the UI.

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
│   │           ├── api-guard.ts    # Role + per-agent write guards for API routes
│   │           ├── boss-registry.ts # Auto-generated boss team registry
│   │           ├── slack-manifest.ts
│   │           └── skill-templates.ts
│   │
│   └── runner/                     # Agent runner service
│       └── src/
│           ├── agent-runner.ts     # Lifecycle manager
│           ├── claude-handler.ts   # Claude Code SDK integration
│           ├── slack-handler.ts    # Slack Bolt + Block Kit formatting
│           ├── compile-claude-md.ts # Writes CLAUDE.md (identity + memories) and .claude/commands/ (skills)
│           ├── memory-watcher.ts   # fs.watch → DB sync (learning)
│           ├── job-scheduler.ts   # Cron-based scheduled job executor
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
- [x] **Scheduled tasks** — cron-based agent actions (daily reports, weekly summaries)
- [x] **Channel restrictions** — per-agent channel allowlist; bot auto-leaves uninvited channels
- [ ] **Multi-workspace support** — one platform instance serving multiple Slack workspaces
- [ ] **Analytics dashboard** — message volume, response times, memory growth per agent
- [ ] **Webhook triggers** — trigger agent actions from external events (GitHub, Jira, PagerDuty)
- [ ] **Custom tool builder** — define simple tools in the UI without writing an MCP server
- [ ] **Agent templates marketplace** — share and import pre-configured agent setups
- [x] **Version control** — auto-snapshot on every change with diff view and one-click restore
- [x] **Separate CLAUDE.md + skills** — CLAUDE.md is agent identity; skills are real Claude Code slash commands
- [ ] **Conversation history UI** — browse past conversations and their outcomes in the web UI
- [ ] **RAG integration** — connect agents to document stores for knowledge retrieval

Have an idea? [Open an issue](https://github.com/pelago-labs/slackhive/issues) — we'd love to hear it.

---

## 🤝 Contributing

Contributions are very welcome! This project is in active development.

```bash
# Clone and install
git clone https://github.com/pelago-labs/slackhive.git
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

## 👥 Contributors

Thanks to everyone who has contributed to SlackHive!

<a href="https://github.com/pelago-labs/slackhive/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=pelago-labs/slackhive" alt="Contributors" />
</a>

Want to contribute? Check out our [Contributing Guide](CONTRIBUTING.md) and [open issues](https://github.com/pelago-labs/slackhive/issues).

---

## ⭐ Star History

If you find this project useful, please consider giving it a star — it helps others discover it!

<a href="https://star-history.com/#pelago-labs/slackhive&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=pelago-labs/slackhive&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=pelago-labs/slackhive&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=pelago-labs/slackhive&type=Date" width="600" />
  </picture>
</a>

---

## 🔒 Security

### Vulnerability Policy

SlackHive takes supply chain security seriously:

- **`npm audit`** runs on every PR — critical/high vulnerabilities block merge
- **Weekly automated fix PRs** are created by the [Security Audit workflow](https://github.com/pelago-labs/slackhive/actions/workflows/audit.yml) if new vulnerabilities are detected
- **Dependabot** monitors all npm dependencies daily and opens update PRs automatically
- All workspace packages are licensed MIT — no copyleft or proprietary transitive dependencies

### Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email **[aman@pelago.co](mailto:aman@pelago.co)** with:
- A description of the vulnerability
- Steps to reproduce
- Potential impact

We aim to respond within 48 hours and issue a fix within 7 days for confirmed issues.

### Secrets & Credentials

- Agent tokens and MCP credentials are **never committed** — use `.env` (gitignored)
- MCP server secrets should be stored in **Encrypted Env Vars** (Settings → Env Vars) and referenced via `envRefs` in MCP configs — values are AES-256 encrypted at rest
- SQL migration files (which may contain instance-specific data) are **gitignored** — only `schema.sql` is tracked

---

## 📄 License

MIT © 2026 [Pelago Labs](https://github.com/pelago-labs)

---

<div align="center">
  <sub>Built with Claude Code SDK, Slack Bolt, and a lot of ☕</sub>
</div>
