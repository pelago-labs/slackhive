/**
 * @fileoverview Small Map-based LRU cache with per-entry TTL.
 *
 * Why hand-rolled instead of `lru-cache` from npm: the surface we need is
 * tiny (get/set/delete/clear/size), and avoiding a runtime dep keeps the
 * runner's startup graph lean. Map iteration order is insertion order, so
 * eviction is just "delete the first key" once capacity is exceeded.
 *
 * TTL is per-entry. Expired reads return `undefined` AND delete the entry
 * so a never-read expired key still releases its slot on the next eviction
 * pass.
 *
 * Not thread-safe in any meaningful sense — Node is single-threaded for the
 * runner's purposes. If we ever move to worker threads, swap this for a
 * shared-buffer cache or per-thread copies.
 *
 * @module runner/lru-cache
 */

interface Entry<V> {
  value: V;
  /** Absolute ms timestamp at which this entry stops being valid. */
  expiresAt: number;
}

export class LruCache<K, V> {
  private store = new Map<K, Entry<V>>();

  /**
   * @param capacity Max number of entries; oldest is evicted past this.
   * @param defaultTtlMs Default TTL applied when `set()` is called without
   *                    an explicit `ttlMs`. Use `Infinity` for no expiry.
   */
  constructor(
    private readonly capacity: number,
    private readonly defaultTtlMs: number,
  ) {
    if (capacity <= 0) throw new Error('LRU capacity must be positive');
    if (defaultTtlMs <= 0) throw new Error('LRU defaultTtlMs must be positive');
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (entry == null) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Re-insert to bump recency for LRU eviction.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttl });
    // Evict oldest entries until back under capacity. Map iteration order
    // is insertion order, so the first key is the least recently used.
    while (this.store.size > this.capacity) {
      const oldest = this.store.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  /** Drop every entry whose key matches the predicate. Returns how many were dropped. */
  deleteWhere(pred: (key: K) => boolean): number {
    let dropped = 0;
    for (const key of [...this.store.keys()]) {
      if (pred(key)) {
        this.store.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.store.size;
  }
}
