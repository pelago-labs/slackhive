/**
 * @fileoverview Job scheduler — executes scheduled jobs via node-cron.
 *
 * On each cron trigger:
 * 1. Finds the boss agent from the runningAgents map
 * 2. Sends the job's prompt to the boss via claudeHandler.streamQuery()
 * 3. Posts the result to the target Slack channel or DM
 * 4. Records the run in the job_runs table
 *
 * @module runner/job-scheduler
 */

import cron from 'node-cron';
import type { ScheduledJob, PlatformAdapter } from '@slackhive/shared';
import { getAllEnabledJobs, insertJobRun, updateJobRun } from './db';
import type { ClaudeHandler } from './claude-handler';
import { logger } from './logger';

/** The shape of a running agent as exposed by AgentRunner. */
interface RunningAgent {
  adapter: PlatformAdapter;
  claudeHandler: ClaudeHandler;
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
    await this.reload();
    logger.info('Job scheduler started');
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
    this.running.add(job.id);

    // Skip silently if agent is not running — avoids noisy error runs
    const agent = this.getAgent(job.agentId);
    if (!agent) {
      logger.warn('Skipping job — agent not running', { jobId: job.id, agentId: job.agentId });
      return;
    }

    const runId = await insertJobRun(job.id);
    logger.info('Job run started', { jobId: job.id, runId, name: job.name });

    try {

      // Fresh session key per run (no resume)
      const sessionKey = `job-${job.id}-${Date.now()}`;

      // Stream query to agent
      let output = '';
      for await (const msg of agent.claudeHandler.streamQuery(job.prompt, sessionKey)) {
        const m = msg as Record<string, unknown>;
        if (m.type === 'result' && m.subtype === 'success') {
          output = (m.result as string) ?? '';
        }
      }

      if (!output) {
        output = '_Job completed with no output._';
      }

      // Post to target via platform adapter (with rich formatting)
      const targetChannelId = job.targetType === 'dm'
        ? await agent.adapter.openDm(job.targetId)
        : job.targetId;

      if (targetChannelId) {
        const payloads = agent.adapter.buildPayloads(output);
        for (const payload of payloads) {
          await agent.adapter.postPayload(targetChannelId, payload);
        }
      }

      await updateJobRun(runId, 'success', output.slice(0, 2000));
      logger.info('Job run succeeded', { jobId: job.id, runId });
    } catch (err) {
      const errMsg = (err as Error).message;
      await updateJobRun(runId, 'error', null, errMsg);
      logger.error('Job run failed', { jobId: job.id, runId, error: errMsg });
    } finally {
      this.running.delete(job.id);
    }
  }
}
