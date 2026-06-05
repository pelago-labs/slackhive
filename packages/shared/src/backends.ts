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

export const DEFAULT_CODEX_MODEL = 'gpt-5.5';

/**
 * Curated list of Codex models for a ChatGPT-account login (subscription auth has
 * no models API). Codex exposes ONE flagship model (`gpt-5.5`) plus a reasoning
 * level — "Instant/Thinking" are NOT separate models (that's the ChatGPT app's
 * naming). We surface the reasoning levels as friendly choices and encode them as
 * `<model>:<effort>`; the runner splits that into `model` + `modelReasoningEffort`
 * (see splitCodexModel / buildThreadOptions). A bare `<model>` = the model's
 * default effort (medium). `gpt-5.4*` are legacy (the server migrates 5.4 → 5.5).
 * API-key auth bypasses this list (it gets the real /v1/models list from OpenAI).
 */
export const CODEX_MODELS: readonly ModelOption[] = [
  { value: 'gpt-5.5:low',   label: 'GPT-5.5 Instant',  sub: 'Fast, light reasoning' },
  { value: 'gpt-5.5',       label: 'GPT-5.5',          sub: 'Balanced (default)' },
  { value: 'gpt-5.5:high',  label: 'GPT-5.5 Thinking', sub: 'Deep reasoning' },
  { value: 'gpt-5.5:xhigh', label: 'GPT-5.5 Max',      sub: 'Max reasoning (slowest)' },
];

/** Valid Codex reasoning efforts (Codex SDK `ModelReasoningEffort`). */
export const CODEX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/**
 * Split a stored Codex model value into its model slug + optional reasoning
 * effort. Values are `<model>` or `<model>:<effort>` (e.g. `gpt-5.5:high`).
 * An unrecognized suffix is treated as part of the model (returned as-is).
 */
export function splitCodexModel(value: string | null | undefined): { model: string; effort?: CodexReasoningEffort } {
  const v = value ?? DEFAULT_CODEX_MODEL;
  const idx = v.indexOf(':');
  if (idx === -1) return { model: v };
  const model = v.slice(0, idx);
  const effort = v.slice(idx + 1) as CodexReasoningEffort;
  return (CODEX_REASONING_EFFORTS as readonly string[]).includes(effort) ? { model, effort } : { model: v };
}

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
