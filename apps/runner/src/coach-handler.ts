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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CoachProposal, CheckConfig } from '@slackhive/shared';
import { getDb, DEFAULT_COACH_MODEL, COACH_MODEL_SETTING_KEY, AGENT_BACKEND_SETTING_KEY, DEFAULT_AGENT_BACKEND } from '@slackhive/shared';
import type { Agent } from '@slackhive/shared';
import { createCodexClient, baseCodexConfig, resolveCodexModel } from './backends/codex-config';
import { writeSkillsTree } from './compile-instructions';
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
When the user asks to AUDIT / review / "flag what's weak": deliver BOTH (1) a concise prose report grouped by severity AND (2) apply/reject proposal cards for the concrete, SAFE, surgical fixes you find. The cards are the point — the user wants to click Apply on the easy wins. The report carries the judgment calls and recommendations that aren't safe to auto-apply.

**DO emit a proposal card** (be generous) for low-risk, high-confidence, targeted fixes: a typo, a malformed/broken code fence, a stale or self-contradictory line, a small wording clarification, or a single-skill UPDATE that strips one wrong section while keeping the rest. These are exactly what Apply/Reject is for.

**Do NOT emit a card — put it in the prose report instead** for anything destructive or judgment-heavy: deleting a whole skill/memory, replacing CLAUDE.md wholesale, splitting/restructuring a large skill, or anything needing an operator decision (e.g. "connect this MCP"). **In an audit turn you must NEVER DELETE a skill/memory or replace the full instructions unless the user explicitly told you to make that change.** Use the checklist below to find issues; route each finding to a card or the report by the rule above.

