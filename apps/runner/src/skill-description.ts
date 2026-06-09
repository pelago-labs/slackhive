/**
 * @fileoverview Policy for filling a skill's "WHEN TO USE" description.
 *
 * Extracted from AgentRunner so the decision logic is unit-testable and so the
 * one rule that bit us is explicit: a description fill (new skill OR a
 * user-triggered "Regenerate with AI") must run **regardless of whether the
 * agent is currently running** — otherwise regenerating on a stopped agent
 * silently no-ops and the UI spins forever. Only the post-write recompile/reload
 * is gated on the agent actually being up (a stopped agent recompiles on start).
 *
 * @module runner/skill-description
 */

export interface SkillRow {
  filename: string;
  content: string;
  description: string | null;
}

export interface FillSkillDeps {
  /** Load the skill row (null if it was deleted between event and handling). */
  getSkillById(skillId: string): Promise<SkillRow | null>;
  /** Backend-aware summarizer (returns null on failure). */
  summarize(filename: string, content: string): Promise<string | null>;
  /** Persist the generated description. */
  updateSkillDescription(skillId: string, description: string): Promise<unknown>;
  /** Is this agent currently running on this runner? (gates the recompile only). */
  isRunning(agentId: string): boolean;
  /** Recompile + reload the agent so the new line lands in its instructions. */
  reload(agentId: string): Promise<void>;
}

/**
 * Fill a skill's description if it's missing. Returns the new description, or
 * null when nothing was written (skill gone, already filled, or summarizer
 * failed). Summarization is NOT gated on the agent running; the reload is.
 */
export async function fillSkillDescription(
  deps: FillSkillDeps,
  agentId: string,
  skillId: string,
): Promise<string | null> {
  const skill = await deps.getSkillById(skillId);
  if (!skill) return null;
  if (skill.description) return null; // Already filled — nothing to do.

  const description = await deps.summarize(skill.filename, skill.content);
  if (!description) return null;

  await deps.updateSkillDescription(skillId, description);

  // The instructions file only needs recompiling if the agent is live; a stopped
  // agent compiles fresh on its next start. Skipping this is what lets regenerate
  // work for stopped agents.
  if (deps.isRunning(agentId)) await deps.reload(agentId);

  return description;
}
