/**
 * @fileoverview Entry point for the agent runner service.
 *
 * Loads environment variables, validates configuration, and starts the
 * AgentRunner which manages all Slack bot instances.
 *
 * @module runner/index
 */

import 'dotenv/config';
import { AgentRunner } from './agent-runner';
import { logger } from './logger';

/**
 * Main entry point. Initializes and starts the AgentRunner.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  logger.info('Starting Slack Claude Code Agent Team — Runner Service');

  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    process.exit(1);
  }

  const runner = new AgentRunner();

  try {
    await runner.start();
  } catch (err) {
    logger.error('Failed to start AgentRunner', { error: (err as Error).message });
    process.exit(1);
  }
}

main();