**Missing-tool content is NOT dead weight by default.** If a skill or instruction references an MCP/tool that is not in \`list_mcps\` (e.g. OpenMetadata or a Slack upload tool the instructions assume), the most likely fix is to CONNECT that MCP — NOT to delete the skill or strip the instruction. Flag the mismatch, name the missing capability, and recommend connecting it. Propose deletion of that content only if the user confirms the capability is permanently gone.

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
- **Least-destructive first.** Prefer the smallest targeted edit that fixes the problem. DELETE and wholesale CLAUDE.md rewrites are last resorts that require high confidence AND clear user intent to change things. A single turn must never gut an agent — if you find yourself about to delete multiple skills or replace the entire instructions, STOP and instead report the findings in prose and ask the user what to change.
- **Don't delete content for a missing tool.** If content references an MCP/tool not in \`list_mcps\`, recommend connecting the tool; only delete if the user confirms the capability is gone for good.
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
): Promise<{ sdkSessionId?: string; backend?: string; messages: unknown[] }> {
  const raw = await readSetting(sessionKey(agentId));
  if (!raw) return { messages: [] };
  try { return JSON.parse(raw); } catch { return { messages: [] }; }
}

export async function saveCoachSession(
  agentId: string,
  data: { sdkSessionId?: string; backend?: string; messages: unknown[] }
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
   * The backend that minted `sdkSessionId`. Session ids are backend-specific
   * (Claude SDK session UUID vs Codex thread id), so if this differs from the
   * currently-active backend the stale id is ignored and a fresh session is
   * started — otherwise the new backend tries to resume a foreign id and breaks.
   */
  sessionBackend?: string;
  /**
   * When true, proposals auto-apply and the bootstrap appendix is added to the
   * system prompt. Set only by the new-agent wizard's first turn.
   */
  autoApply?: boolean;
  /** Emits streamed events for SSE. Must not throw. */
  emit: (ev: CoachStreamEvent) => void;
}

/** Shared return shape for a single coach turn across backends. */
export interface CoachTurnResult {
  sdkSessionId?: string;
  /** The backend this turn ran on — persist it so the next turn can detect a switch. */
  backend: string;
  proposals: CoachProposal[];
  assistantText: string;
  toolCalls: { name: string; input: Record<string, unknown>; ok: boolean }[];
}

/**
 * Decide whether a stored coach session id may be resumed on the currently-active
 * backend. Session ids are backend-specific — a Claude Agent SDK session UUID is
 * meaningless to Codex's `resumeThread`, and vice-versa — so when the active
 * backend differs from the one that minted the id (the user switched AI backend),
 * the stale id is dropped and a fresh full-context session is started instead of
 * blindly resuming a foreign one (which is what broke the coach).
 *
 * @returns the id to resume, or `undefined` to start a new session.
 */
export function resumeSessionFor(
  activeBackend: string,
  sessionBackend: string | undefined,
  sdkSessionId: string | undefined,
): string | undefined {
  if (!sdkSessionId) return undefined;
  // No backend tag (session pre-dates tagging): we can't know which backend minted
  // the id, and resuming a foreign id HARD-ERRORS, whereas starting fresh only loses
  // resume continuity once (self-heals — the session gets tagged this turn). So drop
  // it rather than guess. Guessing "default backend" would still mis-resume on a
  // non-default workspace or break on the default one.
  if (!sessionBackend) return undefined;
  if (sessionBackend !== activeBackend) return undefined;
  return sdkSessionId;
}

/** Coach model under Codex — falls back to the default if a Claude id is configured. */
async function codexCoachModel(): Promise<string> {
  return resolveCodexModel(await readSetting(COACH_MODEL_SETTING_KEY));
}

/**
 * Per-turn coach workspace dir. Unique per call (randomUUID) so concurrent coach
 * turns for the same agent — two browser tabs, rapid messages — never race on the
 * same directory (each turn re-materializes + rmSyncs its own dir in finally).
 */
function coachWorkDir(agentId: string): string {
  return path.join(os.tmpdir(), `slackhive-coach-${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${randomUUID()}`);
}

const sanitizeFileName = (s: string): string => String(s ?? 'item').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'item';

/**
 * Materialize the agent's state as FILES in a read-only coach workspace and
 * return a COMPACT index. The model reads only the files it needs (scales to big
 * skills) instead of having everything preloaded into the prompt. One DB fetch
 * feeds both the files and the index. Backend-neutral — both Claude (Read tool)
 * and Codex (native file read under read-only) consume the same workspace.
 */
async function prepareCoachWorkspace(agent: Agent): Promise<{ dir: string; index: string }> {
  const dir = coachWorkDir(agent.id); // unique per turn — no pre-existing dir to clear
  fs.mkdirSync(dir, { recursive: true });

  const [skills, memories, mcps, sources] = await Promise.all([
    getAgentSkills(agent.id),
    getAgentMemories(agent.id),
    getAgentMcpServers(agent.id),
    getDb().query(
      `SELECT ws.id, ws.name, ws.word_count, ws.status, ws.content, wf.name as folder_name
       FROM wiki_sources ws
       JOIN agent_wiki_folders awf ON awf.folder_id = ws.folder_id
       JOIN wiki_folders wf ON wf.id = ws.folder_id
       WHERE awf.agent_id = $1 AND ws.type = 'file'
       ORDER BY ws.created_at DESC`,
      [agent.id],
    ).then(r => r.rows).catch(() => [] as Record<string, unknown>[]),
  ]);

  // Files the model can Read on demand.
  fs.writeFileSync(path.join(dir, 'current-instructions.md'), agent.claudeMd?.trim() || '(empty — no instructions yet)');
  writeSkillsTree(dir, skills, null); // → skills/<category>/<filename>.md
  const memDir = path.join(dir, 'memory'); fs.mkdirSync(memDir, { recursive: true });
  for (const m of memories) {
    fs.writeFileSync(path.join(memDir, `${sanitizeFileName(String(m.id))}.md`), `# ${m.name} [${m.type}] (memoryId=${m.id})\n\n${m.content}`);
  }
  fs.writeFileSync(path.join(dir, 'mcp-servers.md'),
    mcps.length ? mcps.map(m => `- ${m.name} (${m.type}) — ${m.description ?? ''}`).join('\n') : '(none)');
  // Assign a UNIQUE filename per source up front (distinct names can sanitize to
  // the same string) so writes don't clobber each other and the index points at
  // the exact file that exists.
  const usedSrcNames = new Set<string>();
  const srcEntries = sources.map((row) => {
    const base = sanitizeFileName(String(row.name));
    let file = base;
    for (let i = 2; usedSrcNames.has(file); i++) file = `${base}-${i}`;
    usedSrcNames.add(file);
    return { row, file };
  });
  const srcDir = path.join(dir, 'knowledge-sources'); fs.mkdirSync(srcDir, { recursive: true });
  for (const { row, file } of srcEntries) {
    fs.writeFileSync(path.join(srcDir, `${file}.md`), String(row.content ?? ''));
  }

  // Compact index (names + one-liners, never full content).
  const skillLines = skills.map(s => {
    const first = (s.content.split('\n').find((l: string) => l.trim()) ?? '').slice(0, 120);
    const f = s.filename.endsWith('.md') ? s.filename : `${s.filename}.md`;
    return `- skills/${s.category}/${f} — ${first}`;
  });
  const memLines = memories.map(m => `- memory/${sanitizeFileName(String(m.id))}.md — memoryId=${m.id} [${m.type}] ${m.name}`);
  const srcLines = srcEntries.map(({ row, file }) =>
    `- knowledge-sources/${file}.md — "${row.name}" (folder=${row.folder_name}, words=${row.word_count})`);
  const index = [
    '## Skills (read the file for full content)',
    skillLines.length ? skillLines.join('\n') : '(none)',
    '## Memories (use memoryId for update/delete)',
    memLines.length ? memLines.join('\n') : '(none)',
    '## MCP servers',
    mcps.length ? mcps.map(m => `- ${m.name} (${m.type}) — ${m.description ?? ''}`).join('\n') : '(none)',
    '## Knowledge file-sources',
    srcLines.length ? srcLines.join('\n') : '(none)',
  ].join('\n\n');

  return { dir, index };
}

