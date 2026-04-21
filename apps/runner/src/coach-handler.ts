/**
 * @fileoverview Interactive "Coach" for tuning an agent's CLAUDE.md and skills.
 *
 * Wraps the Claude Agent SDK as a sandboxed multi-turn helper. The model can
 * only inspect the agent's current config and propose edits through a
 * whitelisted set of in-process MCP tools — it cannot write to disk, hit the
 * DB, or call any built-in tool (Read/Write/Edit/Bash/Grep/...). Proposals are
 * surfaced as approval cards in the web UI; the human clicks Apply to actually
 * mutate state via the existing REST routes.
 *
 * @module runner/coach-handler
 */
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  query,
  tool,
  createSdkMcpServer,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

// The SDK types `tool()`'s schema against zod v4's `$ZodType`, but our workspace
// resolves zod to v3 via transitive deps. Both shapes work at runtime — the
// SDK's `AnyZodRawShape = ZodRawShape | ZodRawShape_2` union is designed for
// this transitional case. We cast the builder to bypass the type-only mismatch.
// TODO(zod): remove this cast once the workspace consolidates on zod v4.
type SdkTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>[number];
const defTool = tool as unknown as <S extends Record<string, unknown>>(
  name: string,
  description: string,
  schema: S,
  handler: (args: any, extra: unknown) => Promise<{ content: { type: 'text'; text: string }[] }>,
  extras?: { annotations?: Record<string, unknown> },
) => SdkTool;
import type { CoachProposal } from '@slackhive/shared';
import {
  getAgentById,
  getAgentSkills,
  getAgentMcpServers,
  getAgentMemories,
  upsertSkill,
  deleteSkill,
} from './db';
import { logger } from './logger';

async function updateAgentClaudeMd(agentId: string, claudeMd: string): Promise<void> {
  const { getDb } = await import('@slackhive/shared');
  await getDb().query(
    'UPDATE agents SET claude_md = $1, updated_at = now() WHERE id = $2',
    [claudeMd, agentId],
  );
}

/** Max bytes of user-pasted failed-conversation text sent to the model. */
const MAX_ATTACHMENT_CHARS = 20_000;

/**
 * Reject skill `category` / `filename` values that could escape the
 * per-agent commands directory on disk. The runner materializes skills via
 * `path.join(commandsDir, filename)`; a model-proposed `"../foo"` would
 * otherwise break out of the workspace.
 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
// SAFE_NAME permits "." so bare `.` / `..` tokens pass the regex — reject
// those separately since they're current-dir / parent-dir references.
const DOTS_ONLY = /^\.+$/;
export function assertSafeSkillPath(category: string, filename: string): void {
  if (!SAFE_NAME.test(category) || DOTS_ONLY.test(category)) throw new Error(`invalid category: ${category}`);
  if (!SAFE_NAME.test(filename) || DOTS_ONLY.test(filename)) throw new Error(`invalid filename: ${filename}`);
}

/**
 * One streamed event emitted to the web layer over SSE.
 * Shape is stable — the web route and UI depend on it.
 */
export type CoachStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: Record<string, unknown>; ok: boolean }
  | { type: 'proposal'; proposal: CoachProposal }
  | { type: 'done'; sdkSessionId?: string }
  | { type: 'error'; message: string };

const BUILT_IN_TOOLS_TO_DENY = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'BashOutput',
  'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
  'TodoWrite', 'ExitPlanMode',
];

const BOOTSTRAP_APPENDIX = `

# Bootstrap mode (this turn) — overrides the rule above
This is the first turn after the user created this agent through the new-agent wizard.
**Override:** in this turn only, \`propose_claude_md_update\` / \`propose_skill_change\`
APPLY DIRECTLY to the DB. Ignore any earlier statement that they only queue an
approval card. The user consented to this up-front in the wizard.
\`propose_memory_change\` still QUEUES in this turn — memory edits always require
an explicit Apply, even in wizard mode, because they go into the always-on system
prompt and the user should see each one before it lands.

**You MUST call \`propose_claude_md_update\` exactly once in this turn.** The agent
otherwise ships with no system prompt. Even in the vague case, a minimal skeleton
is required.

Pick one of:
- **(a) Specific enough to draft confidently** — generate a complete, usable first
  version of CLAUDE.md (role, behavior rules, response style, tool usage if any
  MCPs are connected) AND at least one concrete skill file that captures a
  domain-specific workflow or knowledge area implied by the description. Your chat
  reply should summarize what you drafted and any assumptions made.
- **(b) Vague or missing** — propose a minimal skeleton CLAUDE.md (3–5 lines: name,
  one-line purpose, "respond concisely in Slack") and NO skills. Then in your chat
  reply, ask 2–3 specific clarifying questions so the next turn can flesh things
  out. Do NOT invent details you don't have.

Do not ask clarifying questions in mode (a). Do not skip CLAUDE.md in either mode.`;

