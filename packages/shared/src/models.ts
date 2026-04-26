/**
 * @fileoverview Supported Claude model IDs, shared between the web UI
 * (agent wizard, Settings page) and the runner (Coach).
 *
 * Hardcoded because Anthropic's `GET /v1/models` endpoint requires an API key
 * and SlackHive authenticates via the Claude Code subscription OAuth flow —
 * there is no subscription-compatible way to enumerate models at runtime.
 * Update this list when a new model ships.
 *
 * @module @slackhive/shared/models
 */

export interface ModelOption {
  /** Full Anthropic model ID passed to the Agent SDK. */
  value: string;
  /** Human-readable name for the picker. */
  label: string;
  /** Short tagline shown under the label. */
  sub: string;
}

export const MODELS: readonly ModelOption[] = [
  { value: 'claude-opus-4-6',           label: 'Opus 4.6',   sub: 'Most capable' },
  { value: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', sub: 'Balanced' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  sub: 'Fastest' },
];

/** Default model assigned to a newly created agent. */
export const DEFAULT_AGENT_MODEL = 'claude-opus-4-6';

/** Default model used by the Coach feature when the user hasn't picked one. */
export const DEFAULT_COACH_MODEL = 'claude-sonnet-4-6';

/** Settings-table key storing the admin's Coach model choice. */
export const COACH_MODEL_SETTING_KEY = 'coachModel';
