/**
 * @fileoverview Agent backend interface for multi-runtime support.
 *
 * The messaging side (MessageHandler, adapters, memory, MCP) is runtime-agnostic.
 * Each agent *runtime* — Claude Code (`@anthropic-ai/claude-agent-sdk`), OpenAI
 * Codex (`@openai/codex-sdk`), or a future harness — implements `AgentBackend`.
 * This mirrors {@link PlatformAdapter} (one interface in shared, concrete impls
 * in the runner under `backends/`, selected at instantiation in agent-runner).
 *
 * The neutral {@link BackendMessage} union is *structurally identical to what
 * `message-handler.ts` already reads* off the Claude SDK stream, so a backend
 * only has to emit these shapes — the message handler needs no per-backend logic.
 *
 * @module @slackhive/shared/agent-backend
 */

// =============================================================================
// Streamed message contract (what MessageHandler consumes)
// =============================================================================

/** Assistant content block: model text, reasoning, or a tool invocation. */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking'; data?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

/** User content block: paired tool result for a prior tool_use. */
export type UserBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
};

/**
 * Token usage in the shape `recordActivityUsage` (ActivityUsageInput) expects.
 * Backends map their native usage onto these keys.
 */
export interface BackendUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Neutral streamed message. Mirrors the Claude SDK `SDKMessage` subset that
 * `message-handler.ts` reads via `message.type` + `message.message.content`.
 * Extra fields are allowed (Claude yields raw `SDKMessage`, which conforms).
 */
export type BackendMessage =
  | { type: 'assistant'; message: { role: 'assistant'; content: AssistantBlock[] }; [k: string]: unknown }
  | { type: 'user'; message: { role: 'user'; content: UserBlock[] }; [k: string]: unknown }
  | {
      type: 'result';
      subtype?: string;
      result?: string;
      total_cost_usd?: number;
      duration_ms?: number;
      num_turns?: number;
      usage?: BackendUsage;
      [k: string]: unknown;
    }
  | { type: 'system'; subtype?: string; session_id?: string; [k: string]: unknown };

/**
 * Prompt accepted by `streamQuery`: plain text, or a multimodal content array
 * (Claude `ContentBlockParam[]` / Codex input items). Typed loosely here to keep
 * `@slackhive/shared` free of provider SDK type dependencies; the runner backends
 * narrow it to their SDK's input type.
 */
export type AgentPrompt = string | unknown[];

// =============================================================================
// Core backend interface
// =============================================================================

/**
 * Runtime interface each agent backend implements. The agent brain interacts
 * only through this — no agent-SDK imports leak into the core message flow.
 * Parallels {@link PlatformAdapter}.
 */
export interface AgentBackend {
  /** Backend identifier (e.g. 'claude', 'codex'). Parallels `PlatformAdapter.platform`. */
  readonly backend: string;

  /** Set up sessions dir, cleanup timer, MCP proxies. Call once before streamQuery. */
  initialize(): void;

  /** Tear down: abort in-flight queries, kill subprocesses, stop MCP proxies. */
  destroy(): Promise<void>;

  /** Derive a deterministic session key from platform identifiers. */
  getSessionKey(userId: string, channelId: string, threadTs?: string): string;

  /**
   * Per-thread working directory (the agent's cwd) for `sessionKey`, created if
   * needed. Lets the caller drop large attachments on disk for the agent to read
   * with its file tools — like Claude Code — instead of inlining/truncating them.
   */
  getSessionWorkDir(sessionKey: string): string;

  /**
   * Stream a query for `sessionKey`, yielding normalized {@link BackendMessage}s.
   * Resumes a prior session when one exists for the key; callers break on
   * `abortController.signal.aborted` to cancel.
   */
  streamQuery(
    prompt: AgentPrompt,
    sessionKey: string,
    abortController?: AbortController,
  ): AsyncGenerator<BackendMessage, void, unknown>;
}
