---
title: Setting Up a Boss Team
description: Build an orchestrated multi-agent team with a Boss agent
sidebar_position: 2
---

# Setting Up a Boss Team

A Boss agent reads a registry of its team members and delegates tasks by @mentioning specialists in Slack threads. Specialists work independently and tag the boss back when done. The boss decides next steps and either delegates further or synthesizes a final response.

## What a Boss agent does

- Receives a request in Slack
- Identifies which specialist(s) can handle it
- Opens a thread and @mentions the specialist with a clear delegated task
- Waits for the specialist to complete and tag it back
- Reviews the result and either asks follow-up questions, delegates to another specialist, or delivers a final answer

The Boss's `CLAUDE.md` is **auto-generated** from the team registry. Every time you add a specialist or change a description, the boss's `CLAUDE.md` is updated automatically.

## Step 1: Create your specialists

Create your specialist agents first (see [Creating Your First Agent](/guides/create-agent)). For each specialist:

- Write a clear **description** — the boss uses this to decide when to delegate to each specialist
- Set **reportsTo** to the boss agent (you can set this after the boss is created)

## Step 2: Create the Boss agent

In the New Agent wizard:

1. Fill in **Name & Role** as normal
2. Toggle **Is Boss** on
3. Complete **Slack App** and **Credentials** as normal
4. Step 4 (Tools) is skipped — the boss does not need direct tools; it orchestrates via delegation
5. Review and create

## Step 3: Set reportsTo on specialists

Go to each specialist agent → **Settings** and set the **Reports To** field to your boss agent. This:

- Adds the specialist to the boss's auto-generated team registry
- Tells the specialist to tag the boss back when a task is complete

A specialist can report to multiple bosses. In that case, it appears in each boss's registry.

## How delegation works

When the boss receives a request:

```
User: @boss-agent Can you pull last week's revenue by region and write a summary?

Boss: I'll get started on that. Let me pull the data first.
      @data-agent Pull last week's revenue by region from Redshift and post
      the results here. Tag me when done.

Data Agent: Done, @boss-agent. Here are the results: [table]

Boss: Thanks. Now for the summary.
      @writer-agent Based on this data [table], write a 2-paragraph executive
      summary of regional performance. Tag me when done.

Writer Agent: Done, @boss-agent. Here's the summary: [text]

Boss: [Delivers final combined response to the user]
```

Everything happens in the original thread. The user sees the full flow or just the final answer, depending on how you configure the boss's persona.

## Multi-boss setup

An agent can report to more than one boss. Set multiple entries in the **Reports To** field. The agent will appear in each boss's team registry and will tag back whichever boss delegated the task (determined by context in the thread).

Use multi-boss setups when:
- A specialist's capability is needed by more than one team
- You have a meta-boss that coordinates other bosses
- You want redundancy in orchestration

## Viewing the team hierarchy

The dashboard **Team** view shows all boss/specialist relationships as a tree. Each node shows agent name, model, and current status. Clicking a node opens the agent detail page.

## Auto-generated CLAUDE.md

The boss's `CLAUDE.md` team registry section looks like this:

```markdown
## Your Team

You manage the following specialists. Delegate tasks by @mentioning them
in a Slack thread. Tell them to tag you back when complete.

- @data-analyst — Queries databases, analyzes data, produces charts and tables
- @writer — Drafts documents, summarizes content, adjusts tone and style
- @developer — Reviews code, describes pull requests, triages bugs
```

This section is regenerated automatically. Do not edit it manually — your changes will be overwritten on the next registry sync.
