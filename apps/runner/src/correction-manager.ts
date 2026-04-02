/**
 * @fileoverview Generic correction manager for any SlackHive agent.
 *
 * Corrections are stored as a skill in the database (category: '99-corrections',
 * filename: 'corrections.md') so they:
 * - Persist across container restarts (Postgres)
 * - Are visible/editable in the SlackHive web UI Skills tab
 * - Are automatically compiled into the agent's CLAUDE.md
 *
 * Uses Claude to intelligently consolidate new corrections (dedup, categorize).
 *
 * Adapted from nlq-claude-slack-bot/src/correction-manager.ts.
 * Key changes: flat file -> Postgres skill, NLQ-specific -> generic agent.
 *
 * @module runner/correction-manager
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { upsertSkill, deleteSkill, getAgentSkills } from './db';
import { compileClaudeMd } from './compile-claude-md';
import type { Agent } from '@slackhive/shared';
import { agentLogger } from './logger';

const CORRECTIONS_CATEGORY = '99-corrections';
const CORRECTIONS_FILENAME = 'corrections.md';
const CORRECTIONS_SORT_ORDER = 99;
const MAX_CORRECTIONS = 30;

export interface AddResult {
  success: boolean;
  message: string;
  count: number;
}

export class CorrectionManager {
  private agent: Agent;
  private log;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(agent: Agent) {
    this.agent = agent;
    this.log = agentLogger(agent.slug);
  }

  /**
   * Reads the current corrections content from the database.
   */
  async readCorrections(): Promise<string> {
    try {
      const skills = await getAgentSkills(this.agent.id);
      const correctionSkill = skills.find(
        (s) => s.category === CORRECTIONS_CATEGORY && s.filename === CORRECTIONS_FILENAME
      );
      return correctionSkill?.content ?? '';
    } catch (error) {
      this.log.error('Failed to read corrections from DB', { error });
      return '';
    }
  }

  /**
   * Counts the number of corrections (lines starting with digits followed by a dot).
   */
  async getCount(): Promise<number> {
    const content = await this.readCorrections();
    if (!content) return 0;
    const matches = content.match(/^\d+\.\s/gm);
    return matches ? matches.length : 0;
  }

  /**
   * Adds a new correction, using Claude to consolidate and deduplicate.
   * Serializes writes to prevent race conditions.
   */
  async addCorrection(text: string, reviewerId: string, threadContext?: string): Promise<AddResult> {
    const result = await new Promise<AddResult>((resolve) => {
      this.writeChain = this.writeChain.then(async () => {
        resolve(await this._addCorrection(text, reviewerId, threadContext));
      }).catch((error) => {
        this.log.error('Write chain error', { error });
        resolve({ success: false, message: 'Internal error adding correction.', count: 0 });
      });
    });
    return result;
  }

  private async _addCorrection(text: string, reviewerId: string, threadContext?: string): Promise<AddResult> {
    const existing = await this.readCorrections();
    const count = await this.getCount();
    const slug = this.agent.slug;

    if (count >= MAX_CORRECTIONS) {
      return {
        success: false,
        message: `At capacity (${MAX_CORRECTIONS}/${MAX_CORRECTIONS}). Remove an old correction first with \`${slug}:corrections remove <N>\`.`,
        count,
      };
    }

    const today = new Date().toLocaleDateString('en-SG', {
      timeZone: 'Asia/Singapore', year: 'numeric', month: 'short', day: 'numeric',
    });

    const agentDesc = this.agent.description
      ? `a ${this.agent.description} bot`
      : `the ${this.agent.name} bot`;

    const threadContextBlock = threadContext
      ? `\nTHREAD CONTEXT (the conversation that prompted this correction):\n${threadContext}\n`
      : '';

    const threadContextTask = threadContext
      ? `\n7. Use the thread context to understand what went wrong, but write the correction as a GENERAL rule\n   (not specific to this one question). The correction should help the bot handle ALL similar cases.`
      : '';

    const consolidationPrompt = `You maintain a corrections file for ${agentDesc}.

CURRENT FILE:
---
${existing || '(empty)'}
---

NEW CORRECTION (submitted by reviewer):
"${text}"
${threadContextBlock}
Reviewer ID: @${reviewerId}
Date: ${today}

Tasks:
1. If this duplicates an existing correction, respond with ONLY: DUPLICATE: <number>
2. If this supersedes/updates an existing one, replace it
3. If it's new, add it to the appropriate category (create a new category if needed)
4. Keep corrections numbered sequentially across all categories
5. Keep each correction as a single concise line
6. Add attribution: (@${reviewerId}, ${today})${threadContextTask}

Respond with the FULL updated file content (including the # heading and ## categories).
If duplicate, respond with ONLY: DUPLICATE: <number>`;

    try {
      let responseText = '';

      for await (const message of query({
        prompt: consolidationPrompt,
        options: {
          permissionMode: 'bypassPermissions',
          tools: [],
          maxTurns: 1,
        },
      })) {
        if (message.type === 'assistant' && message.message.content) {
          for (const part of message.message.content) {
            if ((part as any).type === 'text') {
              responseText += (part as any).text;
            }
          }
        } else if (message.type === 'result' && (message as any).result) {
          responseText = (message as any).result;
        }
      }

      responseText = responseText.trim();

      // Check for duplicate
      if (responseText.startsWith('DUPLICATE:')) {
        const dupNum = responseText.replace('DUPLICATE:', '').trim();
        return {
          success: false,
          message: `This duplicates correction #${dupNum}. No changes made.`,
          count,
        };
      }

      // Store as a skill in the database
      await upsertSkill(
        this.agent.id,
        CORRECTIONS_CATEGORY,
        CORRECTIONS_FILENAME,
        responseText,
        CORRECTIONS_SORT_ORDER,
      );

      // Recompile CLAUDE.md so corrections take effect immediately
      await compileClaudeMd(this.agent);

      const newCount = await this.getCount();
      this.log.info('Correction added', { reviewerId, newCount });

      return {
        success: true,
        message: `Correction added (${newCount}/${MAX_CORRECTIONS} slots used).`,
        count: newCount,
      };
    } catch (error) {
      this.log.error('Failed to consolidate correction via Claude', { error });
      return {
        success: false,
        message: 'Failed to process correction. Please try again.',
        count,
      };
    }
  }

  /**
   * Removes a correction by its number and renumbers the rest.
   */
  async removeCorrection(index: number): Promise<{ success: boolean; message: string }> {
    const content = await this.readCorrections();
    if (!content) {
      return { success: false, message: 'No corrections on file.' };
    }

    const lines = content.split('\n');
    const targetPattern = new RegExp(`^${index}\\.\\s`);
    const lineIndex = lines.findIndex((line) => targetPattern.test(line));

    if (lineIndex === -1) {
      return { success: false, message: `Correction #${index} not found.` };
    }

    // Remove the line
    lines.splice(lineIndex, 1);

    // Renumber all remaining numbered items sequentially
    let num = 1;
    const renumbered = lines.map((line) => {
      if (/^\d+\.\s/.test(line)) {
        const replaced = line.replace(/^\d+\./, `${num}.`);
        num++;
        return replaced;
      }
      return line;
    });

    // Clean up empty category sections
    const cleaned: string[] = [];
    for (let i = 0; i < renumbered.length; i++) {
      const line = renumbered[i];
      if (line.startsWith('## ')) {
        let nextContentIdx = i + 1;
        while (nextContentIdx < renumbered.length && renumbered[nextContentIdx].trim() === '') {
          nextContentIdx++;
        }
        if (nextContentIdx >= renumbered.length || renumbered[nextContentIdx].startsWith('## ') || renumbered[nextContentIdx].startsWith('# ')) {
          i = nextContentIdx - 1;
          continue;
        }
      }
      cleaned.push(line);
    }

    const result = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    if (result === '# Verified Corrections' || result === '') {
      // All corrections removed — delete the skill
      await deleteSkill(this.agent.id, CORRECTIONS_CATEGORY, CORRECTIONS_FILENAME);
    } else {
      await upsertSkill(
        this.agent.id,
        CORRECTIONS_CATEGORY,
        CORRECTIONS_FILENAME,
        result + '\n',
        CORRECTIONS_SORT_ORDER,
      );
    }

    // Recompile CLAUDE.md
    await compileClaudeMd(this.agent);

    const newCount = await this.getCount();
    return {
      success: true,
      message: newCount > 0
        ? `Correction #${index} removed. ${newCount} correction(s) remaining.`
        : `Correction #${index} removed. No corrections remaining.`,
    };
  }

  /**
   * Returns the raw corrections content.
   */
  async getRaw(): Promise<string> {
    return this.readCorrections();
  }
}
