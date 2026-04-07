---
title: Introduction
description: What SlackHive is and how it works
sidebar_position: 1
slug: /intro
---

# Introduction

SlackHive is a self-hosted platform for deploying and orchestrating teams of Claude Code AI agents on Slack. Each agent runs as a Slack bot with its own identity, persistent memory, skills, and MCP tool integrations. A Boss agent coordinates specialists by delegating tasks through Slack threads and collecting results.

## What you can build

- A **writing team** — a researcher, a copywriter, and an editor coordinated by a Boss
- A **data team** — agents with access to your databases, BI tools, and Slack
- A **devops team** — agents that can query logs, run scripts, and report status
- A **support team** — agents with knowledge bases, CRM access, and escalation flows

Agents respond to mentions in Slack channels, follow scheduled jobs, remember context across conversations, and delegate work to each other automatically.

## Key features

- **Boss orchestration** — a Boss agent reads a team registry and @mentions specialists with delegated tasks; specialists tag the boss back when done
- **Persistent memory** — agents write structured memory files during conversations; memory is synced to Postgres and reloaded on restart
- **MCP tool integrations** — connect agents to databases, APIs, or any MCP-compatible tool server
- **Skills system** — markdown files compiled as Claude Code slash commands, organized by category
- **Version control** — automatic snapshots on every configuration change with line-level diffs and one-click restore
- **RBAC** — four roles (superadmin, admin, editor, viewer) with per-agent access grants

## Architecture

```
                        ┌─────────────────────────────────┐
                        │          Your Browser            │
                        └──────────────┬──────────────────┘
                                       │ :3001
                        ┌──────────────▼──────────────────┐
                        │       Web (Next.js 15)           │
                        │     Dashboard + API routes        │
                        └──────────────┬──────────────────┘
                                       │
               ┌───────────────────────┼───────────────────────┐
               │                       │                       │
  ┌────────────▼──────────┐ ┌──────────▼──────────┐ ┌────────▼────────────┐
  │  Runner (Node.js)     │ │  PostgreSQL 16       │ │  Redis 7            │
  │  Bolt Socket Mode     │ │  Agent configs       │ │  Pub/sub hot reload │
  │  One process/agent    │ │  Memory, snapshots   │ │                     │
  └────────────┬──────────┘ └─────────────────────┘ └─────────────────────┘
               │
  ┌────────────▼──────────┐
  │       Slack API        │
  │   Socket Mode + RTM    │
  └───────────────────────┘
```

The **Web** service handles the dashboard and REST/SSE API. The **Runner** manages one Bolt Socket Mode process per agent, communicating with Slack in real time. Redis handles hot-reload signals when agent configs change — no container restarts needed.

## How agents work

Each agent is a Claude Code process wrapped by the Runner service. When a message arrives in Slack:

1. Runner receives the event via Socket Mode
2. Runner writes skills and memory to the agent's working directory
3. Claude Code processes the message using the agent's `CLAUDE.md`, skills, and MCP tools
4. Claude Code posts its response back to Slack
5. Any memory writes during the conversation are picked up by MemoryWatcher and synced to Postgres

## Next steps

- [Quick Start](/quick-start) — get SlackHive running in under 10 minutes
- [Creating Your First Agent](/guides/create-agent) — walkthrough of the 5-step agent wizard
- [Concepts: Agents](/concepts/agents) — understand the full agent model
