/**
 * @fileoverview Structured logger for the runner service.
 *
 * Wraps Winston to provide consistent JSON-structured logs with
 * support for an optional agent context field. All log entries
 * include a timestamp and log level.
 *
 * @module runner/logger
 */

import winston from 'winston';

const { combine, timestamp, json, colorize, simple } = winston.format;

const isDev = process.env.NODE_ENV !== 'production';

/**
 * The shared logger instance for the runner service.
 * Use this for all logging throughout the runner.
 *
 * @example
 * logger.info('Agent started', { agent: 'gilfoyle' });
 * logger.error('Failed to compile CLAUDE.md', { agent: 'boss', error: err.message });
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  format: isDev
    ? combine(timestamp(), colorize(), simple())
    : combine(timestamp(), json()),
  transports: [
    new winston.transports.Console({ stderrLevels: ['error', 'warn'] }),
  ],
});

/**
 * Creates a child logger with a fixed `agent` context field.
 * All log entries from the child will include `{ agent: slug }`.
 *
 * @param {string} slug - Agent slug to attach to all log entries.
 * @returns {winston.Logger} Child logger with agent context.
 *
 * @example
 * const log = agentLogger('gilfoyle');
 * log.info('Session started', { sessionKey: 'U123-C456-...' });
 * // → { level: 'info', message: 'Session started', agent: 'gilfoyle', sessionKey: '...' }
 */
export function agentLogger(slug: string): winston.Logger {
  return logger.child({ agent: slug });
}
