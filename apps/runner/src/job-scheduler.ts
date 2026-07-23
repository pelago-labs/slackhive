/**
 * @fileoverview Job scheduler — executes scheduled jobs via node-cron.
 *
 * On each cron trigger:
 * 1. Finds the boss agent from the runningAgents map
 * 2. Pre-posts a thread anchor in the target channel/DM and injects a
 *    [Sender: ...] header (channel + thread) into the prompt, so skills can
 *    reply or upload attachments into the job's own thread
 * 3. Sends the headed prompt to the boss via backend.streamQuery()
 * 4. Promotes the headline table into the anchor and threads the rest, so the
 *    top-level message shows the key table (not a bare title)
 * 5. Records the run in the job_runs table
 *
 * @module runner/job-scheduler
 */

import cron from 'node-cron';
import type { ScheduledJob, PlatformAdapter } from '@slackhive/shared';
import { JOB_SILENT_SENTINEL, parseJobSentinel, containsBareUrl } from '@slackhive/shared';
import { getAllEnabledJobs, getScheduledJobById, failOrphanedJobRuns, insertJobRun, updateJobRun } from './db';
import type { AgentBackend } from '@slackhive/shared';
import { logger } from './logger';

/** The shape of a running agent as exposed by AgentRunner. */
interface RunningAgent {
  adapter: PlatformAdapter;
  backend: AgentBackend;
}

/**
 * Instruction appended to a suppressible job's prompt. Asks the agent to reply
 * with the sentinel + a one-line reason when the skip condition is true. The
 * underscore in the token keeps it from colliding with natural prose ("no update").
 */
export function notificationGate(skipWhen: string): string {
  return `\n\n---\n[Notification gate: after completing the task above, evaluate whether this condition is TRUE: "${skipWhen.trim()}". `
    + `If it is TRUE (nothing worth notifying), your ENTIRE reply must be exactly \`${JOB_SILENT_SENTINEL}: <one short sentence explaining why>\` and nothing else. `
    + `If it is FALSE, reply normally with your full report and do not mention this gate.]`;
}

/**
 * True when the agent signalled "nothing to report" via the {@link JOB_SILENT_SENTINEL}.
 * Delegates to the shared parser (one source of truth with the web run-history view),
 * which tolerates markdown-wrapped sentinels and an optional trailing reason.
 */
export function isSilent(output: string): boolean {
  return parseJobSentinel(output).silent;
}

/**
 * Manages cron-scheduled jobs that are executed by any running agent.
 *
 * @example
 * ```ts
 * const scheduler = new JobScheduler((id) => agentRunner.getRunningAgent(id));
 * await scheduler.start();
 * ```
 */
