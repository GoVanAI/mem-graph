/**
 * Epistemic admission tests — Step 5 of EPB-001.
 *
 * Oracle requirements (verbatim from [[283]] Step 5 acceptance):
 *   - the transaction follows the locked order;
 *   - identical retries return the same event/revision/receipt;
 *   - changed payload under the same key fails;
 *   - stale expected_revision fails without writes;
 *   - injected failure at every write boundary rolls back event, revision,
 *     receipt, and projection; no partial state is visible.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/migrations/registry.js';
import { MIGRATIONS } from '../src/migrations/index.js';
import {
  admitEpistemicRecord,
  appendEpistemicReceipt,
  EpistemicAdmissionError,
} from '../src/epistemic/persistence.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS, { applied_by: 'test' });
  return db;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotency_key: 'idem-1',
    project_id: 'cognitive-os',
    scope: 'exact-project' as const,
    statement: 'Activation is contextual, not canonical retrieval.',
    epistemic_status: 'inferred' as const,
    verification_level: 'direct',
    source_quality: 'observed',
    confidence: 0.85,
    valid_from: '2026-08-09T00:00:00.000Z',
    task_id: 'task-1',
    ...overrides,
  };
}

describe('admitEpistemicRecord — happy path', () => {
  it('admits a new record and returns event/revision/projection row counts', () => {
    const db = freshDb();
    const r = admitEpistemicRecord(db, baseInput());
    expect(r.record_id).toBe(1);
    expect(r.revision_number).toBe(1);
    expect(r.idempotent_replay).toBe(false);
    expect(r.sequence).toBeGreaterThan(0);
    expect(r.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.revision_id).toMatch(/^[0-9a-f-]{36}$/);

    const evCount = (db.prepare('SELECT COUNT(*) AS c FROM cognitive_events').get() as {
      c: number;
    }).c;
    const revCount = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get() as {
      c: number;
    }).c;
    const provCount = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_provenance').get() as {
      c: number;
    }).c;
    const recCount = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_records').get() as {
      c: number;
    }).c;
    expect(evCount).toBe(1);
    expect(revCount).toBe(1);
    expect(provCount).toBe(1);
    expect(recCount).toBe(1);
  });

  it('enforces v2 typed contract on the BeliefRevised payload', () => {
    const db = freshDb();
    // Missing record_id, statement, confidence, epistemic_status → all v2 failures.
    // Note: validateCommon catches missing statement before the cognitive
    // event validator runs, so the error message starts with
    // MISSING_REQUIRED_FIELD rather than EPISTEMIC_PAYLOAD_INVALID.
    expect(() =>
      admitEpistemicRecord(db, baseInput({ statement: '', confidence: 2 })),
    ).toThrow(/MISSING_REQUIRED_FIELD|EPISTEMIC_PAYLOAD_INVALID/);
    // No state was written.
    expect((db.prepare('SELECT COUNT(*) AS c FROM cognitive_events').get() as { c: number }).c).toBe(0);
  });

  it('refuses non-empty relations with RELATION_PERSISTENCE_NOT_ADOPTED', () => {
    const db = freshDb();
    expect(() =>
      admitEpistemicRecord(
        db,
        baseInput({ relations: [{ type: 'supports', target_id: 'x' }] }),
      ),
    ).toThrow(EpistemicAdmissionError);
    try {
      admitEpistemicRecord(
        db,
        baseInput({ idempotency_key: 'idem-2', relations: [{ type: 'supports', target_id: 'x' }] }),
      );
    } catch (e) {
      expect((e as EpistemicAdmissionError).code).toBe('RELATION_PERSISTENCE_NOT_ADOPTED');
    }
    expect((db.prepare('SELECT COUNT(*) AS c FROM cognitive_events').get() as { c: number }).c).toBe(0);
  });
});

describe('admitEpistemicRecord — idempotency', () => {
  it('returns the existing record on identical retry', () => {
    const db = freshDb();
    const first = admitEpistemicRecord(db, baseInput());
    const second = admitEpistemicRecord(db, baseInput());
    expect(second.idempotent_replay).toBe(true);
    expect(second.revision_id).toBe(first.revision_id);
    expect(second.event_id).toBe(first.event_id);
    expect(second.record_id).toBe(first.record_id);
    expect((db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get() as { c: number }).c).toBe(1);
  });

  it('rejects changed payload under the same idempotency_key', () => {
    const db = freshDb();
    admitEpistemicRecord(db, baseInput());
    expect(() =>
      admitEpistemicRecord(db, baseInput({ confidence: 0.42 })),
    ).toThrow(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    expect((db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get() as { c: number }).c).toBe(1);
  });
});

describe('admitEpistemicRecord — STALE_REVISION', () => {
  it('rejects create of an existing record_id with expected_revision=0', () => {
    const db = freshDb();
    const first = admitEpistemicRecord(db, baseInput({ record_id: 42 }));
    expect(first.record_id).toBe(42);
    expect(() =>
      admitEpistemicRecord(
        db,
        baseInput({ idempotency_key: 'idem-stale-1', record_id: 42, expected_revision: 0 }),
      ),
    ).toThrow(/STALE_REVISION/);
  });

  it('rejects revise with wrong expected_revision', () => {
    const db = freshDb();
    const first = admitEpistemicRecord(db, baseInput({ record_id: 7 }));
    expect(() =>
      admitEpistemicRecord(
        db,
        baseInput({ idempotency_key: 'idem-stale-2', record_id: 7, expected_revision: 99 }),
      ),
    ).toThrow(/STALE_REVISION/);
    expect((db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get() as { c: number }).c).toBe(1);
  });

  it('rejects revise with wrong previous_revision_id', () => {
    const db = freshDb();
    admitEpistemicRecord(db, baseInput({ record_id: 8 }));
    expect(() =>
      admitEpistemicRecord(
        db,
        baseInput({
          idempotency_key: 'idem-stale-3',
          record_id: 8,
          expected_revision: 1,
          previous_revision_id: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).toThrow(/STALE_REVISION/);
    expect((db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get() as { c: number }).c).toBe(1);
  });

  it('accepts a valid revise that chains off the prior revision', () => {
    const db = freshDb();
    const first = admitEpistemicRecord(db, baseInput({ record_id: 9 }));
    expect(first.revision_id).toBeDefined();
    const second = admitEpistemicRecord(
      db,
      baseInput({
        idempotency_key: 'idem-rev-2',
        record_id: 9,
        expected_revision: 1,
        previous_revision_id: first.revision_id,
        confidence: 0.9,
      }),
    );
    expect(second.revision_number).toBe(2);
    expect(second.idempotent_replay).toBe(false);
    const revCount = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get() as {
      c: number;
    }).c;
    expect(revCount).toBe(2);
  });
});

describe('admitEpistemicRecord — failure injection rollback', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  const boundaries = [
    'after_validate',
    'after_idempotency_lookup',
    'after_event_append',
    'after_revision_insert',
    'after_provenance_insert',
    'after_projection_upsert',
  ] as const;

  for (const boundary of boundaries) {
    it(`rolls back fully on injected failure at '${boundary}'`, () => {
      let caught: unknown;
      try {
        admitEpistemicRecord(db, baseInput({ idempotency_key: `idem-${boundary}` }), {
          __inject_failure_at: boundary,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);

      const ev = (db.prepare('SELECT COUNT(*) AS c FROM cognitive_events').get() as { c: number }).c;
      const rev = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get() as { c: number }).c;
      const prov = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_provenance').get() as { c: number }).c;
      const rec = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_records').get() as { c: number }).c;
      // Every boundary must leave zero state behind.
      expect(ev).toBe(0);
      expect(rev).toBe(0);
      expect(prov).toBe(0);
      expect(rec).toBe(0);
    });
  }
});

describe('appendEpistemicReceipt', () => {
  it('appends a ChallengeReceipt linked to a revision', () => {
    const db = freshDb();
    const r = admitEpistemicRecord(db, baseInput({ record_id: 11 }));
    const receipt = appendEpistemicReceipt(db, {
      idempotency_key: 'idem-receipt-1',
      record_id: 11,
      revision_id: r.revision_id,
      receipt_type: 'ChallengeReceipt',
      receipt_payload: { challenge: 'clean retrieval only', method: 'scoped search' },
      observed_at: '2026-08-09T01:00:00.000Z',
      task_id: 'task-1',
      project_id: 'cognitive-os',
    });
    expect(receipt.receipt_id).toMatch(/^[0-9a-f-]{36}$/);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_receipts').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('returns the same receipt on identical retry', () => {
    const db = freshDb();
    const r = admitEpistemicRecord(db, baseInput({ record_id: 12 }));
    const a = appendEpistemicReceipt(db, {
      idempotency_key: 'idem-receipt-2',
      record_id: 12,
      revision_id: r.revision_id,
      receipt_type: 'BeliefUseReceipt',
      receipt_payload: { used_in: 'task-99' },
      observed_at: '2026-08-09T01:00:00.000Z',
      task_id: 'task-1',
      project_id: 'cognitive-os',
    });
    const b = appendEpistemicReceipt(db, {
      idempotency_key: 'idem-receipt-2',
      record_id: 12,
      revision_id: r.revision_id,
      receipt_type: 'BeliefUseReceipt',
      receipt_payload: { used_in: 'task-99' },
      observed_at: '2026-08-09T01:00:00.000Z',
      task_id: 'task-1',
      project_id: 'cognitive-os',
    });
    expect(b.receipt_id).toBe(a.receipt_id);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_receipts').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('rejects receipt with unknown revision_id', () => {
    const db = freshDb();
    admitEpistemicRecord(db, baseInput({ record_id: 13 }));
    expect(() =>
      appendEpistemicReceipt(db, {
        idempotency_key: 'idem-receipt-bad',
        record_id: 13,
        revision_id: '00000000-0000-0000-0000-000000000000',
        receipt_type: 'ContradictionSignal',
        receipt_payload: { severity: 'high' },
        observed_at: '2026-08-09T01:00:00.000Z',
        task_id: 'task-1',
        project_id: 'cognitive-os',
      }),
    ).toThrow(/STALE_REVISION/);
  });
});