const COACH_PROTOCOL = `
# TOOLING — READ THIS, IT OVERRIDES THE SECTION ABOVE
The instructions above mention named tools like \`propose_claude_md_update\`, \`propose_skill_change\`, \`propose_memory_change\`, \`read_claude_md\`, \`list_skills\`, \`read_skill\`, \`list_mcps\`, \`read_memories\`, \`list_file_sources\`, \`read_file_source\`. **Those tools DO NOT EXIST here.** Translate them as follows:
- To INSPECT current state → READ the corresponding file in your working directory (you have read-only file access).
- To PROPOSE any change → emit it in the \`coach-proposals\` JSON block described below. Prose alone NEVER creates a proposal — every change you recommend MUST appear in the block.

Read only what's relevant to the request (the index below lists what exists). You cannot write files. Files available:
- \`current-instructions.md\` — the agent's current instructions (this is the "CLAUDE.md" the above refers to)
- \`skills/<category>/<filename>.md\` — each skill's full content
- \`memory/<id>.md\` — each learned memory
- \`knowledge-sources/<name>.md\` — operator-provided reference docs (read-only; you cannot change these)
- \`mcp-servers.md\` — connected MCP servers

When you want to propose concrete changes, append EXACTLY ONE fenced block at the very end of your reply:

\`\`\`coach-proposals
[
  { "kind": "instructions", "content": "<full new instructions>", "rationale": "<one sentence>" },
  { "kind": "skill", "action": "create|update|delete", "category": "<cat>", "filename": "<file.md>", "content": "<body>", "rationale": "<one sentence>" },
  { "kind": "memory", "action": "update|delete", "memoryId": "<id>", "memoryName": "<name>", "memoryType": "user|feedback|project|reference", "content": "<body>", "rationale": "<one sentence>" },
  { "kind": "eval-case-check", "caseId": "<id>", "triage": "test_mismatch", "checks": [ <full replacement checks array> ], "rationale": "<one sentence>" }
]
\`\`\`

Rules: one proposal per distinct change; for skill/memory delete omit content; for update include the existing id (memoryId) / category+filename. Include the block ONLY if you have concrete changes — otherwise omit it entirely and write nothing after your prose.

# Eval-failure triage
When the user attaches an \`<eval_failure>\` block (a failing regression test for this agent — it carries \`case_id\`, the case question, the current \`checks\`, the agent's reply, observed tool calls, per-check verdicts, and any judge reasoning), classify the failure as exactly ONE of:
- **skill_issue** — the agent behaved wrongly; the checks were reasonable. Fix by proposing an \`instructions\` or \`skill\` change (the existing kinds above).
- **test_mismatch** — the agent's behavior was acceptable but the checks didn't capture it (over-narrow tool assertion, a different valid path, too-specific substring, wrong primitive). Fix by emitting an \`eval-case-check\` proposal with the \`case_id\` from the block and the FULL corrected \`checks\` array (it overwrites the existing one on Apply). Each check is one of: \`{ "primitive": "substring", "target": "final_reply", "must_contain": [...], "must_not_contain": [...] }\` | \`{ "primitive": "tool_called", "must_call": [...], "must_not_call": [...] }\` | \`{ "primitive": "llm_judge", "target": "final_reply", "rubric": "...", "groundtruth": "..." }\`.
- **real_failure** — the test correctly caught a true failure but the right fix is unclear (ambiguous spec, missing context). Do NOT propose; ask ONE specific clarifying question.
Read the relevant parts of the block before triaging — never propose a check change without understanding why the existing check fired.`;

