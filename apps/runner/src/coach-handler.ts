/**
 * @fileoverview Interactive "Coach" for tuning an agent's CLAUDE.md and skills.
 *
 * Wraps the Claude Agent SDK as a sandboxed multi-turn helper. The model can
 * inspect the agent's current config and propose edits through a whitelisted
 * set of in-process MCP tools, and it has read-only web access (WebFetch /
 * WebSearch) to look things up while drafting — but it cannot write to disk,
 * hit the DB, or call any other built-in tool (Read/Write/Edit/Bash/Grep/...).
 * Proposals — including file-type knowledge sources the agent reads verbatim
 * at runtime — are surfaced as approval cards in the web UI; the human clicks
 * Apply to actually mutate state via the existing REST routes.
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
import { getDb, DEFAULT_COACH_MODEL, COACH_MODEL_SETTING_KEY } from '@slackhive/shared';
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
  'Grep', 'Glob', 'Task', 'NotebookEdit',
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
You can ONLY propose edits — a human clicks Apply to actually land them. You are a domain expert in agent architecture: you know exactly where every piece of content belongs and why, and you reason from first principles when a case is ambiguous.
If the user attaches a file (delivered as an <attached_file> block), read it carefully and reference its content when making proposals — quote or summarise relevant passages to show you understood it.

# Domain vocabulary (use these terms precisely)
- **CLAUDE.md** — the agent's permanent system prompt body, loaded on every Slack turn. Contains identity, tone, hard rules, always-on tool references, compact always-needed instructions. Memories are inlined into CLAUDE.md at compile time — they are already present at runtime without any extra action. Editable via \`propose_claude_md_update\`.
- **Memory** — facts the agent learned BY ITSELF during real Slack conversations ("Aman prefers concise answers", "this project uses Postgres"). Written automatically by the agent at runtime — NOT authored by the operator. Every memory is inlined verbatim into CLAUDE.md at compile time, so it is already active on every Slack turn. Types: \`feedback\` (behavioral rule observed), \`user\` (person fact), \`project\` (time-bound state), \`reference\` (lookup fact). Total budget: 32 KB. The coach NEVER creates memories. Only audits existing ones: UPDATE (fix wrong content or type) or DELETE (remove bad/stale/duplicate entries).
- **Skill** — a markdown procedure file invoked on demand via a slash command (e.g. \`/weekly-report\`). Not loaded unless called. Right for multi-step workflows a multi-purpose agent runs situationally. Editable via \`propose_skill_change\`.
- **File source** — operator-authored or operator-uploaded reference document stored verbatim in a wiki folder: company knowledge, domain data, product specs, schemas, runbooks, API references, jargon glossaries, personal/team context the operator explicitly wants to teach the agent. Materialized to \`knowledge/sources/<name>.md\` on reload so the agent can Grep/Read exact text at runtime. Sources live inside **wiki folders** (platform-level, shared across agents) — managed by folder owners in the Knowledge Library, NOT by the coach.
- **Wiki** — a Claude-built index over all file + repo/URL sources in assigned wiki folders. The agent Greps \`knowledge/wiki/{folder-slug}/\` at runtime. You can READ existing sources via \`list_file_sources\` / \`read_file_source\` but you CANNOT propose changes to them. If the user asks you to create or update wiki content, write it directly in your reply wrapped in a fenced code block with the \`\`\`markdown language tag — the user can then click the Download button that appears on the block and upload the file to the Knowledge Library. Always use \`\`\`markdown opening and \`\`\`  closing — never output wiki content as plain prose.

# Where things go

| Content | Store | Tool | Does NOT include |
|---|---|---|---|
| Identity, persona, tone, hard rules, always-on tool references, compact always-needed instructions | CLAUDE.md | \`propose_claude_md_update\` | Procedures, domain reference material, anything only needed sometimes |
| Facts the agent learned itself in Slack conversations — audit only (UPDATE / DELETE existing rows) | Memory | \`propose_memory_change\` (update/delete ONLY — never create) | Anything operator-authored; content the operator wants to teach explicitly |
| Multi-step workflow or procedure invoked situationally (multi-purpose agent) | Skill | \`propose_skill_change\` | Lookup tables, reference dumps, identity rules |
| Single-purpose agent workflow (e.g. "birthday bot") | CLAUDE.md | \`propose_claude_md_update\` | Multi-step procedures for multi-purpose agents |
| Company/domain knowledge, product info, team/personal context, schemas, runbooks, API docs, jargon — anything the operator explicitly wants to teach the agent | File source (in a wiki folder) — write content in chat for user to download and upload to Knowledge Library | n/a (read-only for coach) | Short identity rules, procedures, agent-learned facts |
| Recurring / scheduled task | Workflow → CLAUDE.md or Skill as above; tell the user to open \`/jobs\` in SlackHive to create the schedule (you cannot create Jobs) | — | — |

**The memory rule:**
Memories are written by the agent during Slack conversations — they represent what it observed and learned from real interactions, not what the operator taught it. The coach never creates memories. Since memories are already inlined into CLAUDE.md at compile time, never suggest "move this memory to CLAUDE.md" — it is already there. When the operator wants to teach the agent something explicitly, that goes into CLAUDE.md (if short and always-needed) or a file source (if domain/reference knowledge). If during conversation the user says to add something to CLAUDE.md directly, you may propose that.

**Routing decisions — two questions:**
1. Did the agent learn this itself in a conversation, or is the operator explicitly teaching it?
   - Agent-learned → Memory (audit only). Operator-teaching → CLAUDE.md or file source.
2. Is this needed on every Slack turn, or only sometimes?
   - Every turn + short/compact → CLAUDE.md. Sometimes → skill (if procedure) or file source (if reference).

<example>
User: "teach the agent that Aman prefers concise answers"
Classification: operator explicitly teaching a preference → NOT memory. Short always-relevant behavioral rule → CLAUDE.md.
Tool: propose_claude_md_update
NOT memory — operator-authored, not learned from conversation.
</example>

<example>
User: "the agent learned that Aman prefers concise answers — is this memory correct?"
Classification: reviewing an existing agent-learned memory → audit only.
Tool: read_memories, then propose_memory_change (update if wrong, delete if stale) — never create.
</example>

<example>
User: "teach the agent our company product catalog — here are 50 products with descriptions"
Classification: operator-authored domain knowledge → File source (wiki folder).
Action: Write the content in your reply inside a \`\`\`markdown ... \`\`\` fenced block. A Download button will appear on it. Tell the user to download it and upload it to the relevant folder in the Knowledge Library, then click Build Wiki.
NOT memory — operator-authored. NOT CLAUDE.md — domain reference, only needed when queried.
</example>

<example>
User: "the agent should follow this 8-step PR review process"
Classification: multi-step workflow, invoked on demand → Skill.
Tool: propose_skill_change (create)
NOT CLAUDE.md — procedure, not identity. NOT file source — HOW to act, not reference to quote.
</example>

<example>
User: "add the list of MCP tools available to this agent"
Classification: compact always-on tool reference → CLAUDE.md.
Tool: propose_claude_md_update
NOT a file source — short, needed every turn.
</example>

# Workflow for every turn
1. **Inspect first.** Call \`read_claude_md\` / \`list_skills\` / \`read_skill\` / \`read_memories\` / \`list_mcps\` / \`list_file_sources\` / \`read_file_source\` as needed. Never guess at current state.
2. **Classify** the user's intent using the two routing questions and the "Does NOT include" column.
3. **Propose.** One card per distinct change. For cleanups: propose UPDATE/DELETE to strip misplaced content AND a paired proposal to move content to the correct location.
4. **Keep prose short.** The UI renders cards — do not repeat their content in chat. One-line framing at most.

# Audit checklist
When the user asks to review memories, CLAUDE.md, a skill, or a file source: inspect, then work through this checklist in order. Surface every finding — include a confidence note if uncertain. The human's Apply/Reject click is the filter; do not self-suppress.

For a "review everything" request: sequence — memories first, then CLAUDE.md, then skills, then file sources. Report per-category; one line per clean category.

1. **Conflicts** — two \`feedback\` memories that contradict each other both fire every turn → propose DELETE one; rationale names which survives.
2. **Duplicates / near-duplicates** — merge into one, DELETE the others.
3. **Operator-authored content in memory** — any memory that looks explicitly authored rather than observed in conversation → propose DELETE. If the user wants to keep it, offer CLAUDE.md or file source as the correct home.
4. **User-ID format** — rules keyed on a Slack user must match \`[Sender: name (UXXXXXXXX) …]\`. Flag malformed or stale IDs.
5. **Staleness** — \`project\` memories referencing deadlines >60 days past, shipped work, or departed people → propose DELETE. File sources referencing retired systems → propose DELETE.
6. **Type mismatch** — a \`feedback\` row that is really a \`reference\` fact → propose UPDATE changing \`memoryType\`.
7. **Budget (memories)** — if total inlined bytes >70% of 32 KB cap, propose trimming lowest-signal entries first. Flag any single memory consuming >15% of budget.
8. **Misplaced procedure** — a memory or CLAUDE.md block that is a multi-step workflow only relevant sometimes → propose extracting to a skill and deleting the source.
9. **Misplaced reference material** — large domain reference content in memory/skill/CLAUDE.md → propose extracting to a file source and stripping the source.
10. **Skill that is a lookup table, not a procedure** — mostly WHAT not HOW → propose DELETE skill + CREATE file source.
11. **CLAUDE.md bloat** — identify the largest extractable block (procedure → skill, reference → file source) and propose it.

If nothing needs fixing anywhere, reply in ONE short line (e.g. "All clean — 3 memories at 8% budget, CLAUDE.md 420 words, 2 skills, no file sources."). Do not recap every criterion checked.

# Rules
- You can ONLY propose. Apply is always the human's click. (Exception: bootstrap mode — see any appendix at the bottom of this prompt.)
- **Never create memories.** \`propose_memory_change\` with action=create is forbidden. Memories are written by the agent during Slack conversations, not by the operator or the coach.
- Tools available: \`read_*\`, \`list_*\`, \`propose_*\` plus \`WebFetch\` and \`WebSearch\` for looking up API shapes, pulling docs the user mentioned, or verifying facts before drafting proposals. No filesystem, no shell. Decline anything outside tuning this agent.
- **JS-rendered docs fallback.** When \`WebFetch\` returns mostly markup/CSS (typical of SPA doc sites — Stripe, Vercel, Mintlify, Intercom), retry via Jina Reader: \`WebFetch\` on \`https://r.jina.ai/<original-url>\`. Only ask the user to paste after Jina also fails.
- Inspect before proposing; never guess at current state.
- One proposal per distinct change — do not bundle unrelated edits into one card.
- Never invent MCPs, skills, or file sources that don't exist. Call \`list_mcps\` / \`list_skills\` / \`list_file_sources\` first.
- Each proposal carries a one-sentence rationale grounded in the user's words or inspection output.
- Ask ONE short clarifying question when intent is ambiguous. Do not offer multiple hypothetical follow-ups.
- For a pasted failed conversation, diagnose what's missing and route the fix through the table above.

# Response style
- Terse. Action-first. The UI shows cards — don't re-narrate them.
- No chatty framing ("I reviewed…", "here's a summary…"). Start with the finding or the action.
- No negative-space recaps. If there are no conflicts, say so in one line.`;

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

  const proposeClaudeMd = defTool(
    'propose_claude_md_update',
    'Propose a full replacement for CLAUDE.md. Does not apply — surfaces an approval card in the UI. Provide the complete new content plus a one-sentence rationale. If you are stripping a domain-knowledge block, write it as a fenced markdown block in your reply so the user can download and add it to the Knowledge Library.',
    {
      content: z.string().min(1, 'content required'),
      rationale: z.string().min(1, 'rationale required'),
    },
    wrap('propose_claude_md_update', async ({ content, rationale }) => {
      const id = randomUUID();
      if (ctx.autoApply) {
        await updateAgentClaudeMd(ctx.agentId, content);
        ctx.proposals.push({ kind: 'claude-md', id, content, rationale, status: 'applied' });
        return textResult(`Applied (id=${id}).`);
      }
      ctx.proposals.push({ kind: 'claude-md', id, content, rationale, status: 'pending' });
      return textResult(`Proposal queued (id=${id}). The user will see a diff card and choose to Apply or Reject.`);
    }),
    { annotations: { readOnlyHint: false, destructiveHint: false } }
  );

  const proposeSkill = defTool(
    'propose_skill_change',
    'Propose creating, updating, or deleting ONE skill file. Does not apply — surfaces an approval card. For create/update include full content. For delete omit content. If you are removing a skill that is really reference material (not a workflow), write it as a fenced markdown block in your reply so the user can download and add it to the Knowledge Library.',
    {
      category: z.string().min(1),
      filename: z.string().min(1),
      action: z.enum(['create', 'update', 'delete']),
      content: z.string().optional(),
      rationale: z.string().min(1),
    },
    wrap('propose_skill_change', async ({ category, filename, action, content, rationale }) => {
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
          rationale, status: 'applied',
        });
        return textResult(`Applied ${action} for ${category}/${filename}.`);
      }
      ctx.proposals.push({
        kind: 'skill', id, category, filename, action,
        content: action === 'delete' ? undefined : content,
        rationale, status: 'pending',
      });
      return textResult(`Proposal queued (id=${id}) for ${action} ${category}/${filename}.`);
    }),
    { annotations: { readOnlyHint: false, destructiveHint: false } }
  );

  const proposeMemory = defTool(
    'propose_memory_change',
    'Propose creating, rewriting, or deleting ONE memory row. For `create`, provide name + memoryType + content (memoryId is ignored). For `update`, provide memoryId + content (memoryType optional — include it to retype a mis-categorized memory). For `delete`, provide memoryId only. If the edit strips domain knowledge out of the memory, write it as a fenced markdown block in your reply so the user can download and add it to the Knowledge Library.',
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
    },
    wrap('propose_memory_change', async ({ action, memoryId, name, memoryType, content, rationale }) => {
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
          rationale, status: 'pending',
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
        rationale, status: 'pending',
      });
      return textResult(`Proposal queued (id=${id}) for ${action} memory ${hit.name}.`);
    }),
    { annotations: { readOnlyHint: false, destructiveHint: true } }
  );

  // ── File-source tools ───────────────────────────────────────────────────
  // Verbatim reference documents the agent Reads at turn-time from
  // knowledge/sources/<name>.md. Scope is intentionally narrow: file type only.
  // URL and repo sources are pulled from remotes and not coach-editable.

  const MAX_FILE_SOURCE_BYTES = 1_048_576; // 1 MB

  const listFileSources = defTool(
    'list_file_sources',
    "List every file-type knowledge source across all wiki folders assigned to this agent, with id, name, folder name, word count, status, and a 200-char preview. URL and repo sources are NOT included.",
    {},
    wrap('list_file_sources', async () => {
      const r = await getDb().query(
        `SELECT ws.id, ws.name, ws.content, ws.word_count, ws.status, ws.last_synced, wf.name as folder_name
         FROM wiki_sources ws
         JOIN agent_wiki_folders awf ON awf.folder_id = ws.folder_id
         JOIN wiki_folders wf ON wf.id = ws.folder_id
         WHERE awf.agent_id = $1 AND ws.type = 'file'
         ORDER BY ws.created_at DESC`,
        [ctx.agentId],
      );
      if (r.rows.length === 0) return textResult('(no file sources in assigned wiki folders)');
      const lines = r.rows.map(row => {
        const preview = ((row.content as string) ?? '').slice(0, 200).replace(/\s+/g, ' ').trim();
        return `- id=${row.id} name="${row.name}" folder="${row.folder_name}" words=${row.word_count} status=${row.status}${row.last_synced ? ` last_synced=${row.last_synced}` : ''}\n    preview: ${preview}${preview.length === 200 ? '…' : ''}`;
      });
      return textResult(lines.join('\n'));
    }),
    { annotations: { readOnlyHint: true } }
  );

  const readFileSource = defTool(
    'read_file_source',
    'Return the full verbatim content of one file source by id. Call list_file_sources first to pick the id.',
    { sourceId: z.string().min(1, 'sourceId required') },
    wrap('read_file_source', async ({ sourceId }) => {
      const r = await getDb().query(
        `SELECT ws.name, ws.content FROM wiki_sources ws
         JOIN agent_wiki_folders awf ON awf.folder_id = ws.folder_id
         WHERE ws.id = $1 AND awf.agent_id = $2 AND ws.type = 'file'`,
        [sourceId, ctx.agentId],
      );
      if (r.rows.length === 0) throw new Error(`file source not found: ${sourceId}`);
      const content = (r.rows[0].content as string) ?? '';
      return textResult(`# ${r.rows[0].name}\n\n${content || '(empty)'}`);
    }),
    { annotations: { readOnlyHint: true } }
  );

  const proposeFileSourceChange = defTool(
    'propose_file_source_change',
    'Propose updating or deleting ONE file-type knowledge source in an assigned wiki folder. Does not apply — surfaces an approval card. On Apply the source row is saved; the wiki is NOT auto-rebuilt (the folder owner clicks Build Wiki in the Knowledge Library). For `update`: provide sourceId + content (name optional to rename). For `delete`: provide sourceId only. Creating new sources must be done by the folder owner in the Knowledge Library UI — coach cannot create sources. Content capped at 1 MB.',
    {
      action: z.enum(['update', 'delete']),
      /** Required for update/delete. Get from list_file_sources. */
      sourceId: z.string().min(1, 'sourceId required'),
      /** Optional on update (rename). Ignored on delete. */
      name: z.string().optional(),
      /** Required for update. Omit for delete. Capped at 1 MB. */
      content: z.string().optional(),
      rationale: z.string().min(1),
    },
    wrap('propose_file_source_change', async ({ action, sourceId, name, content, rationale }) => {
      const id = randomUUID();

      if (content && Buffer.byteLength(content, 'utf8') > MAX_FILE_SOURCE_BYTES) {
        throw new Error(`content exceeds 1 MB cap (${Buffer.byteLength(content, 'utf8')} bytes)`);
      }

      const r = await getDb().query(
        `SELECT ws.id, ws.name FROM wiki_sources ws
         JOIN agent_wiki_folders awf ON awf.folder_id = ws.folder_id
         WHERE ws.id = $1 AND awf.agent_id = $2 AND ws.type = 'file'`,
        [sourceId, ctx.agentId],
      );
      if (r.rows.length === 0) throw new Error(`file source not found: ${sourceId}`);
      const existingName = r.rows[0].name as string;

      if (action === 'update' && !content) throw new Error('content is required for update');

      ctx.proposals.push({
        kind: 'file-source', id, action,
        sourceId,
        name: name ?? existingName,
        content: action === 'delete' ? undefined : content,
        rationale, status: 'pending',
      });
      return textResult(`Proposal queued (id=${id}) for ${action} file source ${existingName}.`);
    }),
    { annotations: { readOnlyHint: false, destructiveHint: true } }
  );

  return [readClaudeMd, listSkills, readSkill, listMcps, readMemories, proposeClaudeMd, proposeSkill, proposeMemory, listFileSources, readFileSource];
}

