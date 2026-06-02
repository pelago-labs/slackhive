/**
 * @fileoverview Backend (agent runtime) metadata shared between the web UI and
 * the runner: which backends exist, their selectable models, and the credential
 * fields the Settings page renders. The runner's `backends/` registry maps these
 * ids to concrete `AgentBackend` implementations; this file holds only the
 * provider-neutral metadata so the Settings UI can render itself from data.
 *
 * @module @slackhive/shared/backends
 */

import type { ModelOption } from './models';
import { MODELS } from './models';

/** Backend ids shipped in the first cut. Route-A presets (OpenRouter, local) add more later. */
export type BackendId = 'claude' | 'codex';

/** Settings-table key holding the operator's global backend choice. */
export const AGENT_BACKEND_SETTING_KEY = 'agentBackend';
/** Backend used when the operator hasn't chosen one — preserves today's behavior. */
export const DEFAULT_AGENT_BACKEND: BackendId = 'claude';

/** Settings-table key holding the chosen Codex model. */
export const CODEX_MODEL_SETTING_KEY = 'codexModel';
/** Settings-table key holding the chosen Codex auth mode ('subscription' | 'apiKey'). */
export const CODEX_AUTH_MODE_SETTING_KEY = 'codexAuthMode';
/** Settings-table key holding the chosen Claude auth mode ('subscription' | 'apiKey'). */
export const CLAUDE_AUTH_MODE_SETTING_KEY = 'claudeAuthMode';

export const DEFAULT_CODEX_MODEL = 'gpt-5-codex';

/** Codex model choices (subscription exposes GPT-5.5; API key path exposes codex models). */
export const CODEX_MODELS: readonly ModelOption[] = [
  { value: 'gpt-5.5',     label: 'GPT-5.5',     sub: 'Subscription (ChatGPT)' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex', sub: 'Coding-tuned' },
  { value: 'gpt-5',       label: 'GPT-5',       sub: 'General' },
];

export type BackendAuthMode = 'subscription' | 'apiKey';

/** One credential input the Settings form renders for a given auth mode. */
export interface BackendAuthField {
  /** Encrypted settings/secret key this value is stored under. */
  secretKey: string;
  /** Field label in the UI. */
  label: string;
  /** Input rendering hint. `json` = multiline paste (e.g. auth.json / credentials.json). */
  kind: 'password' | 'json' | 'text';
  /** Placeholder / helper text. */
  placeholder?: string;
}

export interface BackendAuthOption {
  mode: BackendAuthMode;
  label: string;
  /** Short note shown under the option (e.g. cost implication). */
  hint?: string;
  fields: BackendAuthField[];
}

/** Provider-neutral metadata describing a backend for the Settings UI. */
export interface BackendDescriptor {
  id: BackendId;
  label: string;
  /** 'sdk-harness' = full agentic SDK; 'model-provider' = Codex+custom provider preset (Route-A, later). */
  family: 'sdk-harness' | 'model-provider';
  /** Selectable models for this backend. */
  models: readonly ModelOption[];
  /** Settings key that stores the chosen model (null = backend has no model picker). */
  modelSettingKey: string | null;
  /** Settings key that stores the chosen auth mode. */
  authModeSettingKey: string;
  /** Available authentication options, each with the fields the form renders. */
  authOptions: readonly BackendAuthOption[];
}

export const BACKEND_DESCRIPTORS: readonly BackendDescriptor[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    family: 'sdk-harness',
    models: MODELS,
    modelSettingKey: null, // per-agent `agent.model` already governs the Claude model
    authModeSettingKey: CLAUDE_AUTH_MODE_SETTING_KEY,
    authOptions: [
      {
        mode: 'subscription',
        label: 'Claude subscription (login)',
        hint: 'Flat-rate. Paste ~/.claude/.credentials.json from a machine where you ran `claude login`.',
        fields: [
          { secretKey: 'CLAUDE_CREDENTIALS_JSON', label: 'credentials.json', kind: 'json', placeholder: '{ "claudeAiOauth": { "accessToken": "...", "refreshToken": "..." } }' },
        ],
      },
      {
        mode: 'apiKey',
        label: 'Anthropic API key',
        hint: 'Pay-per-token via the Anthropic API.',
        fields: [
          { secretKey: 'ANTHROPIC_API_KEY', label: 'ANTHROPIC_API_KEY', kind: 'password', placeholder: 'sk-ant-api03-...' },
        ],
      },
    ],
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    family: 'sdk-harness',
    models: CODEX_MODELS,
    modelSettingKey: CODEX_MODEL_SETTING_KEY,
    authModeSettingKey: CODEX_AUTH_MODE_SETTING_KEY,
    authOptions: [
      {
        mode: 'subscription',
        label: 'ChatGPT subscription (login)',
        hint: 'Flat-rate; required for GPT-5.5. Paste ~/.codex/auth.json (run `codex login` or `codex login --device-auth`).',
        fields: [
          { secretKey: 'CODEX_AUTH_JSON', label: 'auth.json', kind: 'json', placeholder: '{ "auth_mode": "chatgpt", "tokens": { ... } }' },
        ],
      },
      {
        mode: 'apiKey',
        label: 'OpenAI API key',
        hint: 'Pay-per-token. Not valid for GPT-5.5 (subscription-only).',
        fields: [
          { secretKey: 'OPENAI_API_KEY', label: 'OPENAI_API_KEY', kind: 'password', placeholder: 'sk-...' },
        ],
      },
    ],
  },
];

export function getBackendDescriptor(id: string): BackendDescriptor | undefined {
  return BACKEND_DESCRIPTORS.find((b) => b.id === id);
}
