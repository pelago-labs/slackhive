/**
 * @fileoverview Database adapter barrel export.
 * @module @slackhive/shared/db
 */

export { initDb, getDb, closeDb, setDb } from './adapter';
export type { DbAdapter, DbResult, DbRow } from './adapter';
export { encrypt, decrypt } from './crypto';
