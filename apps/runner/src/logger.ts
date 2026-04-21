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
import * as path from 'path';
import * as fs from 'fs';

const { combine, timestamp, json, colorize, simple } = winston.format;

const isDev = process.env.NODE_ENV !== 'production';

// Redact secrets that tend to land in log payloads. Covers Slack tokens
// (xoxb-*, xoxp-*, xapp-*), Anthropic keys (sk-ant-*), and generic
// `Authorization: Bearer <tok>` headers. Applied to every log record
// across both JSON and dev output before any transport sees it.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/g, 'xox*-[REDACTED]'],
  [/\bxapp-[A-Za-z0-9-]{10,}\b/g, 'xapp-[REDACTED]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, 'sk-ant-[REDACTED]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1[REDACTED]'],
];

function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function redactDeep(v: unknown, depth = 0): unknown {
  if (depth > 6) return v;
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactDeep(val, depth + 1);
    }
    return out;
  }
  return v;
}

// Mutate info in place — rebuilding the object via Object.entries drops
// Winston's internal symbol keys (LEVEL, MESSAGE, SPLAT), which silently
// breaks the transport pipeline so no output ever reaches Console/File.
const redact = winston.format((info) => {
  for (const k of Object.keys(info)) {
    const v = (info as Record<string, unknown>)[k];
    if (typeof v === 'string') {
      (info as Record<string, unknown>)[k] = redactString(v);
    } else if (v !== null && typeof v === 'object') {
      (info as Record<string, unknown>)[k] = redactDeep(v);
    }
  }
  return info;
})();

// In native (non-Docker) mode, also write logs to a file for the web UI to stream.
const transports: winston.transport[] = [
  new winston.transports.Console(),
];

const isNativeMode = process.env.DATABASE_TYPE === 'sqlite' || !process.env.DATABASE_URL;
if (isNativeMode) {
  const logDir = process.env.LOG_DIR ?? path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
    '.slackhive', 'logs'
  );
  fs.mkdirSync(logDir, { recursive: true });
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'runner.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 3,
      format: combine(redact, timestamp(), json()),
    })
  );
}

/**
 * The shared logger instance for the runner service.
 * In native mode, also writes JSON logs to ~/.slackhive/logs/runner.log
 * for the web UI to stream via SSE.
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  format: isDev
    ? combine(redact, timestamp(), colorize(), simple())
    : combine(redact, timestamp(), json()),
  transports,
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
