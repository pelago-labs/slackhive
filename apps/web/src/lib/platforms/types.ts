/**
 * @fileoverview Platform-provisioner abstraction for automated agent onboarding.
 *
 * A PlatformProvisioner encapsulates everything platform-specific about creating
 * a chat-platform app for an agent and capturing its runtime credentials, so the
 * API routes and the onboarding UI stay platform-neutral. Adding a new platform
 * (discord, teams, ...) means implementing this interface in a sibling folder and
 * registering it in ./index.ts — no route or schema changes.
 *
 * @module web/lib/platforms/types
 */

import type { Agent } from '@slackhive/shared';

/** Result of auto-creating the platform app for an agent. */
export interface ProvisionResult {
  /** Platform-side app id (Slack: A0…). */
  appId: string;
  /** True when the platform can redirect back to us to capture the bot token
   *  automatically (Slack: https origin registered as an OAuth redirect URL). */
  oauthRedirectRegistered: boolean;
  /** Where the UI should send the admin for the install/approval step. Either an
   *  internal route (automated OAuth) or an external platform URL (degraded flow). */
  installUrl: string;
}

/** Thrown by provisioners for user-actionable failures; routes map code → HTTP. */
export class ProvisionError extends Error {
  constructor(
    /** 'not_configured' → 501, 'invalid_config_token' → 502, 'platform_rejected' → 422 */
    public code: 'not_configured' | 'invalid_config_token' | 'platform_rejected',
    message: string,
    /** Optional platform-reported details (e.g. Slack manifest validation errors). */
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface PlatformProvisioner {
  /** Platform id — must match the platform_integrations CHECK constraint. */
  readonly platform: 'slack' | 'discord' | 'telegram' | 'whatsapp' | 'teams';

  /** Whether the one-time platform-level automation credential is set up. */
  isConfigured(): Promise<boolean>;

  /**
   * Auto-create the platform app for the agent and persist app metadata.
   * @param agent - The agent to provision.
   * @param origin - The web app origin (proto://host) for callback registration.
   */
  provision(agent: Agent, origin: string): Promise<ProvisionResult>;

  /**
   * Build the platform authorize URL for the install/approval step and stash the
   * single-use state. Returns null when the agent has no provisioned app.
   */
  buildInstallRedirect(agentId: string, origin: string): Promise<string | null>;
}
