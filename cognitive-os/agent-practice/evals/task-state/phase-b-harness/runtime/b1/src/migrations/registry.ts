/**
 * Versioned migration registry and transactional runner for mem-graph.
 *
 * Per EPB-001 D4/D15/D16: every schema change is recorded in
 * `schema_migrations` with immutable version, name, SHA-256 checksum of the
 * migration body, and pre-state hash of the database. Migrations run inside
 * one outer transaction; the ledger row is committed in the same transaction
 * as the DDL. Checksum drift on restart triggers REPAIR_REQUIRED.
 *
 * This module is intentionally free of mem-graph domain logic. It only knows
 * about ordered SQL and the migration ledger.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

/**
 * One migration is an ordered, named, immutable unit of schema change.
 *  - `version` must be unique and monotonic; once applied it is recorded.
 *  - `name` is a stable kebab-case slug for diagnostics.
 *  - `sql` is the DDL/DML body that runs verbatim inside the transaction.
 *  - `post_check` is an optional SQL query that must return exactly one row
 *    with `ok = 1` after `sql` executes; failure rolls back the transaction.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
  post_check?: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
  applied_by: string;
  pre_hash: string;
}

export type MigrationRunnerResult =
  | { ok: true; applied: AppliedMigration[]; skipped: AppliedMigration[] }
  | { ok: false; code: 'REPAIR_REQUIRED'; message: string; failing_versions: number[] }
  | { ok: false; code: 'CHECKSUM_MISMATCH'; message: string; version: number; expected: string; actual: string };

const MIGRATIONS_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL,
  applied_by  TEXT NOT NULL,
  pre_hash    TEXT NOT NULL
);
`;

const LEDGER_INTEGRITY_SQL = `
CREATE INDEX IF NOT EXISTS idx_schema_migrations_name ON schema_migrations(name);
`;

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable checksum over the migration body. Whitespace-collapsed for resilience. */
export function migrationChecksum(m: Migration): string {
  const canonical = `${m.version}|${m.name}|${m.sql.replace(/\s+/g, ' ').trim()}`;
  return sha256(canonical);
}

/**
 * Snapshot the schema hash for `pre_hash` recording.
 * Covers every user table/index/trigger name and the resulting `sqlite_master`
 * row text. It is a fingerprint, not a strict equality check; equality across
 * migrations of the same baseline is the contract.
 */
export function snapshotSchemaHash(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; tbl_name: string | null; sql: string | null }>;
  const canonical = rows
    .map((r) => `${r.type}|${r.name}|${r.tbl_name ?? ''}|${r.sql ?? ''}`)
    .join('\n');
  return sha256(canonical);
}

function ensureLedger(db: Database.Database): void {
  db.exec(MIGRATIONS_LEDGER_SQL);
  db.exec(LEDGER_INTEGRITY_SQL);
}

function readApplied(db: Database.Database): Map<number, AppliedMigration> {
  const rows = db
    .prepare(
      `SELECT version, name, checksum, applied_at, applied_by, pre_hash
       FROM schema_migrations
       ORDER BY version ASC`,
    )
    .all() as AppliedMigration[];
  return new Map(rows.map((r) => [r.version, r]));
}

/**
 * Verify all applied migrations still match their registered checksum.
 * Returns the list of failing versions (empty if all match).
 */
export function verifyChecksums(
  db: Database.Database,
  registry: ReadonlyArray<Migration>,
): { ok: boolean; failing_versions: number[] } {
  ensureLedger(db);
  const applied = readApplied(db);
  const registryByVersion = new Map(registry.map((m) => [m.version, m]));
  const failing: number[] = [];
  for (const [version, row] of applied) {
    const expected = registryByVersion.get(version);
    if (!expected) {
      // Migration is applied but no longer in registry — treat as drift.
      failing.push(version);
      continue;
    }
    const actualChecksum = migrationChecksum(expected);
    if (actualChecksum !== row.checksum) {
      failing.push(version);
    }
  }
  return { ok: failing.length === 0, failing_versions: failing };
}

export interface RunOptions {
  applied_by?: string;
  /** When true, throw on partial state instead of returning REPAIR_REQUIRED. */
  throw_on_repair?: boolean;
}

/**
 * Apply any unapplied migrations in `registry` order, inside per-migration
 * transactions. The ledger row is inserted in the same transaction as the DDL
 * so partial application is impossible.
 */
export function runMigrations(
  db: Database.Database,
  registry: ReadonlyArray<Migration>,
  options: RunOptions = {},
): MigrationRunnerResult {
  ensureLedger(db);

  // Checksum verification first — refuse to start if drift is detected.
  const verification = verifyChecksums(db, registry);
  if (!verification.ok) {
    const message = `Migration checksum drift detected; refusing to boot. Failing versions: ${verification.failing_versions.join(', ')}.`;
    if (options.throw_on_repair) throw new Error(`REPAIR_REQUIRED: ${message}`);
    return { ok: false, code: 'REPAIR_REQUIRED', message, failing_versions: verification.failing_versions };
  }

  const alreadyApplied = readApplied(db);
  const sortedRegistry = [...registry].sort((a, b) => a.version - b.version);
  const applied: AppliedMigration[] = [];
  const skipped: AppliedMigration[] = [];

  for (const m of sortedRegistry) {
    const existing = alreadyApplied.get(m.version);
    if (existing) {
      skipped.push(existing);
      continue;
    }

    // One transaction per migration: snapshot pre-state → execute DDL → verify
    // post_check → insert ledger row → commit. Any failure rolls back fully.
    const checksum = migrationChecksum(m);
    const tx = db.transaction(() => {
      const pre_hash = snapshotSchemaHash(db);
      db.exec(m.sql);
      if (m.post_check) {
        const checkRow = db.prepare(m.post_check).get() as { ok?: number } | undefined;
        if (!checkRow || Number(checkRow.ok) !== 1) {
          throw new Error(
            `Migration v${m.version} (${m.name}) post_check failed: expected ok=1`,
          );
        }
      }
      const applied_at = new Date().toISOString();
      db.prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at, applied_by, pre_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(m.version, m.name, checksum, applied_at, options.applied_by ?? 'unknown', pre_hash);
    });
    tx();

    const row = db
      .prepare(
        `SELECT version, name, checksum, applied_at, applied_by, pre_hash
         FROM schema_migrations WHERE version = ?`,
      )
      .get(m.version) as AppliedMigration;
    applied.push(row);
  }

  return { ok: true, applied, skipped };
}

/** Highest version currently applied; 0 when none. */
export function currentSchemaVersion(db: Database.Database): number {
  ensureLedger(db);
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get() as { v: number };
  return Number(row.v);
}
