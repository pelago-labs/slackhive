/**
 * @fileoverview Unit tests for the hand-rolled LRU + TTL cache.
 *
 * Covers:
 * - get/set/delete/clear basics
 * - TTL: expired reads return undefined and clear the entry
 * - LRU eviction: oldest key dropped past capacity; reads bump recency
 * - deleteWhere prefix/suffix filters
 *
 * @module runner/__tests__/lru-cache.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LruCache } from '../lru-cache';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('LruCache', () => {
  it('get returns undefined for missing keys', () => {
    const c = new LruCache<string, number>(10, 1000);
    expect(c.get('a')).toBeUndefined();
  });

  it('round-trips set → get', () => {
    const c = new LruCache<string, number>(10, 1000);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
  });

  it('size reflects insertions and deletions', () => {
    const c = new LruCache<string, number>(10, 1000);
    expect(c.size).toBe(0);
    c.set('a', 1); c.set('b', 2);
    expect(c.size).toBe(2);
    c.delete('a');
    expect(c.size).toBe(1);
    c.clear();
    expect(c.size).toBe(0);
  });

  it('expired entries return undefined and are evicted on read', () => {
    const c = new LruCache<string, number>(10, 1000);
    c.set('a', 1);
    vi.advanceTimersByTime(1001);
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(0); // read-side eviction
  });

  it('non-expired entries survive across the half-TTL mark', () => {
    const c = new LruCache<string, number>(10, 1000);
    c.set('a', 1);
    vi.advanceTimersByTime(500);
    expect(c.get('a')).toBe(1);
  });

  it('per-call ttlMs overrides the default', () => {
    const c = new LruCache<string, number>(10, 1000);
    c.set('a', 1, 100);
    vi.advanceTimersByTime(150);
    expect(c.get('a')).toBeUndefined();
  });

  it('evicts the oldest key when capacity is exceeded', () => {
    const c = new LruCache<string, number>(3, 10_000);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4); // evicts 'a'
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
  });

  it('reading bumps recency — the *un-read* key gets evicted', () => {
    const c = new LruCache<string, number>(2, 10_000);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');     // 'a' is now most-recent
    c.set('c', 3);  // evicts 'b' (oldest), not 'a'
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });

  it('overwriting a key updates the value AND bumps recency', () => {
    const c = new LruCache<string, number>(2, 10_000);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 10); // 'a' is now most-recent
    c.set('c', 3);  // evicts 'b'
    expect(c.get('a')).toBe(10);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });

  it('deleteWhere drops every key matching the predicate, returns the count', () => {
    const c = new LruCache<string, number>(10, 10_000);
    c.set('agent-A:u1', 1);
    c.set('agent-A:u2', 1);
    c.set('agent-B:u1', 1);
    const dropped = c.deleteWhere(k => k.startsWith('agent-A:'));
    expect(dropped).toBe(2);
    expect(c.get('agent-A:u1')).toBeUndefined();
    expect(c.get('agent-A:u2')).toBeUndefined();
    expect(c.get('agent-B:u1')).toBe(1);
  });

  it('constructor rejects non-positive capacity / ttl', () => {
    expect(() => new LruCache<string, number>(0, 1000)).toThrow();
    expect(() => new LruCache<string, number>(10, 0)).toThrow();
  });
});
