<div align="center">

<img src="apps/web/public/logo.svg" alt="SlackHive" width="80" />

# SlackHive

### Build your AI-first company on Slack

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/slackhive?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/slackhive)
[![npm downloads](https://img.shields.io/npm/dt/slackhive?color=cb3837&logo=npm&logoColor=white&label=installs)](https://www.npmjs.com/package/slackhive)
[![Node.js](https://img.shields.io/badge/Node.js-≥20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ed?logo=docker&logoColor=white)](https://docs.docker.com/compose)
[![Documentation](https://img.shields.io/badge/docs-slackhive.mintlify.app-D97757?logo=gitbook&logoColor=white)](https://slackhive.mintlify.app)
[![Security Audit](https://github.com/pelago-labs/slackhive/actions/workflows/audit.yml/badge.svg)](https://github.com/pelago-labs/slackhive/actions/workflows/audit.yml)

[**Documentation**](https://slackhive.mintlify.app) · [Quick Start](#-quick-start) · [Features](#-features) · [Architecture](#-architecture) · [Contributing](#-contributing)

</div>

---

## Why SlackHive?

Your Slack workspace is where your team already lives. Every question, decision, and escalation happens there. SlackHive makes that workspace a mix of **people and agents** — side by side, in the same channels, in the same threads.

These aren't chatbots you switch to. They're colleagues you @mention. Each agent connects to the tools your team already uses — Notion, Jira, GitHub, Figma, your database, your analytics stack. **Anyone on the team can create one.** No engineers, no platform team — if you can describe what you need, you can deploy it in minutes.

```
CEO:        @data-analyst revenue is down 8% this week, can you dig in?
DataBot:    [queries Redshift across 6 dimensions]
            Found it — enterprise churn spiked Tuesday after the pricing change.
            3 accounts, $42k ARR at risk.

Engineer:   @devops the checkout service is throwing 500s
DevOps:     [reads logs, identifies root cause, opens PR]
            Memory leak in the payment processor pool. PR #847 is up with the fix.

PM:         @designer mock up a simpler onboarding flow
Designer:   [creates Figma frames via MCP]
            Done — 3 variants in Figma. Which direction do you want to take?
```

Tag a specialist directly when you know who to ask. Or tag `@boss` when you're not sure — Boss finds the right specialist, delegates, and summarizes the result:

```
You:        @boss can you analyze last week's conversion funnel?
Boss:       That's right up @data-analyst's alley 👇
            @data-analyst — conversion funnel analysis for last week.
            When you're done, please tag @boss.
DataBot:    Conversions up 12% WoW, checkout completion jumped 3×. @boss — done!
Boss:       Conversions are up 12% WoW. The win was checkout — 3× completion rate.
            Want me to pull a channel or cohort breakdown?
```

---

## 🚀 Quick Start

### Option A: One-command install (recommended)

```bash
npm install -g slackhive
slackhive init
```

The CLI will check prerequisites (Docker, Git), clone the repo, walk you through configuration, and start all services automatically. Open `http://localhost:3001` and create your first agent.

### CLI Commands

| Command | Description |
|---------|-------------|
| `slackhive init` | Clone, configure, and start SlackHive |
| `slackhive start` | Start all services |
| `slackhive stop` | Stop all services |
| `slackhive status` | Show running containers |
| `slackhive logs` | Tail runner logs |
| `slackhive update` | Pull latest changes and rebuild |

### Option B: Manual setup

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/), Node.js ≥ 20

```bash
git clone https://github.com/pelago-labs/slackhive.git
cd slackhive
cp .env.example .env
```

Edit `.env` with your credentials:

```env
ANTHROPIC_API_KEY=sk-ant-...        # or use Claude Pro/Max subscription
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme
POSTGRES_PASSWORD=slackhive
ENV_SECRET_KEY=                     # generate: openssl rand -hex 32
```

```bash
docker compose up -d --build
```

Open `http://localhost:3001`, log in, and create your first agent.

> Full setup guide → [slackhive.mintlify.app/quickstart](https://slackhive.mintlify.app/quickstart)

---

## ✨ Features

### 🤖 Real AI Agents — Not Chatbots

Every agent is a full **Claude Code** agent — with tools, memory, identity, and instructions. When you @mention one in Slack, you're running a real AI agent that can use tools, take action, and get smarter over time.

| | |
|---|---|
| 🧠 **Persistent Memory** | Agents write memories during conversations — feedback, user context, project state. Synced to Postgres, injected on next start. They don't forget. |
| 🔌 **MCP Tool Integration** | Connect any MCP server (Redshift, GitHub, Notion, Figma, custom APIs) — stdio, SSE, or HTTP transports. |
| 📝 **Inline TypeScript MCPs** | Paste TypeScript source directly into the UI — no deployment needed. The runner compiles and executes it. |
| 🧵 **Full Thread Context** | Agents fetch the entire Slack thread on every invocation — zero context lost in handoffs. |
| 💾 **Session Continuity** | Slack thread ↔ Claude session mapping survives restarts. Pick up exactly where you left off. |
| 🔐 **Encrypted Secret Store** | API keys encrypted at rest (AES-256). MCPs reference secrets by name — raw values never touch the API or UI. |
| 🔁 **Hot Reload** | Edit instructions, skills, or tools and the agent picks up changes within seconds. No restart needed. |

### 👑 Boss + Specialist Hierarchy

| | |
|---|---|
| 👑 **Boss Orchestration** | Boss reads your message, finds the right specialist, delegates by @mention in the same thread, and summarizes the result. |
| 🏢 **Multi-Boss Support** | Run multiple Boss agents for different domains (engineering, data, support). Specialists can report to more than one boss. |
| 📋 **Auto-Generated Registries** | Every Boss gets a live team roster auto-regenerated whenever the team changes. No manual maintenance. |
| 🛠 **Skills** | Markdown files deployed as Claude Code slash commands. Give agents SQL rules, writing guidelines, or domain playbooks. |
| ⏰ **Scheduled Jobs** | Cron-based recurring tasks — daily reports, weekly digests, monitoring alerts — posted to any Slack channel or DM. |

### ⚙️ Platform

| | |
|---|---|
| 🧙 **Onboarding Wizard** | 5-step guided setup: identity → Slack app → credentials → tools & skills → review. |
| 🕓 **Version Control** | Every save auto-snapshots the full agent state. Browse history with line-level diffs, restore any version in one click. |
| 🔒 **Auth & RBAC** | 4 roles (superadmin / admin / editor / viewer), HMAC-signed sessions, per-agent write access grants. No external auth provider needed. |
| 🚦 **Channel Restrictions** | Lock agents to specific Slack channels. Bot auto-leaves uninvited channels with a notice. |
| 📊 **Live Logs** | SSE-streamed log output per agent — with level filters and search. |
| 🧠 **Memory Viewer** | Browse, inspect, and delete agent memories by type — feedback, user, project, reference. |

---

## 🏗 Architecture

```
Slack Workspace (@boss, @data-bot, @writer, ...)
        │ Socket Mode (Bolt)
        ▼
┌──────────────────────────────────────────────────┐
│  Docker Compose                                  │
│                                                  │
│  Web (Next.js) ──── Redis ────► Runner           │
│       │                          │               │
│       └──────── PostgreSQL ──────┘               │
└──────────────────────────────────────────────────┘
```

| Service | Description |
|---------|-------------|
| **Web** (Next.js 15) | Dashboard — create agents, edit skills, view logs, manage users |
| **Runner** (Node.js) | Hosts all agent processes and Slack connections |
| **PostgreSQL** | Stores agents, memories, skills, sessions, users, history |
| **Redis** | Delivers hot-reload events from Web to Runner instantly |

**How a message flows:**
1. User @mentions an agent in Slack
2. Runner receives the event via Bolt Socket Mode
3. Claude Code processes the message with the agent's compiled `CLAUDE.md`
4. Agent uses MCP tools if needed (Redshift, GitHub, Notion, etc.)
5. Response is formatted as Slack Block Kit and posted to the thread
6. Memory files written during the session are synced to Postgres
7. Next conversation starts with all accumulated knowledge

---

## 🔑 Claude Code Authentication

Two options — use whichever fits your setup:

**Option A — API Key**
```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```
Billed per token via the Anthropic API. Best for teams and production.

**Option B — Claude Pro or Max Subscription**
```bash
claude login    # run on host machine, saves credentials to ~/.claude/
```
Mount `~/.claude` into the runner container and leave `ANTHROPIC_API_KEY` unset. Best for individual developers.

> Full guide → [slackhive.mintlify.app/configuration/env-vars](https://slackhive.mintlify.app/configuration/env-vars)

---

## 🔮 Roadmap

- [x] Boss orchestration + auto-generated team registries
- [x] Persistent memory system
- [x] Scheduled jobs
- [x] Version control with diff view
- [x] Encrypted environment variables
- [x] Channel restrictions
- [ ] Multi-workspace support
- [ ] Webhook triggers (GitHub, Jira, PagerDuty → agent actions)
- [ ] Agent-to-agent direct messaging
- [ ] Analytics dashboard
- [ ] Custom tool builder (no MCP server needed)
- [ ] Agent templates marketplace
- [ ] RAG integration — connect agents to document stores

Have an idea? [Open an issue](https://github.com/pelago-labs/slackhive/issues)

---

## 🤝 Contributing

```bash
git clone https://github.com/pelago-labs/slackhive.git
cd slackhive && npm install

# Start infra
docker compose up postgres redis -d

# Run locally
cd apps/web && npm run dev      # http://localhost:3000
cd apps/runner && npm run dev
```

Open an issue before submitting large PRs so we can align on the approach.

---

## 👥 Contributors

<a href="https://github.com/pelago-labs/slackhive/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=pelago-labs/slackhive" alt="Contributors" />
</a>

---

## ⭐ Star History

<a href="https://star-history.com/#pelago-labs/slackhive&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=pelago-labs/slackhive&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=pelago-labs/slackhive&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=pelago-labs/slackhive&type=Date" width="600" />
  </picture>
</a>

---

## 🔒 Security

Report vulnerabilities to **[aman@pelago.co](mailto:aman@pelago.co)** — please don't open public issues for security bugs. We respond within 48 hours.

---

## 📄 License

MIT © 2026 [Pelago Labs](https://github.com/pelago-labs)

<div align="center">
  <sub>Built with Claude Code, Slack Bolt, and a lot of ☕</sub>
</div>
