# Contributing to SlackHive

Thank you for your interest in contributing to SlackHive! This document covers everything you need to get started. For a general introduction to contributing on GitHub, see the [GitHub contributing guide](https://docs.github.com/en/get-started/exploring-projects-on-github/contributing-to-a-project).

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development Setup](#local-development-setup)
- [Repository Structure](#repository-structure)
- [Branch Naming](#branch-naming)
- [Commit Style](#commit-style)
- [Pull Request Process](#pull-request-process)
- [Code Standards](#code-standards)
- [Reporting Bugs and Requesting Features](#reporting-bugs-and-requesting-features)

---

## Prerequisites

Before you begin, ensure the following tools are installed:

| Tool | Minimum Version | Notes |
|------|----------------|-------|
| [Docker](https://docs.docker.com/get-docker/) | 24+ | Required for running Postgres, Redis, and the full stack |
| [Docker Compose](https://docs.docker.com/compose/install/) | v2.20+ | Bundled with Docker Desktop |
| [Node.js](https://nodejs.org/) | 20+ | Used for running apps locally outside Docker |
| [git](https://git-scm.com/) | 2.38+ | |

> **Note:** Never run `npm`/`node` directly on your host machine for production-style testing — always use Docker or `docker compose` for infrastructure services (Postgres, Redis).

---

## Local Development Setup

### 1. Fork and clone the repository

```bash
# Fork via GitHub UI, then clone your fork
git clone https://github.com/<your-username>/slackhive.git
cd slackhive

# Add the upstream remote
git remote add upstream https://github.com/pelago-labs/slackhive.git
```

### 2. Set up environment variables

Each app has its own `.env` file. Start from the provided examples:

```bash
cp apps/web/.env.example apps/web/.env
cp apps/runner/.env.example apps/runner/.env
```

Edit each `.env` with your Slack app credentials, Anthropic API key, and other required values. Refer to the `README.md` for a description of each variable.

### 3. Start infrastructure services

```bash
docker compose up postgres redis -d
```

This starts Postgres and Redis in the background. They will be available on their default ports.

### 4. Install dependencies

```bash
npm install
```

This installs dependencies for all workspaces (`apps/web`, `apps/runner`, `packages/shared`, `cli`) via npm workspaces.

### 5. Build the shared package

The shared package must be built before dependent apps can start:

```bash
npm run build --workspace=packages/shared
```

### 6. Run database migrations

```bash
# Inside the web app
cd apps/web && npx prisma migrate dev
```

### 7. Start the development servers

Open separate terminals for each app:

```bash
# Terminal 1 — Next.js web app
cd apps/web && npm run dev

# Terminal 2 — Node runner
cd apps/runner && npm run dev
```

The web app is available at [http://localhost:3000](http://localhost:3000) by default.

---

## Repository Structure

```
slackhive/
├── apps/
│   ├── web/          # Next.js web application (dashboard, API routes)
│   └── runner/       # Node.js agent runner
├── packages/
│   └── shared/       # Shared TypeScript types and utilities
├── cli/              # SlackHive CLI tool
├── scripts/          # Development helper scripts
└── docker-compose.yml
```

---

## Branch Naming

Use the following prefixes for all branches, branched from `main`:

| Prefix | Use for |
|--------|---------|
| `feat/` | New features (e.g., `feat/agent-memory-viewer`) |
| `fix/` | Bug fixes (e.g., `fix/slack-oauth-redirect`) |
| `chore/` | Maintenance, deps, tooling (e.g., `chore/update-prisma`) |
| `docs/` | Documentation only (e.g., `docs/setup-guide`) |

---

## Commit Style

SlackHive uses [Conventional Commits](https://www.conventionalcommits.org/). Each commit message must follow this format:

```
<type>(<optional scope>): <short description>

[optional body]

[optional footer]
```

**Types:**

| Type | Description |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `chore` | Build process, tooling, or dependency updates |
| `docs` | Documentation changes only |
| `refactor` | Code change that is neither a fix nor a feature |
| `test` | Adding or updating tests |
| `perf` | Performance improvements |
| `ci` | CI configuration changes |

**Examples:**

```
feat(web): add per-agent write access control toggle
fix(runner): resolve race condition in job scheduler
chore: upgrade Prisma to 5.14
docs: add CONTRIBUTING guide
```

Keep the subject line under 72 characters and use the imperative mood ("add", not "added" or "adds").

---

## Pull Request Process

1. **Fork** the repository and create your branch from `main`.
2. **Implement** your changes following the code standards below.
3. **Test** your changes locally with `docker compose up postgres redis -d` and the dev servers running.
4. **Push** your branch to your fork.
5. **Open a PR** against the `main` branch of `pelago-labs/slackhive`.
6. Fill in the **PR template** completely, including screenshots for any UI changes.
7. Address any review feedback.

PRs should be focused — one logical change per PR. Large refactors should be discussed in a GitHub Discussion or Issue first.

**Merging:** Maintainers merge PRs using squash-and-merge to keep the commit history clean.

---

## Code Standards

- **TypeScript** — all code must be fully typed; avoid `any` unless strictly necessary.
- **Docstrings** — use [TSDoc](https://tsdoc.org/) / JSDoc-style comments for all exported functions, classes, and types (Google-style param/return descriptions).
- **Formatting** — the project uses ESLint and Prettier. Run `npm run lint` in the relevant workspace before submitting.
- **No secrets** — never commit API keys, tokens, or credentials. Use `.env` files (already `.gitignore`d).

---

## Reporting Bugs and Requesting Features

- **Bugs:** Open a [bug report issue](https://github.com/pelago-labs/slackhive/issues/new?template=bug_report.yml).
- **Features:** Open a [feature request issue](https://github.com/pelago-labs/slackhive/issues/new?template=feature_request.yml).
- **Questions / discussions:** Use [GitHub Discussions](https://github.com/pelago-labs/slackhive/discussions).

Please do **not** use public issues to report security vulnerabilities. See [SECURITY.md](SECURITY.md) for the responsible disclosure process.