const SYSTEM_PROMPT = `You are a coach that helps a SlackHive operator tune one specific agent.
You can ONLY propose edits — a human clicks Apply to actually land them.

# Runtime facts (true every turn)
- Every memory row is inlined into the agent's CLAUDE.md at build time, so memories fire on EVERY Slack turn. Stale or conflicting memories are expensive. Total inlined bytes are capped at 32 KB.
- The agent Greps \`knowledge/wiki/\` at runtime. That's the right home for large bodies of domain facts — docs, runbooks, reference tables, jargon. You cannot write the wiki directly; you hand the user a downloadable \`.md\` via \`propose_wiki_extract\` or the \`wikiExtract\` field on another proposal.
- You cannot edit the agent's name / persona / description — those are identity fields set at creation. \`propose_claude_md_update\` edits the longer system-prompt body only.

# Where things go

| Content the user wants to store | Store | Tool |
|---|---|---|
| Identity / persona / tone (who the agent is) | CLAUDE.md | \`propose_claude_md_update\` |
| Rule / preference / short fact / correction | Memory (feedback / user / project / reference) | \`propose_memory_change\` |
| Workflow / procedure / multi-step task (multi-job agent) | Skill | \`propose_skill_change\` |
| Workflow / procedure for a single-purpose agent (e.g. "birthday bot") | CLAUDE.md | \`propose_claude_md_update\` |
| Domain knowledge — systems, products, data models, jargon, reference material | Wiki | \`propose_wiki_extract\` (or \`wikiExtract\` attached to a cleanup edit) |
| Recurring / scheduled task | Workflow → CLAUDE.md or Skill as above; schedule → tell the user to open \`/jobs\` in SlackHive and create a Job (you cannot create Jobs) | — |

Note: memories are already inlined into CLAUDE.md, so there is no value in "promoting" a memory into CLAUDE.md prose. The only useful promotion is memory → skill when the content is a workflow that should run on-demand instead of always-on.

# Workflow for every turn
1. **Inspect first.** Call \`read_claude_md\` / \`list_skills\` / \`read_skill\` / \`read_memories\` / \`list_mcps\` as needed. Never guess at current state.
2. **Classify the user's intent** against the table above.
3. **Propose.** For cleanups or when any store holds domain knowledge: propose UPDATE (strip the domain block) or DELETE (if the row/skill is fully domain), and attach \`wikiExtract\` with the extracted content + a descriptive lowercase-kebab \`suggestedPath\` (e.g. \`domain/fraud-pipeline.md\`, \`reference/redshift-tables.md\`). If the user is simply teaching the agent a body of domain knowledge with nothing to strip, call \`propose_wiki_extract\` directly.
4. **Keep prose short.** The UI renders cards — do not repeat their content in chat. One-line framing at most.

# Audit checklist
Use this same checklist when the user asks to review memories (\`read_memories\`), CLAUDE.md (\`read_claude_md\`), or a skill (\`read_skill\`). Apply in priority order; flag only what's actually wrong:
1. **Conflicts** — two \`feedback\` rules that contradict each other both fire every turn. Propose deleting one; rationale explains which survives and why.
2. **Duplicates / near-duplicates** — merge into one; propose deleting the others.
3. **User-ID format** — rules keyed on \`when user is U…\` must match the runtime format \`[Sender: name (U…) …]\` (all-caps Slack ID). Flag malformed or stale IDs.
4. **Staleness** — \`project\` memories referencing past deadlines, shipped work, or people who left → propose deletion with the date as rationale.
5. **Type mismatch** — a \`feedback\` row that's really a \`reference\` fact (or vice versa). Propose an UPDATE that changes \`memoryType\`.
6. **Budget (memories only)** — total inlined bytes vs the 32 KB cap. If >70% full, propose trimming lowest-signal entries first; rewrite huge memories shorter.
7. **Workflow-shaped memory** — a long procedural memory that only matters for certain tasks → propose creating a skill with the same content AND deleting the memory.
8. **Domain-knowledge-shaped (anywhere)** — content that describes the user's systems/products/jargon/reference material is wiki content, not identity/rules/workflow. UPDATE to strip (if partial) or DELETE (if fully domain); always attach \`wikiExtract\` so the user can download the extracted wiki page.
9. **Skill that's mostly WHAT not HOW** — a skill that's a lookup table or reference dump is wiki content. Propose DELETE + \`wikiExtract\`.
10. **Rule buried in CLAUDE.md prose** — "always format…", "never mention…" → propose extracting into a \`feedback\` memory.
11. **Long procedural block in CLAUDE.md** (multi-job agent) → propose extracting into a skill.

If nothing needs fixing, reply in ONE short line (e.g. "Memory clean — 2 rows, 1% of budget."). Do NOT recap every criterion you checked.

# Rules
- You can ONLY propose. Apply is always the human's click. (Exception: bootstrap mode — see any appendix at the bottom of this prompt.)
- You have ONLY the listed tools (\`read_*\`, \`list_*\`, \`propose_*\`). No filesystem, no shell, no web. Decline anything outside tuning this agent.
- Inspect before proposing; never guess.
- Prefer one proposal per distinct change — do not bundle unrelated edits into one card.
- Never invent MCPs or skills that don't exist. Call \`list_mcps\` / \`list_skills\` first.
- Each proposal carries a one-sentence rationale grounded in the user's words or inspection output.
- Ask ONE short clarifying question when intent is ambiguous. Don't offer three hypothetical follow-ups.
- For a pasted failed conversation, diagnose what's missing and route the fix through the table above.

# Response style
- Terse. Action-first. The UI shows cards — don't re-narrate them.
- No chatty framing ("I reviewed…", "here's a summary…"). Start with the finding or the action.
- No negative-space recaps. If there are no conflicts, just say "no cleanup needed".`;