export class JobScheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private running: Set<string> = new Set();

  /**
   * @param {(agentId: string) => RunningAgent | undefined} getAgent - Returns a running agent by ID.
   */
  constructor(private getAgent: (agentId: string) => RunningAgent | undefined) {}

  /**
   * Loads all enabled jobs from DB and schedules them.
   */
  async start(): Promise<void> {
    // Reconcile runs orphaned by a previous crash/restart so they don't show
    // as "running" forever in the UI.
    try {
      const reconciled = await failOrphanedJobRuns();
      if (reconciled > 0) logger.info('Reconciled orphaned job runs on startup', { count: reconciled });
    } catch (err) {
      logger.warn('Failed to reconcile orphaned job runs', { error: (err as Error).message });
    }
    await this.reload();
    logger.info('Job scheduler started');
  }

  /**
   * Run a job immediately, on demand (manual "Run now" — for testing).
   * Loads the job fresh so it works even if not currently scheduled/enabled.
   */
  async runNow(jobId: string): Promise<void> {
    const job = await getScheduledJobById(jobId);
    if (!job) {
      logger.warn('Manual run: job not found', { jobId });
      return;
    }
    logger.info('Manual job run triggered', { jobId, name: job.name });
    await this.executeJob(job);
  }

  /**
   * Destroys all cron tasks.
   */
  async stop(): Promise<void> {
    for (const [id, task] of this.tasks) {
      task.stop();
      logger.info('Job unscheduled', { jobId: id });
    }
    this.tasks.clear();
    logger.info('Job scheduler stopped');
  }

  /**
   * Reloads all jobs from DB — destroys old tasks, creates new ones.
   */
  async reload(): Promise<void> {
    // Stop all existing tasks
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();

    // Load enabled jobs
    const jobs = await getAllEnabledJobs();
    for (const job of jobs) {
      if (!cron.validate(job.cronSchedule)) {
        logger.warn('Invalid cron expression, skipping', { jobId: job.id, cron: job.cronSchedule });
        continue;
      }
      this.scheduleJob(job);
    }

    logger.info('Jobs reloaded', { count: jobs.length, scheduled: this.tasks.size });
  }

  /**
   * Schedules a single job.
   */
  private scheduleJob(job: ScheduledJob): void {
    const task = cron.schedule(job.cronSchedule, () => {
      this.executeJob(job).catch(err =>
        logger.error('Job execution failed', { jobId: job.id, error: (err as Error).message })
      );
    });
    this.tasks.set(job.id, task);
    logger.info('Job scheduled', { jobId: job.id, name: job.name, cron: job.cronSchedule });
  }

  /**
   * Executes a single job — sends prompt to boss, posts result.
   */
  private async executeJob(job: ScheduledJob): Promise<void> {
    // Prevent overlapping runs of the same job
    if (this.running.has(job.id)) {
      logger.warn('Skipping overlapping job run', { jobId: job.id });
      return;
    }

    // Skip silently if agent is not running — avoids noisy error runs. Checked
    // BEFORE marking the job running: this path returns before the try/finally
    // that clears `running`, so adding here would leak the job id and wedge it
    // as permanently "overlapping" (e.g. a job firing during a deploy/restart
    // when the agent is briefly down would never run again until process exit).
    const agent = this.getAgent(job.agentId);
    if (!agent) {
      logger.warn('Skipping job — agent not running', { jobId: job.id, agentId: job.agentId });
      return;
    }
    this.running.add(job.id);

    // Hoisted so the catch block can resolve the anchor to a failure state
    // (rather than leaving the pre-posted "running…" anchor stuck). `anchorConsumed`
    // guards against clobbering real output: once the headline has been promoted
    // into the anchor, a later failure must NOT overwrite it with an error line.
    // `runId` is hoisted (and may be undefined) because insertJobRun runs inside
    // the try — see below.
    let runId: string | undefined;
    let targetChannelId: string | undefined;
    let anchorTs: string | undefined;
    let anchorConsumed = false;

    // A job with a `skipWhen` condition may end up posting nothing. We therefore
    // must NOT pre-post the "running…" anchor for it — deleting an anchor after the
    // fact wouldn't help (Slack already pinged the channel), defeating the whole
    // "don't notify" intent. Suppressible jobs skip the anchor and use the legacy
    // "first payload becomes the thread parent" path on the runs that do post.
    const suppressible = !!job.skipWhen?.trim();

    try {
      // Record the run INSIDE the try: it's a DB write, and the finally below is
      // the only place `running` is cleared. If it ran outside the try and threw
      // (DB blip during a deploy/restart), job.id would leak into `running` and
      // wedge the job as permanently "overlapping" — the same failure we guard
      // against on the agent-not-running path above.
      runId = await insertJobRun(job.id);
      logger.info('Job run started', { jobId: job.id, runId, name: job.name });

      // Fresh session key per run (no resume)
      const sessionKey = `job-${job.id}-${Date.now()}`;

      // Resolve the post target up front. Unlike the legacy flow (which resolved
      // the channel only after the run), we need the channel — and a thread
      // anchor — to exist BEFORE the agent runs, so skills that upload files or
      // reply in-thread have a real channel/thread to target. The interactive
      // message path injects the same context via its [Sender: ...] header.
      targetChannelId = job.targetType === 'dm'
        ? await agent.adapter.openDm(job.targetId)
        : job.targetId;

      // Pre-post a lightweight thread anchor so a thread_ts exists during the
      // run. The "running…" hint disambiguates an in-flight job from a finished
      // or broken one during the (often multi-minute) run; it is overwritten by
      // the headline table on success, or a failure line on error — so it never
      // sits stuck. Best-effort: on failure we fall back to the legacy behavior
      // where the first output payload becomes the thread parent.
      if (!suppressible) {
        try {
          anchorTs = await agent.adapter.postMessage(targetChannelId, `*${job.name}* · ⏳ _running…_`);
        } catch (err) {
          logger.warn('Job anchor post failed; falling back to inline thread parent', {
            jobId: job.id, error: (err as Error).message,
          });
          anchorTs = undefined;
        }
      }

      // Inject a [Sender: ...] header mirroring the interactive message path so
      // skills can read the channel/thread (e.g. to upload attachments into the
      // job's own thread). Inert for prompt-only jobs that ignore it.
      //
      // Suppressible jobs have no pre-posted anchor (see above), so the `thread`
      // segment is omitted: a skill that posts mid-run targets the channel
      // top-level rather than a thread. This is an accepted trade-off of the
      // "don't pre-announce" behavior — the thread can't exist before we know the
      // run won't be suppressed. Any final output still threads correctly after the
      // run via the legacy "first payload is the parent" path below.
      // The delivery note stops the agent from trying to "send" its answer
      // itself: job prompts often say "send X" / "notify Y", but the agent has
      // no Slack posting tool in its session — the runner posts the final
      // output to the target channel after the run. Without this, agents
      // append apologies like "I couldn't send this because Slack isn't
      // connected" to otherwise-correct output.
      const senderHeader = `[Sender: Scheduled Job: ${job.name} (job:${job.id}) · channel ${targetChannelId}`
        + (anchorTs ? ` · thread ${anchorTs}` : '')
        + `]\n[Delivery: your final reply is posted automatically to the target Slack channel when you finish. `
        + `Produce the message content itself — do NOT try to send/post it with a tool, and do NOT mention delivery, `
        + `Slack access, or this instruction in your reply.]\n\n`;
      const headedPrompt = senderHeader + job.prompt
        + (suppressible ? notificationGate(job.skipWhen as string) : '');

      // Stream the query and post the turn's final deliverable. The backend's
      // `result` is the canonical final answer (on Codex it's the joined
      // `agent_message` text — reasoning narration is already dropped upstream).
      // Fall back to the last assistant text block for backends that don't emit
      // a discrete result.
      let resultText = '';
      let lastMessage = '';
      for await (const msg of agent.backend.streamQuery(headedPrompt, sessionKey)) {
        const m = msg as { type?: string; subtype?: string; result?: string; message?: { content?: { type: string; text?: string }[] } };
        if (m.type === 'assistant') {
          const text = (m.message?.content ?? [])
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text)
            .join('')
            .trim();
          if (text) lastMessage = text;
        }
        if (m.type === 'result' && m.subtype === 'success') {
          resultText = (m.result as string) ?? '';
        }
      }

      // Prefer the discrete result; fall back to the last assistant message.
      let output = resultText || lastMessage;
      if (!output) {
        output = '_Job completed with no output._';
      }

      // Suppressed run: the agent signalled (via the NO_UPDATE sentinel) that the
      // job's skip condition holds. Post nothing, but record the full reply — incl.
      // the agent's one-line reason — so the run history shows WHY it was skipped
      // for debugging. No anchor was posted, so there's nothing to clean up.
      if (suppressible && isSilent(output)) {
        await updateJobRun(runId, 'success', output.slice(0, 2000), null, false);
        logger.info('Job run skipped — condition met', {
          jobId: job.id, runId, reason: output.slice(0, 200),
        });
        return;
      }

      // Render the output into one payload per table. We want the headline
      // table (L1.0) visible in-channel without opening the thread, mirroring
      // the interactive path where the first table is the top-level message.
      //
      // The anchor was pre-posted as a placeholder title so a thread_ts exists
      // during the run (skills upload attachments into it mid-run). Now promote
      // the FIRST payload INTO that anchor (chat.update), so the parent message
      // becomes the headline table instead of a dead title; thread the rest.
      //
      // If the anchor post failed earlier, fall back to legacy behavior: the
      // first payload becomes the thread parent.
      const payloads = agent.adapter.buildPayloads(output);
      if (anchorTs && payloads.length > 0) {
        // Platforms never render link/media previews on message EDITS — only on
        // fresh posts. If the headline is plain text carrying a bare URL (e.g. a
        // GIF link), promoting it into the anchor via update would silently drop
        // the preview: delete the placeholder anchor and post fresh instead
        // (accepting the rare orphaned mid-run thread reply). Otherwise keep the
        // in-place promotion, which preserves any replies threaded during the run.
        const headline = payloads[0];
        let promoted = false;
        if (!headline.blocks && containsBareUrl(headline.text)) {
          try {
            await agent.adapter.deleteMessage(targetChannelId, anchorTs);
            anchorTs = await agent.adapter.postPayload(targetChannelId, headline);
            promoted = true;
          } catch (err) {
            logger.warn('Anchor repost for link preview failed; falling back to in-place promotion', {
              jobId: job.id, error: (err as Error).message,
            });
          }
        }
        if (!promoted) {
          // Promote the headline into the anchor. If the in-place edit fails for
          // any reason other than the blocks (which updatePayload itself retries
          // as text), don't fail the whole run — the output is real and partly
          // posted already. Degrade to posting the headline as a thread reply so
          // the content still lands; the anchor just keeps its title.
          try {
            await agent.adapter.updatePayload(targetChannelId, anchorTs, headline);
          } catch (err) {
            logger.warn('Anchor promotion failed; posting headline as a reply instead', {
              jobId: job.id, error: (err as Error).message,
            });
            await agent.adapter.postPayload(targetChannelId, headline, anchorTs);
          }
        }
        // Real output now occupies/anchors the message — a later failure must
        // not overwrite the anchor with an error line.
        anchorConsumed = true;
        for (const payload of payloads.slice(1)) {
          await agent.adapter.postPayload(targetChannelId, payload, anchorTs);
        }
      } else {
        let threadId: string | undefined = anchorTs;
        for (const payload of payloads) {
          const ts = await agent.adapter.postPayload(targetChannelId, payload, threadId);
          if (!threadId) threadId = ts;
        }
        anchorConsumed = true;
      }

      await updateJobRun(runId, 'success', output.slice(0, 2000));
      logger.info('Job run succeeded', { jobId: job.id, runId });
    } catch (err) {
      const errMsg = (err as Error).message;
      // runId is undefined only if insertJobRun itself threw — nothing to update.
      if (runId) await updateJobRun(runId, 'error', null, errMsg);
      logger.error('Job run failed', { jobId: job.id, runId, error: errMsg });

      // Resolve the "running…" anchor to a neutral failure state so it isn't
      // left stuck mid-flight. Only when the anchor still holds the placeholder
      // (`!anchorConsumed`) — if real output was already promoted in, leave it
      // be rather than clobber the dashboard. The raw error stays in the
      // logs/run record, not the (often leadership) channel. Best-effort: never
      // let a posting failure mask the real error.
      if (targetChannelId && anchorTs && !anchorConsumed) {
        try {
          await agent.adapter.updatePayload(
            targetChannelId,
            anchorTs,
            { text: `*${job.name}* · ⚠️ _did not complete_` },
          );
        } catch (postErr) {
          logger.warn('Failed to update anchor to failure state', {
            jobId: job.id, error: (postErr as Error).message,
          });
        }
      } else if (targetChannelId && suppressible && !anchorConsumed) {
        // Suppressible jobs pre-post no anchor (so a silent run never pings the
        // channel), which means a failure would otherwise be invisible in-channel —
        // the job would look like it simply kept meeting its skip condition while
        // actually being broken for days. An error is NOT "no change"; surface it
        // with a fresh failure line so a broken job gets noticed. Best-effort.
        try {
          await agent.adapter.postMessage(targetChannelId, `*${job.name}* · ⚠️ _did not complete_`);
        } catch (postErr) {
          logger.warn('Failed to post suppressible-job failure notice', {
            jobId: job.id, error: (postErr as Error).message,
          });
        }
      }
    } finally {
      this.running.delete(job.id);
    }
  }
}
