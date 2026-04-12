/**
 * @fileoverview Unified database adapter interface.
 *
 * Provides a common query interface that both PostgreSQL and SQLite
 * implementations conform to. Existing query code using `$1, $2, ...`
 * parameter placeholders works with both backends — the SQLite adapter
 * translates them automatically.
 *
 * Usage:
 *   import { initDb, getDb } from '@slackhive/shared/db/adapter';
 *   await initDb();              // reads DATABASE_TYPE from env
 *   const db = getDb();
 *   const result = await db.query('SELECT * FROM agents WHERE id = $1', [id]);
 *
 * @module @slackhive/shared/db/adapter
 */

// =============================================================================
// Types
// =============================================================================

/** A single row returned by a query. */
export interface DbRow {
  [key: string]: unknown;
}

/** Result of a database query, matching pg.QueryResult shape. */
export interface DbResult {
  rows: DbRow[];
  rowCount: number;
}

/**
 * Unified database adapter interface.
 * Both pg and sqlite implementations conform to this contract.
 */
export interface DbAdapter {
  /** Execute a parameterized SQL query. Params use $1, $2, ... placeholders. */
  query(sql: string, params?: unknown[]): Promise<DbResult>;

  /**
   * Run a callback inside a transaction.
   * The callback receives a transactional adapter — all queries within
   * the callback share the same transaction. If the callback throws,
   * the transaction is rolled back.
   */
  transaction<T>(fn: (client: DbAdapter) => Promise<T>): Promise<T>;

  /** Close the database connection / pool. */
  close(): Promise<void>;

  /** The database backend type. */
  readonly type: 'sqlite';
}

// =============================================================================
// Singleton
// =============================================================================

let _db: DbAdapter | null = null;

/**
 * Initialize the SQLite database adapter.
 *
 * @returns The initialized adapter.
 */
export async function initDb(): Promise<DbAdapter> {
  if (_db) return _db;

  const { createSqliteAdapter } = await import('./sqlite-adapter');
  _db = createSqliteAdapter(process.env.SQLITE_PATH);

  return _db;
}

/**
 * Returns the initialized database adapter.
 * Throws if `initDb()` hasn't been called yet.
 */
export function getDb(): DbAdapter {
  if (!_db) {
    throw new Error('Database not initialized — call initDb() first');
  }
  return _db;
}

/**
 * Closes the database connection and resets the singleton.
 */
export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}

/**
 * Set the database adapter directly (for testing or custom configurations).
 */
export function setDb(adapter: DbAdapter): void {
  _db = adapter;
}
