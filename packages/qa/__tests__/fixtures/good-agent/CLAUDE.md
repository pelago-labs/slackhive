# Test Agent

A minimal valid agent used in loader unit tests.

## Step 0 — Detect Trigger

Before any other processing, classify the incoming message:

- **Trigger pattern `hello world` (case-insensitive)** → run greeting flow.
- See the [test skill](skills/test-skill.md) for details.
- The agent fetches context via `mcp__notion__notion-fetch` when needed.
- Refer to the [overview](wiki/test-entity.md) for canonical definitions.

## How It Works

Plain Q&A otherwise.