/** Inputs each coach backend runner receives. Workspace is read-only. */
interface CoachRunOpts {
  prompt: string;
  workDir: string;
  resumeId?: string;
  emit: (ev: CoachStreamEvent) => void;
}
/** One backend's implementation of a coach turn: prompt in, text + resumable id out. */
type CoachBackendRunner = (opts: CoachRunOpts) => Promise<{ text: string; sessionId?: string }>;

/** Codex: read-only sandbox thread with live web search. */
const runCodexCoachTurn: CoachBackendRunner = async (opts) => {
  const model = await codexCoachModel();
  const codex = await createCodexClient(baseCodexConfig());
  const threadOpts = {
    workingDirectory: opts.workDir, skipGitRepoCheck: true,
    sandboxMode: 'read-only' as const, approvalPolicy: 'never' as const,
    webSearchEnabled: true, webSearchMode: 'live' as const, model,
  };
  const thread = opts.resumeId ? codex.resumeThread(opts.resumeId, threadOpts) : codex.startThread(threadOpts);
  const turn = await thread.run(opts.prompt);
  return { text: turn.finalResponse ?? '', sessionId: thread.id ?? opts.resumeId };
};

/** Claude Agent SDK: read-only file tools (Read/Glob/Grep) + web; writes/bash denied. */
const runClaudeCoachTurn: CoachBackendRunner = async (opts) => {
  const model = (await readSetting(COACH_MODEL_SETTING_KEY)) ?? DEFAULT_COACH_MODEL;
  let text = '';
  let sessionId = opts.resumeId;
  for await (const msg of query({
    prompt: opts.prompt,
    options: {
      model,
      cwd: opts.workDir,
      allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'Bash', 'BashOutput', 'Task', 'NotebookEdit', 'TodoWrite', 'ExitPlanMode'],
      permissionMode: 'bypassPermissions',
      maxTurns: 12,
      resume: opts.resumeId,
    } as Record<string, unknown>,
  })) {
    const m = msg as { type: string; subtype?: string; session_id?: string; message?: { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] }; result?: string };
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) sessionId = m.session_id;
    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text) text += b.text;
        else if (b.type === 'tool_use' && b.name) opts.emit({ type: 'tool', name: b.name, input: b.input ?? {}, ok: true });
      }
    }
    if (m.type === 'result') {
      if (m.session_id && !sessionId) sessionId = m.session_id;
      if (typeof m.result === 'string' && !text.trim()) text = m.result;
    }
  }
  return { text, sessionId };
};

/**
 * Coach backend registry. To support a NEW backend, add one runner function and
 * register it here — nothing else in the coach flow needs to change (session
 * portability is handled generically by {@link resumeSessionFor}).
 */
const COACH_BACKENDS: Record<string, CoachBackendRunner> = {
  codex: runCodexCoachTurn,
  claude: runClaudeCoachTurn,
};

/** Resolve a backend name to its runner, falling back to the default backend. */
export function resolveCoachBackend(backend: string): CoachBackendRunner {
  return COACH_BACKENDS[backend] ?? COACH_BACKENDS[DEFAULT_AGENT_BACKEND] ?? runClaudeCoachTurn;
}

/**
 * Run one coach turn on the active backend over a read-only workspace, returning
 * the model's text + a resumable session id. The single backend-dispatch point
 * for Coach (parallels generateText / createAgentBackend).
 */
async function runCoachModelTurn(opts: { backend: string } & CoachRunOpts): Promise<{ text: string; sessionId?: string }> {
  return resolveCoachBackend(opts.backend)(opts);
}

/**
 * Extract the proposals array from the model's reply.
 *
 * Robust to two things models actually do: (1) using a ```json / bare ``` fence
 * instead of the documented ```coach-proposals label, and (2) putting markdown
 * code fences INSIDE a proposal's `content` (e.g. ```sql examples), which breaks
 * any ```…``` regex. We scan for balanced top-level JSON arrays in a STRING-AWARE
 * way (brackets/fences inside JSON strings are ignored) and keep the last one
 * that looks like a proposal array (objects with a `kind`). Returns the prose
 * (proposal block + wrapping fence stripped) and the raw proposals.
 */
