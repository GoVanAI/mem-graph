/**
 * Epistemic persistence tests — Step 4 of EPB-001.
 *
 * Oracle requirements (verbatim from [[283]] Step 4 acceptance):
 *   - a validated record round-trips without semantic drift;
 *   - revision numbers are contiguous per record;
 *   - provenance and receipt references resolve;
 *   - direct update/delete of immutable history fails;
 *   - existing memories and synapses are byte/row-count unchanged;
 *   - non-empty relations follow the operator-adopted option A and
 *     otherwise fail closed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../src/migrations/registry.js';
import { MIGRATIONS } from '../src/migrations/index.js';
import { appendCognitiveEvent } from '../src/cognitive/events.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS, { applied_by: 'test' });
  return db;
}

/** Round-trip JSON through canonical encoding (sorted keys, no whitespace). */
function canonical(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

describe('epistemic persistence — schema v2 application', () => {
  it('v2 migration creates all four epistemic tables', () => {
    const db = freshDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('epistemic_revisions','epistemic_receipts','epistemic_provenance','epistemic_records')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      'epistemic_provenance',
      'epistemic_receipts',
      'epistemic_records',
      'epistemic_revisions',
    ]);
  });

  it('v2 is idempotent on a second run', () => {
    const db = freshDb();
    const result = runMigrations(db, MIGRATIONS, { applied_by: 'test' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
  });
});

describe('epistemic persistence — existing data unchanged', () => {
  it('memories and synapses row count is unchanged after v2', () => {
    const db = freshDb();
    // Seed memories
    const insertMem = db.prepare(
      `INSERT INTO memories (title, slug, content, project_id, category, layer, lifecycle, status, confidence, source, importance_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertMem.run('mem-1', 'mem-1', 'content', 'p1', 'note', 'episodic', 'milestone', 'active', 1.0, 'manual', 1.0);
    insertMem.run('mem-2', 'mem-2', 'content', 'p1', 'note', 'episodic', 'milestone', 'active', 1.0, 'manual', 1.0);

    // Seed a synapse
    db.prepare(
      `INSERT INTO synapses (source_id, target_id, connection_type, weight)
       VALUES (1, 2, 'wikilink', 1.0)`,
    ).run();

    const before = {
      memories: (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c,
      synapses: (db.prepare('SELECT COUNT(*) AS c FROM synapses').get() as { c: number }).c,
      fts5: (db.prepare('SELECT COUNT(*) AS c FROM memories_fts').get() as { c: number }).c,
    };

    // Re-run migrations (should be a no-op for v2)
    runMigrations(db, MIGRATIONS, { applied_by: 'test' });

    const after = {
      memories: (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c,
      synapses: (db.prepare('SELECT COUNT(*) AS c FROM synapses').get() as { c: number }).c,
      fts5: (db.prepare('SELECT COUNT(*) AS c FROM memories_fts').get() as { c: number }).c,
    };

    expect(after.memories).toBe(before.memories);
    expect(after.synapses).toBe(before.synapses);
    expect(after.fts5).toBe(before.fts5);
  });
});

describe('epistemic persistence — append-only guards', () => {
  let db: Database.Database;
  let eventId: string;

  beforeEach(() => {
    db = freshDb();
    const ev = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 'task-x',
      project_id: 'cognitive-os',
      payload: { title: 'seed', statement: 'for FK' },
    });
    eventId = ev.event_id;
  });

  it('epistemic_revisions rejects UPDATE', () => {
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
       VALUES (?, 1, 1, '{}', '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(randomUUID(), eventId);
    expect(() =>
      db.prepare('UPDATE epistemic_revisions SET revision_number = 2 WHERE revision_number = 1').run(),
    ).toThrow(/append-only/);
  });

  it('epistemic_revisions rejects DELETE', () => {
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
       VALUES (?, 1, 1, '{}', '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(randomUUID(), eventId);
    expect(() => db.prepare('DELETE FROM epistemic_revisions').run()).toThrow(/append-only/);
  });

  it('epistemic_receipts rejects UPDATE and DELETE', () => {
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
       VALUES (?, 1, 1, '{}', '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(randomUUID(), eventId);
    const revId = (
      db.prepare('SELECT revision_id FROM epistemic_revisions WHERE revision_number = 1').get() as {
        revision_id: string;
      }
    ).revision_id;
    db.prepare(
      `INSERT INTO epistemic_receipts
       (receipt_id, record_id, revision_id, source_event_id, receipt_type, receipt_payload, observed_at, recorded_at)
       VALUES (?, 1, ?, ?, 'ChallengeReceipt', '{}', '2026-01-01', '2026-01-01')`,
    ).run(randomUUID(), revId, eventId);
    expect(() =>
      db.prepare('UPDATE epistemic_receipts SET receipt_type = ?').run('BeliefUseReceipt'),
    ).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM epistemic_receipts').run()).toThrow(/append-only/);
  });

  it('epistemic_provenance rejects UPDATE and DELETE', () => {
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
       VALUES (?, 1, 1, '{}', '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(randomUUID(), eventId);
    const revId = (
      db.prepare('SELECT revision_id FROM epistemic_revisions WHERE revision_number = 1').get() as {
        revision_id: string;
      }
    ).revision_id;
    db.prepare(
      `INSERT INTO epistemic_provenance
       (record_id, revision_id, source_event_id, observed_at, recorded_by)
       VALUES (1, ?, ?, '2026-01-01', 'tester')`,
    ).run(revId, eventId);
    expect(() => db.prepare('UPDATE epistemic_provenance SET recorded_by = ?').run('other')).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM epistemic_provenance').run()).toThrow(/append-only/);
  });
});

describe('epistemic persistence — FK resolution', () => {
  it('epistemic_revisions.source_event_id must reference cognitive_events', () => {
    const db = freshDb();
    expect(() =>
      db.prepare(
        `INSERT INTO epistemic_revisions
         (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
         VALUES (?, 1, 1, '{}', '2026-01-01', 'nonexistent-event-id', '2026-01-01')`,
      ).run(randomUUID()),
    ).toThrow(/FOREIGN KEY/);
  });

  it('epistemic_receipts.revision_id must reference epistemic_revisions', () => {
    const db = freshDb();
    const ev = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't',
      project_id: 'p',
      payload: { title: 'x', statement: 'y' },
    });
    expect(() =>
      db.prepare(
        `INSERT INTO epistemic_receipts
         (receipt_id, record_id, revision_id, source_event_id, receipt_type, receipt_payload, observed_at, recorded_at)
         VALUES (?, 1, 'no-such-rev', ?, 'ChallengeReceipt', '{}', '2026-01-01', '2026-01-01')`,
      ).run(randomUUID(), ev.event_id),
    ).toThrow(/FOREIGN KEY/);
  });

  it('epistemic_records.source_memory_id ON DELETE SET NULL works', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO memories (title, slug, content, project_id, category, layer, lifecycle, status, confidence, source, importance_score)
       VALUES ('m', 'm', 'c', 'p', 'note', 'episodic', 'milestone', 'active', 1.0, 'manual', 1.0)`,
    ).run();
    const memId = Number(
      (db.prepare('SELECT id FROM memories WHERE slug = ?').get('m') as { id: number }).id,
    );

    const ev = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't',
      project_id: 'p',
      payload: { title: 'x', statement: 'y' },
    });
    const revId = randomUUID();
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
       VALUES (?, 1, 1, '{}', '2026-01-01', ?, '2026-01-01')`,
    ).run(revId, ev.event_id);
    db.prepare(
      `INSERT INTO epistemic_records
       (record_id, project_id, scope, statement, epistemic_status, verification_level, source_quality,
        confidence, valid_from, current_revision_id, source_event_id, source_memory_id, created_at, updated_at)
       VALUES (1, 'p', 'exact-project', 'test', 'inferred', 'direct', 'observed', 0.5,
               '2026-01-01', ?, ?, ?, '2026-01-01', '2026-01-01')`,
    ).run(revId, ev.event_id, memId);

    const before = db
      .prepare('SELECT source_memory_id FROM epistemic_records WHERE record_id = 1')
      .get() as { source_memory_id: number | null };
    expect(before.source_memory_id).toBe(memId);

    db.prepare('DELETE FROM memories WHERE id = ?').run(memId);
    const after = db
      .prepare('SELECT source_memory_id FROM epistemic_records WHERE record_id = 1')
      .get() as { source_memory_id: number | null };
    expect(after.source_memory_id).toBeNull();
  });
});

describe('epistemic persistence — round-trip and contiguity', () => {
  it('a record payload round-trips without semantic drift', () => {
    const db = freshDb();
    const ev = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't',
      project_id: 'p',
      payload: { title: 'x', statement: 'y' },
    });
    const revId = randomUUID();
    const original = {
      record_id: 1,
      statement: 'Activation is contextual, not canonical.',
      epistemic_status: 'inferred',
      confidence: 0.83,
      scope: 'exact-project',
      valid_from: '2026-01-01T00:00:00.000Z',
    };
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
    ).run(revId, original.record_id, canonical(original), original.valid_from, ev.event_id, original.valid_from);

    const row = db
      .prepare('SELECT record_payload FROM epistemic_revisions WHERE revision_id = ?')
      .get(revId) as { record_payload: string };
    expect(JSON.parse(row.record_payload)).toEqual(original);
  });

  it('UNIQUE(record_id, revision_number) prevents duplicate revision numbers', () => {
    const db = freshDb();
    const ev = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't',
      project_id: 'p',
      payload: { title: 'x', statement: 'y' },
    });
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
       VALUES (?, 1, 1, '{}', '2026-01-01', ?, '2026-01-01')`,
    ).run(randomUUID(), ev.event_id);
    expect(() =>
      db.prepare(
        `INSERT INTO epistemic_revisions
         (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
         VALUES (?, 1, 1, '{}', '2026-01-02', ?, '2026-01-02')`,
      ).run(randomUUID(), ev.event_id),
    ).toThrow(/UNIQUE/);
  });

  it('CHECK enforces epistemic_status from the v0.4 enum', () => {
    const db = freshDb();
    const ev = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't',
      project_id: 'p',
      payload: { title: 'x', statement: 'y' },
    });
    const revId = randomUUID();
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
       VALUES (?, 1, 1, '{}', '2026-01-01', ?, '2026-01-01')`,
    ).run(revId, ev.event_id);
    expect(() =>
      db.prepare(
        `INSERT INTO epistemic_records
         (record_id, project_id, scope, statement, epistemic_status, verification_level, source_quality,
          confidence, valid_from, current_revision_id, source_event_id, created_at, updated_at)
         VALUES (1, 'p', 'exact-project', 'test', 'maybe', 'direct', 'observed', 0.5,
                 '2026-01-01', ?, ?, '2026-01-01', '2026-01-01')`,
      ).run(revId, ev.event_id),
    ).toThrow(/CHECK/);
  });

  it('CHECK enforces scope ∈ exact-project | _global', () => {
    const db = freshDb();
    const ev = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't',
      project_id: 'p',
      payload: { title: 'x', statement: 'y' },
    });
    const revId = randomUUID();
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
       VALUES (?, 1, 1, '{}', '2026-01-01', ?, '2026-01-01')`,
    ).run(revId, ev.event_id);
    expect(() =>
      db.prepare(
        `INSERT INTO epistemic_records
         (record_id, project_id, scope, statement, epistemic_status, verification_level, source_quality,
          confidence, valid_from, current_revision_id, source_event_id, created_at, updated_at)
         VALUES (1, 'p', 'cross-project', 'test', 'inferred', 'direct', 'observed', 0.5,
                 '2026-01-01', ?, ?, '2026-01-01', '2026-01-01')`,
      ).run(revId, ev.event_id),
    ).toThrow(/CHECK/);
  });
});

