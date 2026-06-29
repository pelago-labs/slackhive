/**
 * @fileoverview Privacy-safe value fingerprints for sensitive-data flow lineage.
 *
 * To trace a sensitive value from a SOURCE span (e.g. a tool result) to a SINK
 * span (e.g. an egress tool's args, or the final answer posted to Slack) we must
 * be able to tell "the same value appears in both" — WITHOUT ever storing the
 * value. We hash each match with a per-install salt; identical values produce the
 * same fingerprint so flows can be derived at read time, but the fingerprint is
 * not reversible to the value (preserving the no-store-value privacy invariant).
 *
 * Fingerprinting reuses `markSensitive` so the matched substrings are exactly the
 * ones the detector flags — flag, highlight, and flow always agree.
 *
 * @module runner/tracing/fingerprint
 */

import { createHash, randomBytes } from 'crypto';
import { markSensitive, type SensScope } from '@slackhive/shared';
import { getSetting, setSetting } from '../db';

const SALT_KEY = 'sensitiveFpSalt';
// In-memory fallback until the persisted salt is loaded at startup. Persisting it
// keeps fingerprints stable across runner restarts so cross-turn flows still link.
let salt = randomBytes(24).toString('hex');

/** Load (or generate + persist) the per-install fingerprint salt. Call at startup. */
export async function loadFingerprintSalt(): Promise<void> {
  try {
    let s = await getSetting(SALT_KEY);
    if (!s) { s = randomBytes(24).toString('hex'); await setSetting(SALT_KEY, s); }
    salt = s;
  } catch { /* keep the in-memory fallback */ }
}

function norm(v: string): string { return v.trim().replace(/\s+/g, ' '); }

/** Short, non-reversible fingerprint of a value (salted sha256, truncated). */
export function fingerprint(value: string): string {
  return createHash('sha256').update(`${salt}|${norm(value)}`).digest('hex').slice(0, 16);
}

export type FlowRole = 'source' | 'sink';
export interface FpEntry { fp: string; tag: string; role: FlowRole }

/**
 * Fingerprint every sensitive match in `content`, tagging each with `role`.
 * Returns [] when nothing is sensitive. De-duped per (fp, role).
 */
export function computeFps(content: string | null | undefined, scope: SensScope, role: FlowRole): FpEntry[] {
  if (!content) return [];
  const seen = new Set<string>();
  const out: FpEntry[] = [];
  for (const seg of markSensitive(content, scope)) {
    if (!seg.cat || !seg.label) continue;
    const fp = fingerprint(seg.text);
    const key = `${fp}:${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fp, tag: seg.label, role });
  }
  return out;
}
