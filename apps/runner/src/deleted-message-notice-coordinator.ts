const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1_000;

export function pruneTimestampCache(
  cache: Map<string, number>,
  now: number,
  maxAgeMs: number,
  maxEntries: number,
): void {
  const expiredKeys = [...cache]
    .filter(([, timestamp]) => now - timestamp > maxAgeMs)
    .map(([key]) => key);
  for (const key of expiredKeys) cache.delete(key);

  const excess = cache.size - maxEntries;
  if (excess <= 0) return;
  for (const key of [...cache.keys()].slice(0, excess)) cache.delete(key);
}

/** Ensures all agents in one runner post at most one notice for a deletion. */
export class DeletedMessageNoticeCoordinator {
  private recentNotices = new Map<string, number>();

  constructor(
    private ttlMs = DEFAULT_TTL_MS,
    private maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  claim(sourceKey: string): boolean {
    const now = Date.now();
    const postedAt = this.recentNotices.get(sourceKey);
    if (postedAt !== undefined && now - postedAt <= this.ttlMs) return false;

    this.recentNotices.delete(sourceKey);
    this.recentNotices.set(sourceKey, now);
    pruneTimestampCache(this.recentNotices, now, this.ttlMs, this.maxEntries);
    return true;
  }
}
