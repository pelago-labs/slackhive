---
title: Creating Your First Agent
description: Walk through the 5-step agent creation wizard
sidebar_position: 1
---

# Creating Your First Agent

Agents are created through a 5-step wizard in the dashboard. Each step maps to a distinct area of configuration: identity, Slack app, credentials, tools, and a final review. Boss agents skip step 4 (Tools) because their `CLAUDE.md` is auto-generated from the team registry.

Open the dashboard at [http://localhost:3001](http://localhost:3001) and click **New Agent**.

---

## Step 1: Name & Role

| Field | Description |
|---|---|
| **Name** | Display name for the agent (e.g. "Data Analyst") |
| **Slug** | URL-safe identifier used internally (e.g. `data-analyst`). Auto-generated from name. |
| **Description** | One or two sentences describing what this agent does. Shown in the team registry. |
| **Persona** | The system-level character the agent takes on. Injected into `CLAUDE.md` as its core identity. |
| **Model** | `claude-opus-4-6`, `claude-sonnet-4-6`, or `claude-haiku-4-5` |
| **Is Boss** | Toggle on if this agent should orchestrate others. Boss agents get an auto-generated team registry in their `CLAUDE.md`. |

**Choosing a model:**
- `opus-4-6` — highest capability, higher cost. Use for complex reasoning, bosses.
- `sonnet-4-6` — best balance of capability and speed. Good default.
- `haiku-4-5` — fastest and cheapest. Use for high-volume, simple tasks.

---

## Step 2: Slack App

SlackHive generates a Slack app manifest for you. To use it:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From an app manifest**
3. Select your workspace
4. Paste in the generated manifest (YAML format) and click **Next**
5. Review the permissions and click **Create**

The manifest pre-configures all required OAuth scopes, event subscriptions, and Socket Mode. See [Installing the Slack App](/guides/slack-install) for the full scope list.

---

## Step 3: Credentials

After creating the Slack app you need three tokens. Here is where to find each one:

| Field | Where to find it |
|---|---|
| **Bot Token** (`xoxb-...`) | Slack app → **OAuth & Permissions** → **Bot User OAuth Token**. Click **Install to Workspace** first if it is not present. |
| **App Token** (`xapp-...`) | Slack app → **Basic Information** → **App-Level Tokens**. Click **Generate Token and Scopes**, add the `connections:write` scope, and copy the token. |
| **Signing Secret** | Slack app → **Basic Information** → **App Credentials** → **Signing Secret** |

All three tokens are stored encrypted in the database and never returned via the API after saving.

---

## Step 4: Tools

:::note
Boss agents skip this step. Their `CLAUDE.md` is auto-generated from the team registry.
:::

**Skills**

Choose a starter template for the agent's skills:

| Template | Contents |
|---|---|
| **Blank** | No pre-built skills |
| **Data Analyst** | SQL query helpers, chart generation prompts, summarization |
| **Writer** | Drafting, editing, tone adjustment, research synthesis |
| **Developer** | Code review, PR description, bug triage, documentation |

You can add, edit, and reorder skills after creation from the agent's **Skills** tab.

**MCP Servers**

Select MCP servers from the catalog to attach to this agent. MCP servers give the agent access to external tools — databases, APIs, file systems, and more. You must add servers to the catalog first (Settings → MCP Catalog) before assigning them here.

See [Connecting MCP Servers](/guides/mcp-setup) for instructions.

---

## Step 5: Review

Review a summary of all configuration. Click **Create Agent** to finalize.

After creation:

- The Runner service starts a Bolt Socket Mode process for the agent
- The agent comes online in Slack within a few seconds
- The agent's status shows as **Running** in the dashboard

Invite the agent's bot user to a channel with `/invite @agent-name` and send it a message to verify it is working.

---

## After creation

The agent's detail page has several tabs:

| Tab | Contents |
|---|---|
| **Overview** | Status, model, persona, description |
| **Skills** | Add/edit/reorder skill files |
| **Memory** | View, filter, and delete memory entries |
| **MCP** | Manage attached MCP servers |
| **Jobs** | Scheduled jobs for this agent |
| **History** | Version snapshots with diff viewer |
| **Logs** | Live-streaming Docker logs |
| **Settings** | Edit all agent fields, channel restrictions, per-user access |

Any change to skills, MCP assignments, or `CLAUDE.md` triggers an auto-snapshot. You can restore any snapshot from the History tab.
