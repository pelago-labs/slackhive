/**
 * @fileoverview Platform adapter factory.
 * Maps a platform integration row to the correct adapter implementation.
 *
 * @module runner/adapters
 */

import type { PlatformAdapter, SlackCredentials, TelegramCredentials } from '@slackhive/shared';
import { SlackAdapter } from './slack-adapter';
import { TelegramAdapter } from './telegram-adapter';

/**
 * Creates the appropriate platform adapter based on the integration's platform field.
 *
 * @param integration - The platform integration row (platform + decrypted credentials).
 * @param agentSlug - Used for scoped logging inside the adapter.
 */
export function createAdapter(
  integration: { platform: string; credentials: Record<string, string> },
  agentSlug: string,
): PlatformAdapter {
  switch (integration.platform) {
    case 'slack':
      return new SlackAdapter(integration.credentials as unknown as SlackCredentials, agentSlug);
    case 'telegram':
      return new TelegramAdapter(integration.credentials as unknown as TelegramCredentials, agentSlug);
    default:
      throw new Error(`Unsupported platform: ${integration.platform}`);
  }
}