export function parseCoachProposals(text: string): { message: string; raw: Record<string, unknown>[] } {
  const isProposalArray = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.length > 0 && v.every((e) => e && typeof e === 'object' && 'kind' in (e as object));

  let found: { start: number; end: number; raw: Record<string, unknown>[] } | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') {
        if (--depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(i, j + 1));
            if (isProposalArray(parsed)) found = { start: i, end: j + 1, raw: parsed as Record<string, unknown>[] };
          } catch { /* not valid JSON — keep scanning */ }
          i = j;
          break;
        }
      }
    }
  }
  if (!found) return { message: text.trim(), raw: [] };

  // Drop the array plus any wrapping fence so the prose message reads cleanly.
  const before = text.slice(0, found.start);
  const openFence = before.match(/```(?:json|coach-proposals)?\s*$/);
  const cut = openFence ? before.length - openFence[0].length : found.start;
  const after = text.slice(found.end).replace(/^\s*```/, '');
  return { message: (text.slice(0, cut) + after).trim(), raw: found.raw };
}

async function mapAndApplyProposal(agentId: string, p: Record<string, any>, autoApply: boolean): Promise<CoachProposal | null> {
  const id = randomUUID();
  const rationale = typeof p.rationale === 'string' ? p.rationale : 'Proposed by Coach.';

  // Instruction-doc proposal. Accept neutral + legacy kind names; the internal
  // CoachProposal kind stays 'claude-md' (the DB column is agents.claude_md).
  if ((p.kind === 'instructions' || p.kind === 'agents-md' || p.kind === 'claude-md') && typeof p.content === 'string') {
    if (autoApply) { await updateAgentClaudeMd(agentId, p.content); return { kind: 'claude-md', id, content: p.content, rationale, status: 'applied' }; }
    return { kind: 'claude-md', id, content: p.content, rationale, status: 'pending' };
  }

  if (p.kind === 'skill' && p.category && p.filename && p.action) {
    try { assertSafeSkillPath(p.category, p.filename); } catch { return null; }
    const content = p.action === 'delete' ? undefined : (typeof p.content === 'string' ? p.content : '');
    if (autoApply) {
      if (p.action === 'delete') await deleteSkill(agentId, p.category, p.filename);
      else {
        const existing = (await getAgentSkills(agentId)).find(s => s.category === p.category && s.filename === p.filename);
        await upsertSkill(agentId, p.category, p.filename, content ?? '', existing?.sortOrder ?? 0);
      }
      return { kind: 'skill', id, category: p.category, filename: p.filename, action: p.action, content, rationale, status: 'applied' };
    }
    return { kind: 'skill', id, category: p.category, filename: p.filename, action: p.action, content, rationale, status: 'pending' };
  }

  if (p.kind === 'memory' && p.action) {
    // The coach only ever updates/deletes existing memories (it never creates
    // them). Both require a target memoryId — drop the proposal if it's missing
    // so Apply can never run an UPDATE/DELETE that matches the wrong rows.
    if ((p.action === 'update' || p.action === 'delete') && !p.memoryId) return null;
    // Memory proposals always queue for UI approval (matches the Claude path).
    return {
      kind: 'memory', id,
      memoryId: p.memoryId, memoryName: p.memoryName ?? p.name ?? '(memory)',
      action: p.action, memoryType: p.memoryType,
      content: p.action === 'delete' ? undefined : p.content,
      rationale, status: 'pending',
    };
  }

  // Eval test-case check change (test_mismatch triage). The model supplies the
  // full replacement `checks` array + caseId; we look up the case's question +
  // current checks for the Before/After approval card. Always queued (never
  // auto-applied) — the human Applies via the eval cases route.
  if (p.kind === 'eval-case-check' && typeof p.caseId === 'string' && Array.isArray(p.checks)) {
    const r = await getDb().query('SELECT question, checks FROM eval_cases WHERE id = $1 AND agent_id = $2', [p.caseId, agentId]);
    if (r.rows.length === 0) return null;
    const rawChecks = (r.rows[0] as { checks: unknown }).checks;
    const before = (typeof rawChecks === 'string' ? JSON.parse(rawChecks) : rawChecks ?? []) as CheckConfig[];
    const triage = (p.triage === 'skill_issue' || p.triage === 'real_failure') ? p.triage : 'test_mismatch';
    return {
      kind: 'eval-case-check', id,
      caseId: p.caseId,
      caseQuestion: (r.rows[0] as { question: string }).question,
      triage,
      before,
      after: p.checks as CheckConfig[],
      rationale, status: 'pending',
    };
  }

  return null;
}


