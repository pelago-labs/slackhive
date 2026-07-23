/**
 * @fileoverview Registry of platform provisioners. Routes and UI resolve
 * provisioners by platform id here; adding a platform (discord, teams, …) means
 * implementing PlatformProvisioner in a sibling folder and registering it below.
 *
 * @module web/lib/platforms
 */

import type { PlatformProvisioner } from './types';
import { slackProvisioner } from './slack/provision';

export { ProvisionError } from './types';
export type { PlatformProvisioner, ProvisionResult } from './types';

const PROVISIONERS: Partial<Record<PlatformProvisioner['platform'], PlatformProvisioner>> = {
  slack: slackProvisioner,
};

/** Returns the provisioner for a platform, or null when automation isn't available. */
export function getProvisioner(platform: string): PlatformProvisioner | null {
  return PROVISIONERS[platform as PlatformProvisioner['platform']] ?? null;
}
