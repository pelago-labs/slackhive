/**
 * @fileoverview Unit tests for slack-manifest.ts — generateSlackManifest.
 *
 * Verifies manifest structure, scope assignment, deduplication, and defaults
 * for both regular and boss agents.
 *
 * No database or network required.
 *
 * @module web/lib/__tests__/slack-manifest.test
 */

import { describe, it, expect } from 'vitest';
import { generateSlackManifest } from '@/lib/slack-manifest';
import { DEFAULT_SLACK_BOT_SCOPES, BOSS_ADDITIONAL_SCOPES } from '@slackhive/shared';

// ─── generateSlackManifest ────────────────────────────────────────────────────

describe('generateSlackManifest', () => {
  it('sets display name from opts.name', () => {
    const m = generateSlackManifest({ name: 'DataBot' });
    expect(m.display_information.name).toBe('DataBot');
    expect(m.features.bot_user.display_name).toBe('DataBot');
  });

  it('uses provided description in display_information', () => {
    const m = generateSlackManifest({ name: 'Bot', description: 'My custom description' });
    expect(m.display_information.description).toBe('My custom description');
  });

  it('generates default description from name when description is omitted', () => {
    const m = generateSlackManifest({ name: 'DataBot' });
    expect(m.display_information.description).toBe('DataBot — Claude Code AI agent');
  });

  it('includes all DEFAULT_SLACK_BOT_SCOPES for a non-boss agent', () => {
    const m = generateSlackManifest({ name: 'Bot', isBoss: false });
    for (const scope of DEFAULT_SLACK_BOT_SCOPES) {
      expect(m.oauth_config.scopes.bot).toContain(scope);
    }
  });

  it('includes boss scopes in addition to default scopes for boss agent', () => {
    const m = generateSlackManifest({ name: 'Boss', isBoss: true });
    const allExpected = [...new Set([...DEFAULT_SLACK_BOT_SCOPES, ...BOSS_ADDITIONAL_SCOPES])];
    for (const scope of allExpected) {
      expect(m.oauth_config.scopes.bot).toContain(scope);
    }
  });

  it('does not include boss scopes for non-boss agent', () => {
    const bossOnlyScopes = BOSS_ADDITIONAL_SCOPES.filter(s => !DEFAULT_SLACK_BOT_SCOPES.includes(s));
    const m = generateSlackManifest({ name: 'Bot', isBoss: false });
    for (const scope of bossOnlyScopes) {
      expect(m.oauth_config.scopes.bot).not.toContain(scope);
    }
  });

  it('deduplicates scopes — no scope appears twice', () => {
    const m = generateSlackManifest({ name: 'Boss', isBoss: true });
    const scopes = m.oauth_config.scopes.bot;
    const unique = [...new Set(scopes)];
    expect(scopes.length).toBe(unique.length);
  });

  it('enables socket_mode', () => {
    const m = generateSlackManifest({ name: 'Bot' });
    expect(m.settings.socket_mode_enabled).toBe(true);
  });

  it('subscribes to all required bot events', () => {
    const m = generateSlackManifest({ name: 'Bot' });
    const events = m.settings.event_subscriptions.bot_events;
    expect(events).toContain('app_mention');
    expect(events).toContain('message.im');
    expect(events).toContain('message.channels');
    expect(events).toContain('message.groups');
    expect(events).toContain('member_joined_channel');
  });

  it('sets bot always_online to true', () => {
    const m = generateSlackManifest({ name: 'Bot' });
    expect(m.features.bot_user.always_online).toBe(true);
  });

  it('enables interactivity (for the feedback note button + modal)', () => {
    const m = generateSlackManifest({ name: 'Bot' });
    expect(m.settings.interactivity.is_enabled).toBe(true);
  });

  it('enables the assistant_view feature (for native feedback_buttons)', () => {
    const m = generateSlackManifest({ name: 'Bot', description: 'A helper' });
    expect(m.features.assistant_view?.assistant_description).toBe('A helper');
  });

  it('includes the assistant:write scope (required by Agents & AI Apps)', () => {
    const m = generateSlackManifest({ name: 'Bot' });
    expect(m.oauth_config.scopes.bot).toContain('assistant:write');
  });

  it('disables token rotation', () => {
    const m = generateSlackManifest({ name: 'Bot' });
    expect(m.settings.token_rotation_enabled).toBe(false);
  });

  it('treats isBoss=undefined the same as isBoss=false (no extra scopes)', () => {
    const withFalse = generateSlackManifest({ name: 'Bot', isBoss: false });
    const withUndefined = generateSlackManifest({ name: 'Bot' });
    expect(withFalse.oauth_config.scopes.bot).toEqual(withUndefined.oauth_config.scopes.bot);
  });

  it('sets background_color to #1a1a1a', () => {
    const m = generateSlackManifest({ name: 'Bot' });
    expect(m.display_information.background_color).toBe('#1a1a1a');
  });
});

// ─── OAuth redirect registration (automated onboarding) ──────────────────────

describe('generateSlackManifest redirect_urls', () => {
  it('omits redirect_urls when redirectUrl is not passed', () => {
    const m = generateSlackManifest({ name: 'Bot' });
    expect(m.oauth_config.redirect_urls).toBeUndefined();
  });

  it('registers redirect_urls when redirectUrl is passed', () => {
    const m = generateSlackManifest({ name: 'Bot', redirectUrl: 'https://hive.example.com/api/slack/install/callback' });
    expect(m.oauth_config.redirect_urls).toEqual(['https://hive.example.com/api/slack/install/callback']);
  });

  it('leaves scopes unchanged when redirectUrl is passed', () => {
    const withUrl = generateSlackManifest({ name: 'Bot', redirectUrl: 'https://x.example/cb' });
    const without = generateSlackManifest({ name: 'Bot' });
    expect(withUrl.oauth_config.scopes.bot).toEqual(without.oauth_config.scopes.bot);
  });
});
