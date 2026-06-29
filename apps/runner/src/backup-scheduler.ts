/**
 * @fileoverview Scheduled database backups for disaster recovery.
 *
 * A lightweight timer (mirrors the heartbeat/sweep pattern in AgentRunner) that
 * re-evaluates every tick and takes a `VACUUM INTO` snapshot whenever one is due per
 * the configured interval, then prunes to the retention count. Config lives in the
 * `settings` table (`backup.*`) so the UI can change it WITHOUT a restart; status is
 * written back to `backup.lastTime` / `backup.lastStatus` for display.
 *
 * @module runner/backup-scheduler
 */

import { backupDatabase, pruneBackups } from '@slackhive/shared';
import { getSetting, setSetting } from './db';
import { logger } from './logger';

/** How often the scheduler re-evaluates whether a backup is due. */
const TICK_MS = 15 * 60 * 1000;

/** Defaults used when the corresponding `backup.*` setting is unset (UI mirrors these). */
export const BACKUP_DEFAULTS = { enabled: true, everyHours: 24, retain: 5 } as const;

export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    // Evaluate shortly after boot (a fresh install gets its first backup right away),
    // then on every tick.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.(); // don't keep the event loop alive for backups
    logger.info('Backup scheduler started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One evaluation: back up if enabled AND the configured interval has elapsed. */
  private async tick(): Promise<void> {
    try {
      const enabled = (await getSetting('backup.enabled')) ?? String(BACKUP_DEFAULTS.enabled);
      if (enabled !== 'true') return;
      const everyHours = Number(await getSetting('backup.everyHours')) || BACKUP_DEFAULTS.everyHours;
      const retain = Number(await getSetting('backup.retain')) || BACKUP_DEFAULTS.retain;
      const lastTime = await getSetting('backup.lastTime');
      const lastMs = lastTime ? Date.parse(lastTime) : NaN;
      if (Number.isFinite(lastMs) && Date.now() - lastMs < everyHours * 3_600_000) return; // not due
      await this.runBackup(retain);
    } catch (err) {
      logger.warn('Backup scheduler tick failed', { error: (err as Error).message });
    }
  }

  /** Take a backup now + prune + record status. Shared by the scheduler and /backup-now. */
  async runBackup(retain: number = BACKUP_DEFAULTS.retain): Promise<{ path: string; bytes: number }> {
    try {
      const res = await backupDatabase();
      const pruned = pruneBackups(retain);
      await setSetting('backup.lastTime', new Date().toISOString());
      await setSetting('backup.lastStatus', `ok · ${(res.bytes / 1024 / 1024).toFixed(1)}MB${pruned ? ` · pruned ${pruned}` : ''}`);
      logger.info('Database backup created', { path: res.path, bytes: res.bytes, pruned });
      return res;
    } catch (err) {
      const msg = (err as Error).message;
      await setSetting('backup.lastStatus', `error: ${msg}`).catch(() => {});
      logger.error('Database backup failed', { error: msg });
      throw err;
    }
  }
}
