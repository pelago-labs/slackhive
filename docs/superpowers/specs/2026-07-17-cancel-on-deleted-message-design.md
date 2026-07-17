# Cancel Agent Runs When Source Messages Are Deleted

## Goal

When a Slack user deletes a message that is still being processed, stop that agent run and post one visible, non-threaded cancellation notice. This is platform behavior shared by every SlackHive agent, not an agent setting.

## User Experience

- In a DM, the agent posts the next normal message: `⛔ Request cancelled because the original message was deleted.`
- In a channel, the agent posts the same text as a new top-level channel message.
- Only the agent actively processing the exact deleted message posts the notice.
- If the run already finished, SlackHive does nothing. Completed answers are not removed retroactively.
- Output already posted in verbose mode remains visible. No output is posted after cancellation is observed.
- Completed external tool side effects are not rolled back.

## Architecture

Extend `PlatformAdapter` with an optional `onMessageDeleted` callback carrying a normalized `{ channelId, messageId }` event. `SlackAdapter` translates Slack's `message_deleted` subtype using `channel` and `deleted_ts`. `AgentRunner` wires that callback to the agent's existing `MessageHandler`.

`MessageHandler` tracks each active run by both session key and source message key. A deletion matching an active source message marks the run as deleted before aborting its `AbortController`; the flag is the late-post guard. The cancellation handler immediately posts the non-threaded notice. Normal abort cleanup records the activity as `error` with `cancelled: source message deleted`, because adding a new activity status would require an unrelated database and dashboard migration.

A bounded 60-second tombstone cache covers Slack delivering the deletion while the original handler is still in access/setup awaits, before its active-run index exists. When that message later registers, it is cancelled before reactions, prompt construction, or backend execution.

## Concurrency and Failure Handling

- Mark the run cancelled before calling `abort()` so code already resuming from an awaited operation cannot post normally.
- Keep existing session-key preemption semantics unchanged.
- Remove active-run indexes with identity checks so an older run cannot delete a newer run's entry.
- Repeated or unrelated deletion events are no-ops after the first matching cancellation.
- Skip reaction changes for deletion cancellation because the source Slack message no longer exists.
- Log cancellation-notice posting failures, but still abort the run.
- A Slack API call already in flight at deletion time cannot be recalled. All later posting paths must check the run flag.

## Testing

- Adapter test: Slack `message_deleted` normalizes `channel` and `deleted_ts`.
- Handler tests: matching deletion aborts, posts exactly one top-level notice, and suppresses fallback/final output and reaction changes.
- Handler tests: unrelated and duplicate deletions do nothing.
- Regression tests: ordinary same-thread preemption and normal completion remain unchanged.
- Type-check and run the focused runner test suite, then the full runner suite while documenting the known process-environment baseline failure if it persists.
