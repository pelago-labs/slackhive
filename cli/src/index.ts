#!/usr/bin/env node

/**
 * @fileoverview SlackHive CLI — install, configure, and manage SlackHive.
 *
 * Commands:
 *   slackhive init     — Clone repo, configure .env, start services
 *   slackhive start    — Start all Docker Compose services
 *   slackhive stop     — Stop all services
 *   slackhive status   — Show running containers
 *   slackhive logs     — Tail runner logs
 *   slackhive update   — Pull latest changes and rebuild
 *
 * @module cli
 */

import { Command } from 'commander';
import { init } from './commands/init';
import { start, stop, status, logs, update } from './commands/manage';

const program = new Command();

program
  .name('slackhive')
  .description('CLI to install and manage SlackHive — AI agent teams on Slack')
  .version('0.1.0');

program
  .command('init')
  .description('Clone SlackHive repo, configure environment, and start services')
  .option('-d, --dir <path>', 'Directory to install into', 'slackhive')
  .option('--skip-start', 'Skip starting services after init')
  .action(init);

program
  .command('start')
  .description('Start all SlackHive services')
  .action(start);

program
  .command('stop')
  .description('Stop all SlackHive services')
  .action(stop);

program
  .command('status')
  .description('Show running SlackHive containers')
  .action(status);

program
  .command('logs')
  .description('Tail runner service logs')
  .option('-f, --follow', 'Follow log output', true)
  .action(logs);

program
  .command('update')
  .description('Pull latest changes and rebuild')
  .action(update);

program.parse(process.argv);