// ────────────────────────────────────────────────────────────────────────────
// Session storage (settings table)
// ────────────────────────────────────────────────────────────────────────────

const sessionKey = (agentId: string) => `coach-session:${agentId}`;

/** Simple wrapper so we don't pull in the web's db helpers. */
async function readSetting(key: string): Promise<string | null> {
  const { getDb } = await import('@slackhive/shared');
  const r = await getDb().query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows.length ? (r.rows[0].value as string) : null;
}
async function writeSetting(key: string, value: string): Promise<void> {
  const { getDb } = await import('@slackhive/shared');
  await getDb().query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

export async function loadCoachSession(
  agentId: string
): Promise<{ sdkSessionId?: string; messages: unknown[] }> {
  const raw = await readSetting(sessionKey(agentId));
  if (!raw) return { messages: [] };
  try { return JSON.parse(raw); } catch { return { messages: [] }; }
}

export async function saveCoachSession(
  agentId: string,
  data: { sdkSessionId?: string; messages: unknown[] }
): Promise<void> {
  await writeSetting(sessionKey(agentId), JSON.stringify({ ...data, updatedAt: new Date().toISOString() }));
}

export async function resetCoachSession(agentId: string): Promise<void> {
  const { getDb } = await import('@slackhive/shared');
  await getDb().query('DELETE FROM settings WHERE key = $1', [sessionKey(agentId)]);
}

// ────────────────────────────────────────────────────────────────────────────
// Sandboxed MCP toolbox — all tools close over a single agentId
// ────────────────────────────────────────────────────────────────────────────

/** Collects proposals Claude emits during one turn. */
interface ToolContext {
  agentId: string;
  proposals: CoachProposal[];
  /**
   * When true, `propose_*` tools apply their change to the DB immediately
   * (for wizard bootstrap, where the user consented up-front). When false,
   * proposals only queue for the user to Apply from the UI.
   */
  autoApply: boolean;
  onToolCall: (name: string, input: Record<string, unknown>, ok: boolean) => void;
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function buildToolbox(ctx: ToolContext) {
  const wrap = <I extends Record<string, unknown>>(
    name: string,
    fn: (input: I) => Promise<ReturnType<typeof textResult>>
  ) => async (input: I) => {
    try {
      const out = await fn(input);
      ctx.onToolCall(name, input, true);
      return out;
    } catch (err) {
      ctx.onToolCall(name, input, false);
      return textResult(`ERROR: ${(err as Error).message}`);
    }
  };

  const readClaudeMd = defTool(
    'read_claude_md',
    "Return the agent's current CLAUDE.md (system prompt). Takes no arguments.",
    {},
    wrap('read_claude_md', async () => {
      const agent = await getAgentById(ctx.agentId);
      if (!agent) throw new Error('agent not found');
      return textResult(agent.claudeMd?.trim() || '(empty — no custom system prompt set yet)');
    }),
    { annotations: { readOnlyHint: true } }
  );

  const listSkills = defTool(
    'list_skills',
    "List every skill for this agent with category, filename, and the first line of content. Takes no arguments.",
    {},
    wrap('list_skills', async () => {
      const skills = await getAgentSkills(ctx.agentId);
      if (skills.length === 0) return textResult('(no skills yet)');
      const lines = skills.map(s => {
        const first = (s.content.split('\n').find((l: string) => l.trim()) ?? '').slice(0, 120);
        return `- ${s.category}/${s.filename} — ${first}`;
      });
      return textResult(lines.join('\n'));
    }),
    { annotations: { readOnlyHint: true } }
  );

  const readSkill = defTool(
    'read_skill',
    'Return the full body of one skill file. Use this before proposing changes to an existing skill.',
    { category: z.string(), filename: z.string() },
    wrap('read_skill', async ({ category, filename }) => {
      const skills = await getAgentSkills(ctx.agentId);
      const hit = skills.find(s => s.category === category && s.filename === filename);
      if (!hit) throw new Error(`skill not found: ${category}/${filename}`);
      return textResult(hit.content);
    }),
    { annotations: { readOnlyHint: true } }
  );

  const listMcps = defTool(
    'list_mcps',
    'List the MCP tools connected to this agent, with type and description. Use this before referencing MCPs in instructions.',
    {},
    wrap('list_mcps', async () => {
      const mcps = await getAgentMcpServers(ctx.agentId);
      if (mcps.length === 0) return textResult('(no MCPs connected)');
      return textResult(mcps.map(m => `- ${m.name} (${m.type}) — ${m.description ?? 'no description'}`).join('\n'));
    }),
    { annotations: { readOnlyHint: true } }
  );

  const readMemories = defTool(
    'read_memories',
    "Return the agent's learned memories with per-memory byte counts and total-vs-cap. Every memory is inlined into the system prompt at build time, so byte budget matters. Each entry includes an id you can pass to propose_memory_change.",
    {},
    wrap('read_memories', async () => {
      const memories = await getAgentMemories(ctx.agentId);
      if (memories.length === 0) return textResult('(no memories yet)');

      // Match the cap + accounting in compile-claude-md.ts:buildInlinedMemoriesSection.
      const CAP_BYTES = 32 * 1024;
      const formatBytes = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
      const byteLen = (s: string) => Buffer.byteLength(s, 'utf-8');

      const total = memories.reduce((sum, m) => sum + byteLen(m.content), 0);
      const pct = Math.round((total / CAP_BYTES) * 100);

      const lines = [
        `Total: ${formatBytes(total)} / ${formatBytes(CAP_BYTES)} cap (${pct}%)`,
        '',
        ...memories.map(m =>
          `- id=${m.id} [${m.type}] (${formatBytes(byteLen(m.content))}) ${m.name}: ${m.content}`
        ),
      ];
      return textResult(lines.join('\n'));
    }),
    { annotations: { readOnlyHint: true } }
  );

  // Shared Zod shape for the optional wiki-extract payload. When set on a
  // propose_* call, the proposal card gets a "Download wiki page" button the
  // user clicks to save the extracted content under knowledge/wiki/.
  const wikiExtractSchema = z.object({
    suggestedPath: z.string().min(1, 'suggestedPath required (e.g. "domain/fraud-pipeline.md")'),
    content: z.string().min(1, 'content required'),
    summary: z.string().min(1, 'summary required'),
  }).optional();

  const proposeClaudeMd = defTool(
    'propose_claude_md_update',
    'Propose a full replacement for CLAUDE.md. Does not apply — surfaces an approval card in the UI. Provide the complete new content plus a one-sentence rationale. If you are stripping a domain-knowledge block, attach wikiExtract so the user can download it as a wiki page.',
    {
      content: z.string().min(1, 'content required'),
      rationale: z.string().min(1, 'rationale required'),
      wikiExtract: wikiExtractSchema,
    },
    wrap('propose_claude_md_update', async ({ content, rationale, wikiExtract }) => {
      const id = randomUUID();
      if (ctx.autoApply) {
        await updateAgentClaudeMd(ctx.agentId, content);
        ctx.proposals.push({ kind: 'claude-md', id, content, rationale, status: 'applied', wikiExtract });
        return textResult(`Applied (id=${id}).`);
      }
      ctx.proposals.push({ kind: 'claude-md', id, content, rationale, status: 'pending', wikiExtract });
      return textResult(`Proposal queued (id=${id}). The user will see a diff card and choose to Apply or Reject.`);
    }),
    { annotations: { readOnlyHint: false, destructiveHint: false } }
  );

  const proposeSkill = defTool(
    'propose_skill_change',
    'Propose creating, updating, or deleting ONE skill file. Does not apply — surfaces an approval card. For create/update include full content. For delete omit content. If you are removing a skill that is really reference material (not a workflow), attach wikiExtract so the user can download the content as a wiki page.',
    {
      category: z.string().min(1),
      filename: z.string().min(1),
      action: z.enum(['create', 'update', 'delete']),
      content: z.string().optional(),
      rationale: z.string().min(1),
      wikiExtract: wikiExtractSchema,
    },
    wrap('propose_skill_change', async ({ category, filename, action, content, rationale, wikiExtract }) => {
      assertSafeSkillPath(category, filename);
      if ((action === 'create' || action === 'update') && !content) {
        throw new Error('content is required for create/update');
      }
      const id = randomUUID();
      if (ctx.autoApply) {
        if (action === 'delete') {
          await deleteSkill(ctx.agentId, category, filename);
        } else {
          // Preserve the existing sortOrder on update so the model doesn't
          // silently shuffle skills around; new skills go to position 0.
          const existing = (await getAgentSkills(ctx.agentId)).find(
            s => s.category === category && s.filename === filename,
          );
          await upsertSkill(ctx.agentId, category, filename, content ?? '', existing?.sortOrder ?? 0);
        }
        ctx.proposals.push({
          kind: 'skill', id, category, filename, action,
          content: action === 'delete' ? undefined : content,
          rationale, status: 'applied', wikiExtract,
        });
        return textResult(`Applied ${action} for ${category}/${filename}.`);
      }
      ctx.proposals.push({
        kind: 'skill', id, category, filename, action,
        content: action === 'delete' ? undefined : content,
        rationale, status: 'pending', wikiExtract,
      });
      return textResult(`Proposal queued (id=${id}) for ${action} ${category}/${filename}.`);
    }),
    { annotations: { readOnlyHint: false, destructiveHint: false } }
  );

  const proposeMemory = defTool(
    'propose_memory_change',
    'Propose creating, rewriting, or deleting ONE memory row. For `create`, provide name + memoryType + content (memoryId is ignored). For `update`, provide memoryId + content (memoryType optional — include it to retype a mis-categorized memory). For `delete`, provide memoryId only. If the edit strips domain knowledge out of the memory, attach wikiExtract so the user can download it as a wiki page.',
    {
      action: z.enum(['create', 'update', 'delete']),
      /** Required for update/delete. Ignored on create. Get this from read_memories. */
      memoryId: z.string().optional(),
      /** Required for create (the new memory's name). Ignored on update/delete. */
      name: z.string().optional(),
      /** Required for create. Optional on update (retype). Ignored on delete. */
      memoryType: z.enum(['feedback', 'user', 'project', 'reference']).optional(),
      /** Required for create and update. Omit for delete. */
      content: z.string().optional(),
      rationale: z.string().min(1),
      wikiExtract: wikiExtractSchema,
    },
    wrap('propose_memory_change', async ({ action, memoryId, name, memoryType, content, rationale, wikiExtract }) => {
      const id = randomUUID();

      if (action === 'create') {
        if (!name) throw new Error('name is required for create');
        if (!memoryType) throw new Error('memoryType is required for create');
        if (!content) throw new Error('content is required for create');
        // Detect collisions early — same-name memories are replaced by upsert
        // at apply time, so surface this to the model instead of silently
        // clobbering. The model can then switch to action=update if intended.
        const existing = await getAgentMemories(ctx.agentId);
        if (existing.some(m => m.name === name)) {
          throw new Error(`memory with name "${name}" already exists — use action=update instead`);
        }
        ctx.proposals.push({
          kind: 'memory', id,
          memoryName: name, memoryType,
          action: 'create',
          content,
          rationale, status: 'pending', wikiExtract,
        });
        return textResult(`Proposal queued (id=${id}) for create memory ${name}.`);
      }

      // update / delete both need an existing row.
      if (!memoryId) throw new Error(`memoryId is required for ${action}`);
      if (action === 'update' && !content) throw new Error('content is required for update');

      const memories = await getAgentMemories(ctx.agentId);
      const hit = memories.find(m => m.id === memoryId);
      if (!hit) throw new Error(`memory not found: ${memoryId}`);

      // Memory proposals always queue — no auto-apply even in wizard bootstrap.
      ctx.proposals.push({
        kind: 'memory', id,
        memoryId: hit.id, memoryName: hit.name,
        action,
        memoryType: action === 'update' ? memoryType : undefined,
        content: action === 'delete' ? undefined : content,
        rationale, status: 'pending', wikiExtract,
      });
      return textResult(`Proposal queued (id=${id}) for ${action} memory ${hit.name}.`);
    }),
    { annotations: { readOnlyHint: false, destructiveHint: true } }
  );

  const proposeWikiExtract = defTool(
    'propose_wiki_extract',
    'Propose a standalone wiki page — no CLAUDE.md/skill/memory edit involved. Use this when the user asks you to teach the agent a body of domain knowledge (facts about their systems, products, jargon, reference material) and there is nothing to strip from an existing store. The UI shows a card with only a Download button; the user saves the .md under knowledge/wiki/ themselves.',
    {
      wikiExtract: z.object({
        suggestedPath: z.string().min(1, 'suggestedPath required (e.g. "domain/fraud-pipeline.md")'),
        content: z.string().min(1, 'content required'),
        summary: z.string().min(1, 'summary required'),
      }),
      rationale: z.string().min(1),
    },
    wrap('propose_wiki_extract', async ({ wikiExtract, rationale }) => {
      const id = randomUUID();
      ctx.proposals.push({ kind: 'wiki-extract', id, wikiExtract, rationale, status: 'pending' });
      return textResult(`Proposal queued (id=${id}) for wiki page ${wikiExtract.suggestedPath}.`);
    }),
    { annotations: { readOnlyHint: true } }
  );

  return [readClaudeMd, listSkills, readSkill, listMcps, readMemories, proposeClaudeMd, proposeSkill, proposeMemory, proposeWikiExtract];
}

// ────────────────────────────────────────────────────────────────────────────
// Turn handler
// ────────────────────────────────────────────────────────────────────────────

export interface CoachTurnInput {
  agentId: string;
  userMessage: string;
  /** Optional text pasted by the user (e.g. a failed conversation). Appended as a tagged block. */
  attachment?: string;
  /** SDK session id from a previous turn, if any. */
  sdkSessionId?: string;
  /**
   * When true, proposals auto-apply and the bootstrap appendix is added to the
   * system prompt. Set only by the new-agent wizard's first turn.
   */
  autoApply?: boolean;
  /** Emits streamed events for SSE. Must not throw. */
  emit: (ev: CoachStreamEvent) => void;
}

export async function runCoachTurn(input: CoachTurnInput): Promise<{
  sdkSessionId?: string;
  proposals: CoachProposal[];
  assistantText: string;
  toolCalls: { name: string; input: Record<string, unknown>; ok: boolean }[];
}> {
  const agent = await getAgentById(input.agentId);
  if (!agent) throw new Error('agent not found');

  const proposals: CoachProposal[] = [];
  const toolCalls: { name: string; input: Record<string, unknown>; ok: boolean }[] = [];

  const ctx: ToolContext = {
    agentId: input.agentId,
    proposals,
    autoApply: !!input.autoApply,
    onToolCall: (name, toolInput, ok) => {
      toolCalls.push({ name, input: toolInput, ok });
      input.emit({ type: 'tool', name, input: toolInput, ok });
    },
  };

  const mcpServer = createSdkMcpServer({
    name: 'coach',
    version: '1.0.0',
    tools: buildToolbox(ctx),
  });

  // Name format used by the SDK for in-process MCP tools.
  const allowedToolNames = [
    'mcp__coach__read_claude_md',
    'mcp__coach__list_skills',
    'mcp__coach__read_skill',
    'mcp__coach__list_mcps',
    'mcp__coach__read_memories',
    'mcp__coach__propose_claude_md_update',
    'mcp__coach__propose_skill_change',
    'mcp__coach__propose_memory_change',
    'mcp__coach__propose_wiki_extract',
  ];

  const userBlock = input.attachment
    ? `${input.userMessage}\n\n<failed_conversation>\n${input.attachment.slice(0, MAX_ATTACHMENT_CHARS)}\n</failed_conversation>`
    : input.userMessage;

  // First turn primes the model with agent identity; resume carries state after.
  const prompt = input.sdkSessionId
    ? userBlock
    : `# Agent you are tuning
Name: ${agent.name}
Persona: ${agent.persona ?? '(none)'}
Description: ${agent.description ?? '(none)'}
Model: ${agent.model}

# User's first message
${userBlock}`;

  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs');
  // Empty throwaway cwd so even if a built-in tool somehow ran there's nothing interesting.
  const cwd = path.join(os.tmpdir(), `slackhive-coach-${input.agentId}`);
  try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* exists */ }

  let assistantText = '';
  let finalSessionId: string | undefined = input.sdkSessionId;

  try {
    for await (const msg of query({
      prompt,
      options: {
        mcpServers: {
          coach: { type: 'sdk', name: 'coach', instance: mcpServer.instance },
        },
        allowedTools: allowedToolNames,
        disallowedTools: BUILT_IN_TOOLS_TO_DENY,
        permissionMode: 'dontAsk',
        maxTurns: 8,
        cwd,
        resume: input.sdkSessionId,
        systemPrompt: input.autoApply ? SYSTEM_PROMPT + BOOTSTRAP_APPENDIX : SYSTEM_PROMPT,
      },
    })) {
      const m = msg as SDKMessage & Record<string, any>;
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
        finalSessionId = m.session_id;
      }
      if (m.type === 'assistant') {
        const content: any[] = m.message?.content ?? [];
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            assistantText += block.text;
            input.emit({ type: 'text', delta: block.text });
          }
        }
      }
      if (m.type === 'result') {
        if (m.session_id && !finalSessionId) finalSessionId = m.session_id;
        if (typeof m.result === 'string' && !assistantText.trim()) {
          assistantText = m.result;
          input.emit({ type: 'text', delta: m.result });
        }
      }
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.error('coach turn failed', { agentId: input.agentId, error: message });
    input.emit({ type: 'error', message });
    throw err;
  }

  // Safety net: during bootstrap, guarantee the agent has at least a
  // minimal claude.md so it's startable even if the model misbehaved.
  if (input.autoApply) {
    const touchedClaudeMd = proposals.some(p => p.kind === 'claude-md' && p.status === 'applied');
    if (!touchedClaudeMd && agent && !agent.claudeMd?.trim()) {
      const skeleton = `# ${agent.name}\n\n${agent.persona || agent.description || 'You are a helpful Slack assistant.'}`;
      try {
        await updateAgentClaudeMd(input.agentId, skeleton);
        logger.info('coach bootstrap: wrote fallback skeleton', { agentId: input.agentId });
      } catch (err) {
        logger.warn('coach bootstrap: fallback skeleton failed', { error: (err as Error).message });
      }
    }
  }

  for (const p of proposals) input.emit({ type: 'proposal', proposal: p });
  input.emit({ type: 'done', sdkSessionId: finalSessionId });

  return { sdkSessionId: finalSessionId, proposals, assistantText, toolCalls };
}
