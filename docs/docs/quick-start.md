---
title: Quick Start
description: Get SlackHive running in under 10 minutes
sidebar_position: 2
slug: /quick-start
---

# Quick Start

Get SlackHive running locally in under 10 minutes.

## Prerequisites

- Docker and Docker Compose (Docker Desktop 4.x or later)
- An Anthropic API key **or** a Claude Max subscription (see [Claude Authentication](/configuration/claude-auth))
- A Slack workspace where you can install apps

## Option A — CLI (recommended)

```bash
npm install -g slackhive
slackhive init
```

`slackhive init` is interactive. It clones the repo, walks you through the `.env` configuration, and starts the stack.

## Option B — Manual setup

**1. Clone the repository**

```bash
git clone https://github.com/pelago-labs/slackhive.git
cd slackhive
```

**2. Configure the environment**

```bash
cp .env.example .env
```

Open `.env` and fill in the required values:

```bash
# Claude — choose one authentication method
ANTHROPIC_API_KEY=sk-ant-...          # Option A: pay-per-token API key

# Admin credentials (superadmin account, not stored in DB)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme               # Change this before exposing to network

# Database
POSTGRES_PASSWORD=changeme
POSTGRES_DB=slackhive
POSTGRES_USER=slackhive

# Redis
REDIS_URL=redis://redis:6379

# Required for encrypted env var storage
ENV_SECRET_KEY=a-random-32-char-string-here
```

`ENV_SECRET_KEY` is used by pgcrypto to encrypt secrets at rest. Generate a strong random value:

```bash
openssl rand -base64 32
```

**3. Start the stack**

```bash
docker compose up -d --build
```

This starts four services: `web`, `runner`, `postgres`, and `redis`. First build takes 2–3 minutes.

**4. Open the dashboard**

Navigate to [http://localhost:3001](http://localhost:3001) and sign in with your `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

## Environment variable reference

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | One of the two | API key for pay-per-token usage |
| `ADMIN_USERNAME` | Yes | Superadmin username (env-only, not in DB) |
| `ADMIN_PASSWORD` | Yes | Superadmin password |
| `POSTGRES_PASSWORD` | Yes | Postgres password |
| `POSTGRES_DB` | No | Database name (default: `slackhive`) |
| `POSTGRES_USER` | No | Database user (default: `slackhive`) |
| `REDIS_URL` | No | Redis connection URL (default: `redis://redis:6379`) |
| `ENV_SECRET_KEY` | Yes | Encryption key for env var store |
| `AGENTS_TMP_DIR` | No | Agent working dir (default: `/tmp/agents`) |
| `PORT` | No | Web service port (default: `3001`) |

For the full environment variable reference see [Configuration: Environment Variables](/configuration/env-vars).

## Verify the installation

```bash
slackhive status
# or
docker compose ps
```

All four containers (`web`, `runner`, `postgres`, `redis`) should show status `Up`.

Check logs if anything is unhealthy:

```bash
slackhive logs
# or
docker compose logs -f web runner
```

## Next steps

1. [Install a Slack app](/guides/slack-install) — create the Slack app and get your tokens
2. [Create your first agent](/guides/create-agent) — walk through the 5-step wizard
3. [Set up a Boss team](/guides/boss-team) — build an orchestrated multi-agent team