// ────────────────────────────────────────────────────────────────────────────
// Turn handler
// ────────────────────────────────────────────────────────────────────────────

export interface CoachTurnInput {
  agentId: string;
  userMessage: string;
  /** Optional text content from an attached file. Appended as a tagged block. */
  attachment?: string;
  /** Original filename of the attached file, if any. */
  attachmentName?: string;
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
    'mcp__coach__list_file_sources',
    'mcp__coach__read_file_source',
    'mcp__coach__propose_claude_md_update',
    'mcp__coach__propose_skill_change',
    'mcp__coach__propose_memory_change',
    'mcp__coach__propose_file_source_change',
    'WebFetch',
    'WebSearch',
  ];

  const attachmentText = input.attachment?.slice(0, MAX_ATTACHMENT_CHARS);
  const userBlock = attachmentText
    ? `${input.userMessage}\n\n<attached_file name="${input.attachmentName ?? 'attachment'}">\n${attachmentText}\n</attached_file>`
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

  // Admin-configurable via Settings → General → AI. Falls back to the
  // subscription-friendly default rather than whatever the CLI picks.
  const coachModel = (await readSetting(COACH_MODEL_SETTING_KEY)) ?? DEFAULT_COACH_MODEL;

  let assistantText = '';
  let finalSessionId: string | undefined = input.sdkSessionId;

  try {
    for await (const msg of query({
      prompt,
      options: {
        model: coachModel,
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
