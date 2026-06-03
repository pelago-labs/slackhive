/**
 * @fileoverview Single source of truth for an agent's identity body (persona +
 * description). Used by the instruction-doc compiler (the `# Name` identity
 * section of CLAUDE.md/AGENTS.md) AND by the Codex backend's
 * `developer_instructions` — so the persona text can't drift between the two
 * channels even though they wrap it differently.
 *
 * @module @slackhive/shared/agent-identity
 */

/** The persona + description, trimmed and blank-line separated. '' if neither. */
export function agentIdentityBody(agent: { persona?: string | null; description?: string | null }): string {
  return [agent.persona, agent.description]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
    .join('\n\n');
}
