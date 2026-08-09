/**
 * Migration runner tests — Step 2 of EPB-001.
 *
 * Oracle requirements (verbatim from [[283]] Step 2 acceptance):
 *   - a fresh database and a representative existing pre-migration database
 *     converge to the same schema version;
 *   - migration IDs/checksums are immutable; a changed checksum fails closed;
 *   - interrupted or injected-failure migration leaves neither a partial
 *     schema nor a recorded version;
 *   - backup restore returns the original database hash/content.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMigrations,
  verifyChecksums,
  currentSchemaVersion,
  migrationChecksum,
} from '../src/migrations/registry.js';
import { MIGRATIONS } from '../src/migrations/index.js';
import { COGNITIVE_SCHEMA_SQL } from '../src/cognitive/schema.js';
import { SCHEMA_SQL, DECAY_MATRIX_SEED } from '../src/db.js';

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('migration runner — registry primitives', () => {
  it('migrationChecksum is stable for identical input', () => {
    const m = MIGRATIONS[0];
    expect(migrationChecksum(m)).toBe(migrationChecksum(m));
  });

  it('migrationChecksum changes when SQL body changes', () => {
    const a = migrationChecksum({ version: 1, name: 'x', sql: 'CREATE TABLE t (a INT);' });
    const b = migrationChecksum({ version: 1, name: 'x', sql: 'CREATE TABLE t (a INT, b INT);' });
    expect(a).not.toBe(b);
  });

  it('migrationChecksum ignores whitespace variations', () => {
    const a = migrationChecksum({ version: 1, name: 'x', sql: 'CREATE TABLE t (a INT);' });
    const b = migrationChecksum({ version: 1, name: 'x', sql: '  CREATE   TABLE\n  t (a INT);' });
    expect(a).toBe(b);
  });
});

describe('migration runner — fresh database convergence', () => {
  it('empty DB gets v1 applied and converges to known baseline', () => {
    const db = freshDb();
    expect(currentSchemaVersion(db)).toBe(0);
    const result = runMigrations(db, MIGRATIONS, { applied_by: 'test' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].version).toBe(1);
    expect(result.applied[0].pre_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(currentSchemaVersion(db)).toBe(1);
  });

  it('fresh DB and pre-migration DB converge to the same post-state hash', () => {
    // Fresh
    const fresh = freshDb();
    runMigrations(fresh, MIGRATIONS, { applied_by: 'fresh-test' });

    // Pre-migration DB: built the old way (exec raw SQL); the runner stamps
    // v1 on it because no schema_migrations table exists yet. The resulting
    // schema state must match the fresh DB state.
    const pre = freshDb();
    pre.exec(SCHEMA_SQL);
    pre.exec(DECAY_MATRIX_SEED);
    pre.exec(COGNITIVE_SCHEMA_SQL);
    const result = runMigrations(pre, MIGRATIONS, { applied_by: 'pre-test' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // v1 is applied (pre_hash records the pre-migration snapshot for future
    // drift detection), not skipped.
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    // Both DBs end up at schema version 1.
    expect(currentSchemaVersion(fresh)).toBe(1);
    expect(currentSchemaVersion(pre)).toBe(1);

    // Same post-state hash for user-visible schema (excluding the
    // migration ledger which records different `pre_hash` per history).
    // We snapshot each DB and exclude schema_migrations row text.
    const freshWithoutLedger = fresh
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
         ORDER BY type, name`,
      )
      .all();
    const preWithoutLedger = pre
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
         ORDER BY type, name`,
      )
      .all();
    expect(freshWithoutLedger).toEqual(preWithoutLedger);
  });
});

describe('migration runner — rerun idempotency', () => {
  it('running migrations twice applies nothing the second time', () => {
    const db = freshDb();
    const first = runMigrations(db, MIGRATIONS, { applied_by: 'test' });
    const second = runMigrations(db, MIGRATIONS, { applied_by: 'test' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.applied).toHaveLength(1);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
  });
});

describe('migration runner — checksum drift detection', () => {
  it('returns REPAIR_REQUIRED when an applied migration body is altered', () => {
    const db = freshDb();
    const first = runMigrations(db, MIGRATIONS, { applied_by: 'test' });
    expect(first.ok).toBe(true);

    // Tamper with the registered checksum in the ledger to simulate drift
    db.prepare(
      'UPDATE schema_migrations SET checksum = ? WHERE version = 1',
    ).run('0'.repeat(64));

    const verification = verifyChecksums(db, MIGRATIONS);
    expect(verification.ok).toBe(false);
    expect(verification.failing_versions).toContain(1);

    const second = runMigrations(db, MIGRATIONS, { applied_by: 'test' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('REPAIR_REQUIRED');
  });

  it('returns REPAIR_REQUIRED when an applied migration no longer exists in registry', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS, { applied_by: 'test' });

    const empty: typeof MIGRATIONS = [];
    const verification = verifyChecksums(db, empty);
    expect(verification.ok).toBe(false);
    expect(verification.failing_versions).toContain(1);
  });
});

describe('migration runner — interrupted migration', () => {
  it('injected post_check failure rolls back the entire migration', () => {
    const db = freshDb();
    // A migration that creates a table, then its post_check fails.
    const bad: typeof MIGRATIONS = [
      {
        version: 1,
        name: 'will-fail',
        sql: 'CREATE TABLE doomed (id INTEGER PRIMARY KEY);',
        post_check: 'SELECT 0 AS ok',
      },
    ];

    let caught: unknown;
    try {
      runMigrations(db, bad, { applied_by: 'test', throw_on_repair: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);

    // Migration row must not exist; ledger table itself may or may not be
    // present (the ledger DDL runs in its own exec, not the failing
    // migration's transaction). What's guaranteed: the table we tried to
    // create must not exist, AND no migration ledger row exists.
    const tableExists = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='doomed'",
      )
      .get() as { c: number };
    expect(tableExists.c).toBe(0);

    const ledgerRowExists = (
      db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as {
        c: number;
      }
    ).c;
    expect(ledgerRowExists).toBe(0);
  });

  it('an injected DDL failure inside a multi-statement migration leaves no partial state', () => {
    const db = freshDb();
    // First migration succeeds; second one contains invalid SQL.
    const migrations = [
      {
        version: 1,
        name: 'ok',
        sql: 'CREATE TABLE ok_table (id INTEGER PRIMARY KEY);',
      },
      {
        version: 2,
        name: 'broken',
        // valid statement, then bogus one — the bogus one triggers a runtime error
        sql: 'CREATE TABLE half_baked (id INTEGER PRIMARY KEY); THIS_IS_NOT_VALID_SQL;',
      },
    ];

    let caught: unknown;
    try {
      runMigrations(db, migrations, { applied_by: 'test', throw_on_repair: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);

    // v1 must still be applied (it was committed before v2 started).
    const v1Row = db
      .prepare('SELECT * FROM schema_migrations WHERE version = 1')
      .get();
    expect(v1Row).toBeDefined();

    // v2 must not exist in the ledger, and no half_baked table either.
    const v2Row = db
      .prepare('SELECT * FROM schema_migrations WHERE version = 2')
      .get();
    expect(v2Row).toBeUndefined();
    const halfBaked = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='half_baked'",
      )
      .get() as { c: number };
    expect(halfBaked.c).toBe(0);
  });
});

describe('migration runner — backup / restore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mig-test-'));
  });

  it('restoring a pre-migration backup returns the original hash', () => {
    const file = join(tmpDir, 'memory.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA_SQL);
    db.exec(DECAY_MATRIX_SEED);
    db.exec(COGNITIVE_SCHEMA_SQL);
    db.close();

    // Compute pre-migration hash
    const preBytes = require('node:fs').readFileSync(file);
    const preHash = sha256(preBytes);

    // Back up
    const backup = join(tmpDir, 'memory.db.bak');
    copyFileSync(file, backup);

    // Run migrations (v1 is skipped because pre-migration DB already has the
    // baseline, so this should be a no-op for v1 in practice — but we also
    // need to check the case where a *new* version is applied)
    const db2 = new Database(file);
    db2.pragma('foreign_keys = ON');
    const result = runMigrations(db2, MIGRATIONS, { applied_by: 'test' });
    expect(result.ok).toBe(true);
    db2.close();

    // Restore from backup
    copyFileSync(backup, file);

    // Hash matches the pre-migration hash exactly
    const restoredBytes = require('node:fs').readFileSync(file);
    expect(sha256(restoredBytes)).toBe(preHash);
  });

  it('convergence: fresh and pre-migration DBs have the same post-state hash', () => {
    // Fresh
    const freshFile = join(tmpDir, 'fresh.db');
    const fresh = new Database(freshFile);
    fresh.pragma('journal_mode = WAL');
    runMigrations(fresh, MIGRATIONS, { applied_by: 'test' });
    fresh.close();

    // Pre-migration
    const preFile = join(tmpDir, 'pre.db');
    const pre = new Database(preFile);
    pre.pragma('journal_mode = WAL');
    pre.exec(SCHEMA_SQL);
    pre.exec(DECAY_MATRIX_SEED);
    pre.exec(COGNITIVE_SCHEMA_SQL);
    runMigrations(pre, MIGRATIONS, { applied_by: 'test' });
    pre.close();

    // Both DBs must have identical content (excluding the migration ledger
    // whose `applied_at` timestamp naturally differs between calls).
    // Compare via SQL export to be deterministic.
    const exportDb = (file: string): string => {
      const d = new Database(file);
      d.pragma('foreign_keys = ON');
      const tables = d
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='table' AND name NOT LIKE 'sqlite_%'
             AND name != 'schema_migrations'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      const lines: string[] = [];
      for (const t of tables) {
        const rows = d.prepare(`SELECT * FROM ${t.name} ORDER BY 1`).all();
        lines.push(`${t.name}:${JSON.stringify(rows)}`);
      }
      d.close();
      return lines.join('\n');
    };

    expect(exportDb(freshFile)).toBe(exportDb(preFile));
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('migration runner — baseline table contents', () => {
  it('v1 produces a DB with memories, cognitive_events, and schema_migrations tables', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS, { applied_by: 'test' });

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memories','cognitive_events','schema_migrations')",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(['cognitive_events', 'memories', 'schema_migrations']);

    const memCols = db.prepare("PRAGMA table_info('memories')").all() as Array<{
      name: string;
    }>;
    expect(memCols.find((c) => c.name === 'confidence')).toBeDefined();

    const evCols = db.prepare("PRAGMA table_info('cognitive_events')").all() as Array<{
      name: string;
    }>;
    expect(evCols.find((c) => c.name === 'event_type')).toBeDefined();
  });

  it('schema_migrations has exactly one row after first run on fresh DB', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS, { applied_by: 'test' });
    const rows = db
      .prepare('SELECT version, name, applied_by FROM schema_migrations')
      .all() as Array<{ version: number; name: string; applied_by: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].applied_by).toBe('test');
  });
});
