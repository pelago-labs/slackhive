/**
 * @fileoverview Memory reconcile / self-review pass (Phase 2).
 *
 * Periodically reviews an agent's whole memory set and removes duplicates and
 * superseded/contradicted facts (the cleanup the extraction pass can't do at
 * write time). Conservative by construction: only DELETE exact/near-duplicates
 * or clearly-superseded memories, NEVER touch pinned memories, hard op cap, and
 * a cheap model. Runs in suggest mode (apply=false) or apply mode.
 *
 * @module runner/memory-reconcile
 */
import type { Agent, Memory } from '@slackhive/shared';
import { DEFAULT_EVAL_JUDGE_MODEL, LIGHT_CODEX_MODEL } from '@slackhive/shared';
import { generateText } from './backends/generate-text';
import { upsertMemory, deleteMemory } from './db';
import { parseLlmJson } from './llm-json';
import { logger } from './logger';

/** Max ops applied per run — a runaway prompt can't gut the store. */
const MAX_OPS_PER_RUN = 8;

export interface ReconcileOp {
  action: 'DELETE' | 'UPDATE' | 'NOOP';
  id?: string;
  content?: string; // for UPDATE
  reason?: string;
}

const SYSTEM_PROMPT = `You maintain an AI agent's long-term memory. Review the current memories and
propose ONLY safe cleanups:
- DUPLICATES: two memories that say the same thing → keep the clearer one, DELETE the other(s).
- SUPERSEDED / CONTRADICTED: an older memory a newer one clearly overrides (e.g. "prefers short" then
  later "prefers long") → DELETE the stale one; if the survivor needs the merged wording, UPDATE it.

Do NOT delete a memory merely because it is narrow, old, or you disagree with it. Never propose
deleting a memory marked "(pinned)". When unsure, use NOOP. Propose at most 8 operations.

Respond with STRICT JSON only, no prose:
{"ops":[{"action":"DELETE|UPDATE|NOOP","id":"<the id= value of the memory>","content":"<new text, UPDATE only>","reason":"why"}]}`;


/**
 * Review + optionally clean an agent's memory set. Best-effort; never throws.
 * Returns the proposed ops and how many were applied (0 in suggest mode).
 */
export async function reconcileMemories(
  agent: Agent,
  memories: Memory[],
  opts: { apply: boolean },
): Promise<{ ops: ReconcileOp[]; applied: number }> {
  if (memories.length < 2) return { ops: [], applied: 0 };

  const list = memories
    .map(m => `id=${m.id} [${m.type}]${m.pinned ? ' (pinned)' : ''} "${m.name}": ${m.content.replace(/\s+/g, ' ').trim()}`)
    .join('\n');

  let reply: string;
  try {
    reply = await generateText(`Current memories:\n${list}`, {
      systemPrompt: SYSTEM_PROMPT,
      claudeModel: DEFAULT_EVAL_JUDGE_MODEL,
      codexModel: LIGHT_CODEX_MODEL,
    });
  } catch (err) {
    logger.warn('memory-reconcile: generateText failed', { agent: agent.slug, error: (err as Error).message });
    return { ops: [], applied: 0 };
  }

  const parsed = parseLlmJson<{ ops?: ReconcileOp[] }>(reply);
  const ops = Array.isArray(parsed?.ops) ? parsed!.ops! : [];
  if (!opts.apply) return { ops, applied: 0 };

  const byId = new Map(memories.map(m => [m.id, m]));
  let applied = 0;
  for (const op of ops) {
    // Cap counts APPLIED ops, not proposed — so skipped pinned/unknown ops at
    // the front of the list don't crowd out valid cleanups behind them.
    if (applied >= MAX_OPS_PER_RUN) break;
    const target = op.id ? byId.get(op.id) : undefined;
    if (!target || target.pinned) continue; // unknown id, or never touch pinned
    try {
      if (op.action === 'DELETE') {
        await deleteMemory(agent.id, target.id);
        applied += 1;
        logger.info('memory-reconcile: deleted', { agent: agent.slug, name: target.name, reason: (op.reason ?? '').slice(0, 120) });
      } else if (op.action === 'UPDATE' && op.content?.trim()) {
        // Preserve the target's tier + provenance — only the content changes.
        await upsertMemory(agent.id, target.type, target.name, op.content.trim(), {
          pinned: target.pinned,
          scopeUserId: target.scopeUserId ?? null,
          scopeGroupId: target.scopeGroupId ?? null,
          createdBy: target.createdBy ?? null,
          source: target.source ?? null,
        });
        applied += 1;
        logger.info('memory-reconcile: updated', { agent: agent.slug, name: target.name, reason: (op.reason ?? '').slice(0, 120) });
      }
    } catch (err) {
      logger.warn('memory-reconcile: op failed', { agent: agent.slug, error: (err as Error).message });
    }
  }
  return { ops, applied };
}
