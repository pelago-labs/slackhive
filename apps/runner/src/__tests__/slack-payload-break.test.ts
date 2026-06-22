/**
 * @fileoverview Unit tests for the PAYLOAD_BREAK marker in SlackAdapter.buildPayloads.
 *
 * The marker lets an agent force a payload boundary the table/length splitter
 * wouldn't otherwise create — e.g. between a leading summary and the first
 * table — so on a threading platform the summary becomes the parent and the
 * tables thread beneath it. The marker must always be stripped from output.
 *
 * @module runner/__tests__/slack-payload-break
 */

import { describe, it, expect } from 'vitest';
import { SlackAdapter } from '../adapters/slack-adapter';
import { TestAdapter } from '../adapters/test-adapter';
import { PAYLOAD_BREAK } from '@slackhive/shared';

// buildPayloads is pure (no Bolt App until start()), so a bare instance is safe.
function slackAdapter(): SlackAdapter {
  return new SlackAdapter(
    { platform: 'slack', botToken: 'x', appToken: 'y', signingSecret: 'z' } as any,
    'test-agent',
  );
}

const TABLE = ['| Metric | Value |', '| --- | --- |', '| KF Customers | 721 |'].join('\n');

describe('SlackAdapter.buildPayloads — PAYLOAD_BREAK', () => {
  it('splits a leading summary from the following table into separate payloads', () => {
    const text = `Headline summary line.\n${PAYLOAD_BREAK}\n*L1.1*\n${TABLE}`;
    const payloads = slackAdapter().buildPayloads(text);

    expect(payloads).toHaveLength(2);
    // First payload: summary only — no table content, marker stripped.
    expect(payloads[0].text).toContain('Headline summary line.');
    expect(payloads[0].text).not.toContain('721');
    expect(payloads[0].text).not.toContain(PAYLOAD_BREAK);
    expect(payloads[0].blocks).toBeUndefined();
    // Second payload: the table.
    expect(payloads[1].text).toContain('721');
    expect(payloads[1].blocks).toBeDefined();
  });

  it('is a no-op without the marker (leading text still glues to the first table)', () => {
    const payloads = slackAdapter().buildPayloads(`Summary.\n${TABLE}`);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].text).toContain('Summary.');
    expect(payloads[0].text).toContain('721');
  });

  it('never leaks the marker into output, even on the no-table path', () => {
    const payloads = slackAdapter().buildPayloads(`alpha${PAYLOAD_BREAK}beta`);
    expect(payloads).toHaveLength(2);
    for (const p of payloads) expect(p.text).not.toContain(PAYLOAD_BREAK);
  });
});

describe('TestAdapter.buildPayloads — PAYLOAD_BREAK', () => {
  it('splits on the marker and strips it', () => {
    const adapter = new TestAdapter(() => {});
    const payloads = adapter.buildPayloads(`alpha${PAYLOAD_BREAK}beta`);
    expect(payloads).toHaveLength(2);
    expect(payloads[0].text).toBe('alpha');
    expect(payloads[1].text).toBe('beta');
  });

  it('returns the text unchanged when the marker is absent', () => {
    const adapter = new TestAdapter(() => {});
    expect(adapter.buildPayloads('plain')).toEqual([{ text: 'plain' }]);
  });
});