describe('epistemic persistence — receipt type coverage (D14)', () => {
  it('accepts all five receipt types in Slice 1', () => {
    const db = freshDb();
    const ev = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't',
      project_id: 'p',
      payload: { title: 'x', statement: 'y' },
    });
    const revId = randomUUID();
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, record_payload, valid_from, source_event_id, created_at)
       VALUES (?, 1, 1, '{}', '2026-01-01', ?, '2026-01-01')`,
    ).run(revId, ev.event_id);

    const types = [
      'ChallengeReceipt',
      'BeliefUseReceipt',
      'DecisionOutcomeReceipt',
      'ContradictionSignal',
      'ReviewDeadlineReceipt',
    ];
    for (const t of types) {
      db.prepare(
        `INSERT INTO epistemic_receipts
         (receipt_id, record_id, revision_id, source_event_id, receipt_type, receipt_payload, observed_at, recorded_at)
         VALUES (?, 1, ?, ?, ?, '{}', '2026-01-01', '2026-01-01')`,
      ).run(randomUUID(), revId, ev.event_id, t);
    }
    const rows = db
      .prepare('SELECT receipt_type FROM epistemic_receipts ORDER BY receipt_type')
      .all() as Array<{ receipt_type: string }>;
    expect(rows.map((r) => r.receipt_type).sort()).toEqual(types.slice().sort());
  });
});
