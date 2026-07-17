import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AgentRunner deletion-event wiring', () => {
  it('routes live platform deletion events to the message handler', () => {
    const source = readFileSync(new URL('../agent-runner.ts', import.meta.url), 'utf8');

    expect(source).toMatch(
      /adapter\.onMessageDeleted\?\.\(async event\s*=>\s*\{\s*await messageHandler\.cancelByDeletedMessage\(event\.channelId,\s*event\.messageId\);\s*\}\)/,
    );
  });
});
