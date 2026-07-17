# Cancel on Deleted Slack Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cancel an in-flight agent run when its triggering Slack message is deleted and visibly report the cancellation as a new message.

**Architecture:** Normalize message-deletion events at the platform adapter boundary. Track active runs by source message, abort and tombstone a matching run, and guard all later response paths against posting.

**Tech Stack:** TypeScript, Slack Bolt, Vitest, npm workspaces.

## Global Constraints

- The feature applies to every SlackHive agent without configuration.
- Cancellation notice text is exactly `⛔ Request cancelled because the original message was deleted.`
- Notices are always non-threaded in channels and DMs.
- Do not add an activity-status migration or delete already-posted output.

---

### Task 1: Normalize Message Deletion Events

**Files:**
- Modify: `packages/shared/src/platform.ts`
- Modify: `apps/runner/src/adapters/slack-adapter.ts`
- Test: `apps/runner/src/__tests__/slack-message-deleted.test.ts`

**Interfaces:**
- Produces: `MessageDeletedEvent { channelId: string; messageId: string }`
- Produces: optional `PlatformAdapter.onMessageDeleted(handler: (event: MessageDeletedEvent) => Promise<void>): void`

- [ ] Write a Slack adapter test that captures the registered `message_deleted` handler and expects `{ channelId: 'C1', messageId: '123.456' }`.
- [ ] Run `npm test -w apps/runner -- src/__tests__/slack-message-deleted.test.ts` and verify the test fails because the callback API is missing.
- [ ] Add `MessageDeletedEvent`, the optional adapter callback, Slack callback storage, and Slack subtype registration.
- [ ] Rerun the focused test and verify it passes.

### Task 2: Cancel and Tombstone the Matching Run

**Files:**
- Modify: `apps/runner/src/message-handler.ts`
- Test: `apps/runner/src/__tests__/message-handler-deletion.test.ts`

**Interfaces:**
- Consumes: normalized `MessageDeletedEvent`
- Produces: `MessageHandler.cancelByDeletedMessage(channelId: string, messageId: string): Promise<boolean>`

- [ ] Write failing tests for matching, unrelated, and duplicate deletions. Assert controller abort, exactly one non-threaded cancellation notice, no fallback/final payload, and no post-deletion reaction update.
- [ ] Add a failing race test where deletion arrives immediately before active-run registration.
- [ ] Run `npm test -w apps/runner -- src/__tests__/message-handler-deletion.test.ts` and verify the feature assertions fail.
- [ ] Introduce a small active-run record with source key, controller, and deletion flag; index it by session and source message with identity-guarded cleanup. Add a bounded 60-second deletion tombstone for pre-registration races.
- [ ] Implement `cancelByDeletedMessage`, set the deletion flag before aborting, and post the exact notice without a thread ID.
- [ ] Guard response-posting paths and route deletion abort cleanup to `error` with `cancelled: source message deleted` while skipping reactions.
- [ ] Rerun deletion and existing abort tests and verify they pass.

### Task 3: Wire the Runner and Verify

**Files:**
- Modify: `apps/runner/src/agent-runner.ts`
- Modify: `docs/superpowers/specs/2026-07-17-cancel-on-deleted-message-design.md` only if implementation reveals a necessary correction

**Interfaces:**
- Consumes: `PlatformAdapter.onMessageDeleted` and `MessageHandler.cancelByDeletedMessage`

- [ ] Wire the optional deletion callback next to `adapter.onMessage` for live agents only.
- [ ] Run `npm run build -w packages/shared && npm run build -w apps/runner` and verify both TypeScript builds pass.
- [ ] Run the focused deletion and abort tests.
- [ ] Run `npm test -w apps/runner`; confirm no new failures relative to the 665/666 baseline.
- [ ] Inspect `git diff --check` and `git status --short`, then commit the feature with `feat(runner): cancel runs when Slack messages are deleted`.
