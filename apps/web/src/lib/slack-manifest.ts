/**
 * @fileoverview Slack app manifest generator for the agent onboarding wizard.
 *
 * Generates a Slack app manifest JSON that users can paste directly into
 * api.slack.com/apps to create a new Slack app with the correct permissions
 * and configuration for a Claude Code agent.
 *
 * @module web/lib/slack-manifest
 */

import type { SlackAppManifest } from '@slackhive/shared';
import { DEFAULT_SLACK_BOT_SCOPES, BOSS_ADDITIONAL_SCOPES } from '@slackhive/shared';

/**
 * Generates a complete Slack app manifest for an agent.
 *
 * The manifest is pre-configured with:
 * - The agent's display name and description
 * - All required OAuth bot scopes
 * - Socket Mode enabled (required for the Bolt App)
 * - Subscriptions to app_mention, message.im, and member_joined_channel events
 *
 * @param {object} opts - Manifest generation options.
 * @param {string} opts.name - Agent display name.
 * @param {string} [opts.description] - Short description of the agent.
 * @param {boolean} [opts.isBoss] - Whether this is the boss agent (adds extra scopes).
 * @returns {SlackAppManifest} Complete Slack app manifest object.
 *
 * @example
 * const manifest = generateSlackManifest({ name: 'GILFOYLE', description: 'Data analyst' });
 * // Copy JSON to api.slack.com/apps → Create from Manifest
 */
export function generateSlackManifest(opts: {
  name: string;
  description?: string;
  isBoss?: boolean;
}): SlackAppManifest {
  const scopes = opts.isBoss
    ? [...DEFAULT_SLACK_BOT_SCOPES, ...BOSS_ADDITIONAL_SCOPES]
    : [...DEFAULT_SLACK_BOT_SCOPES];

  // Deduplicate scopes
  const uniqueScopes = [...new Set(scopes)];

  return {
    display_information: {
      name: opts.name,
      description: opts.description ?? `${opts.name} — Claude Code AI agent`,
      background_color: '#1a1a1a',
    },
    features: {
      bot_user: {
        display_name: opts.name,
        always_online: true,
      },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: uniqueScopes,
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          'app_mention',
          'message.channels',
          'message.groups',
          'message.im',
          'member_joined_channel',
        ],
      },
      interactivity: {
        is_enabled: false,
      },
      socket_mode_enabled: true,
      token_rotation_enabled: false,
      org_deploy_enabled: false,
    },
  };
}
