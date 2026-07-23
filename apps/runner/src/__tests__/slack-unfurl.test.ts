/**
 * @fileoverview Tests for media-link unfurling behavior:
 * - containsBareUrl / isMediaUrl helpers
 * - formatMarkdown unwrapping labeled MEDIA links to bare URLs
 * - postMessage/postPayload passing explicit unfurl flags on plain-text payloads
 * - attachFeedbackControls skipping the blocks rewrite when a bare URL is
 *   present (URLs inside blocks never unfurl — the rewrite killed GIF previews)
 *
 * @module runner/__tests__/slack-unfurl
 */

import { describe, it, expect, vi } from 'vitest';
import { SlackAdapter, containsBareUrl, isMediaUrl } from '../adapters/slack-adapter';

function slackAdapter(): SlackAdapter {
  return new SlackAdapter(
    { platform: 'slack', botToken: 'x', appToken: 'y', signingSecret: 'z' } as any,
    'test-agent',
  );
}

/** Injects a mocked Bolt client into the (un-started) adapter. */
function withMockClient(adapter: SlackAdapter) {
  const postMessage = vi.fn(async () => ({ ts: '1.1' }));
  const update = vi.fn(async () => ({}));
  (adapter as any).app = { client: { chat: { postMessage, update } } };
  return { postMessage, update };
}

const GIF = 'https://media.giphy.com/media/abc123/giphy.gif';

describe('isMediaUrl', () => {
  it('matches image/video extensions and media hosts', () => {
    expect(isMediaUrl(GIF)).toBe(true);
    expect(isMediaUrl('https://example.com/chart.png?v=2')).toBe(true);
    expect(isMediaUrl('https://tenor.com/view/some-gif-12345')).toBe(true);
    expect(isMediaUrl('https://example.com/report')).toBe(false);
    expect(isMediaUrl('https://example.com/page.html')).toBe(false);
  });
});

describe('containsBareUrl', () => {
  it('true for bare URLs, false for labeled-only links', () => {
    expect(containsBareUrl(`here you go\n${GIF}`)).toBe(true);
    expect(containsBareUrl('see <https://example.com/doc|the doc> for details')).toBe(false);
    expect(containsBareUrl('no links at all')).toBe(false);
    expect(containsBareUrl('plain <https://example.com/doc> angle link')).toBe(true);
  });
});

describe('formatMarkdown — media link unwrapping', () => {
  it('unwraps markdown-labeled media links to the bare URL', () => {
    expect(slackAdapter().formatMarkdown(`enjoy [party gif](${GIF})`)).toContain(`enjoy ${GIF}`);
  });
  it('unwraps Slack-labeled media links to the bare URL', () => {
    expect(slackAdapter().formatMarkdown(`enjoy <${GIF}|party gif>`)).toContain(`enjoy ${GIF}`);
  });
  it('leaves non-media labeled links labeled', () => {
    const out = slackAdapter().formatMarkdown('see [the doc](https://example.com/doc) and <https://example.com/dash|dashboard>');
    expect(out).toContain('[the doc](https://example.com/doc)');
    expect(out).toContain('<https://example.com/dash|dashboard>');
  });
});

describe('postMessage / postPayload — unfurl flags', () => {
  it('passes unfurl flags on plain-text payloads', async () => {
    const adapter = slackAdapter();
    const { postMessage } = withMockClient(adapter);
    await adapter.postMessage('C1', `here\n${GIF}`);
    const call = postMessage.mock.calls[0][0] as any;
    expect(call.unfurl_links).toBe(true);
    expect(call.unfurl_media).toBe(true);
    expect(call.blocks).toBeUndefined();
  });

  it('does not pass unfurl flags on blocks payloads', async () => {
    const adapter = slackAdapter();
    const { postMessage } = withMockClient(adapter);
    await adapter.postPayload('C1', { text: 'x', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }] });
    const call = postMessage.mock.calls[0][0] as any;
    expect(call.unfurl_links).toBeUndefined();
    expect(call.blocks).toBeDefined();
  });
});

describe('attachFeedbackControls — preserves unfurls', () => {
  it('skips the inline blocks rewrite when the reply has a bare URL', async () => {
    const adapter = slackAdapter();
    const { postMessage, update } = withMockClient(adapter);
    await adapter.attachFeedbackControls('C1', '1.1', { text: `gif for you\n${GIF}` }, undefined, { activityId: 'a1' });
    expect(update).not.toHaveBeenCalled();
    // Standalone rating message posted instead.
    expect(postMessage).toHaveBeenCalledTimes(1);
    const call = postMessage.mock.calls[0][0] as any;
    expect(call.text).toBe('Rate this response');
  });

  it('still attaches inline when the reply has no bare URL', async () => {
    const adapter = slackAdapter();
    const { postMessage, update } = withMockClient(adapter);
    await adapter.attachFeedbackControls('C1', '1.1', { text: 'plain answer' }, undefined, { activityId: 'a1' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