/**
 * Run one coach turn for the active backend. Unified across Claude and Codex:
 * materialize the agent state as a read-only file workspace + compact index, run
 * a read-only model turn (the model reads only the files it needs — scales to
 * large skills), then parse `coach-proposals` into approval cards. The only
 * backend-specific step is runCoachModelTurn's dispatch.
 */
export async function runCoachTurn(input: CoachTurnInput): Promise<CoachTurnResult> {
  const agent = await getAgentById(input.agentId);
  if (!agent) throw new Error('agent not found');
  const backend = (await readSetting(AGENT_BACKEND_SETTING_KEY)) ?? DEFAULT_AGENT_BACKEND;
  const proposals: CoachProposal[] = [];

  const { dir, index } = await prepareCoachWorkspace(agent);

  const attachmentText = input.attachment?.slice(0, MAX_ATTACHMENT_CHARS);
  const userBlock = attachmentText
    ? `${input.userMessage}\n\n<attached_file name="${input.attachmentName ?? 'attachment'}">\n${attachmentText}\n</attached_file>`
    : input.userMessage;

  const sys = input.autoApply ? SYSTEM_PROMPT + BOOTSTRAP_APPENDIX : SYSTEM_PROMPT;
  // Restated last (recency) so the output-format rule isn't lost at the end of a
  // long prompt — the #1 cause of the model describing a change in prose without
  // emitting the machine-readable block.
  const reminder = 'REMINDER: If your reply makes or recommends ANY change to the instructions, a skill, or a memory, you MUST end with the ```coach-proposals``` JSON block. A prose description is NOT a proposal and will be silently dropped. For an audit / "flag what\'s weak" / review request, give a prose report AND emit apply/reject cards for the safe surgical fixes you find (typos, broken fences, stale/contradictory lines, small single-skill UPDATEs) — be generous with those. But NEVER, in an audit turn, delete a skill/memory or replace the full instructions unless the user explicitly asked to make that change, and if content references a tool that is not connected, recommend connecting it instead of deleting the content.';
  // First turn carries full context; resume turns send only the user message
  // (the model retains the system prompt + workspace orientation in context).
  const fullPrompt = [
    sys,
    COACH_PROTOCOL,
    `# Agent you are tuning\nName: ${agent.name}\nPersona: ${agent.persona ?? '(none)'}\nDescription: ${agent.description ?? '(none)'}`,
    `# Current state index (read files under the working dir for detail)\n${index}`,
    `# User message\n${userBlock}`,
    reminder,
  ].join('\n\n');
  // Drop a stale, foreign session id when the user switched backend mid-thread.
  const resumeId = resumeSessionFor(backend, input.sessionBackend, input.sdkSessionId);
  const prompt = resumeId ? `${userBlock}\n\n${reminder}` : fullPrompt;

  let assistantText = '';
  let sessionId = resumeId;
  try {
    const r = await runCoachModelTurn({ backend, prompt, workDir: dir, resumeId, emit: input.emit });
    assistantText = r.text;
    sessionId = r.sessionId ?? sessionId;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.error('coach turn failed', { agentId: input.agentId, backend, error: message });
    input.emit({ type: 'error', message });
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const { message, raw } = parseCoachProposals(assistantText);
  for (const p of raw) {
    try {
      const mapped = await mapAndApplyProposal(input.agentId, p, !!input.autoApply);
      if (mapped) proposals.push(mapped);
    } catch (err) {
      logger.warn('coach: proposal map/apply failed', { error: (err as Error).message });
    }
  }
  if (message) input.emit({ type: 'text', delta: message });

  // Bootstrap safety net: guarantee a startable agent on the wizard's first turn.
  if (input.autoApply && !proposals.some(p => p.kind === 'claude-md' && p.status === 'applied') && !agent.claudeMd?.trim()) {
    const skeleton = `# ${agent.name}\n\n${agent.persona || agent.description || 'You are a helpful Slack assistant.'}`;
    try { await updateAgentClaudeMd(input.agentId, skeleton); } catch { /* non-fatal */ }
  }

  for (const p of proposals) input.emit({ type: 'proposal', proposal: p });
  input.emit({ type: 'done', sdkSessionId: sessionId });
  return { sdkSessionId: sessionId, backend, proposals, assistantText: message, toolCalls: [] };
}
