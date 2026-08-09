/**
 * Ordered migration registry for mem-graph.
 *
 * Convention:
 *  - Version 1 captures the existing baseline (memories, synapses, tags,
 *    FTS5, triggers, decay_matrix, cognitive_events, policy_candidates,
 *    policy_evaluations). New databases have v1 applied at first boot;
 *    pre-existing databases adopt v1 with a `pre_hash` snapshot so future
 *    drift is detectable.
 *  - Each subsequent version is additive. Never rewrite an applied
 *    migration; create a new version instead.
 */

import { SCHEMA_SQL, DECAY_MATRIX_SEED } from './baseline.js';
import { COGNITIVE_SCHEMA_SQL } from '../cognitive/schema.js';
import type { Migration } from './registry.js';

/**
 * v1 — baseline. Captures everything that existed before the migration
 * runner. The post_check confirms memories and cognitive_events tables
 * exist with at least one row of expected shape.
 */
const v1: Migration = {
  version: 1,
  name: 'baseline-mem-graph-cognitive',
  sql: [
    SCHEMA_SQL,
    DECAY_MATRIX_SEED,
    COGNITIVE_SCHEMA_SQL,
  ].join('\n;\n'),
  post_check: `SELECT
    CASE
      WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories')
       AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='cognitive_events')
      THEN 1 ELSE 0
    END AS ok`,
};

/**
 * v2 — Epistemic Phase B persistence. Adds four tables:
 *   epistemic_revisions — immutable append-only revision log
 *   epistemic_receipts  — append-only receipts (challenge / use / outcome / contradiction)
 *   epistemic_provenance — immutable provenance links to memories and cognitive_events
 *   epistemic_records    — current projection (rebuildable, deletable, reproducible)
 *
 * Append-only triggers on revisions/receipts/provenance mirror the
 * cognitive_events pattern. Updates and deletes are rejected with a
 * stable error message.
 *
 * Per EPB-001 D2: revisions and receipts are canonical persistence;
 * epistemic_records is the rebuildable projection.
 *
 * Per EPB-001 D11: provenance FKs to memories(id) ON DELETE SET NULL and
 * cognitive_events(event_id). Never auto-creates or auto-updates memories.
 *
 * Per EPB-001 D19 / [[283]] Locked Invariant #14: read paths never touch
 * access counters, events, receipts, or projections.
 */
const v2: Migration = {
  version: 2,
  name: 'epistemic-phase-b-persistence',
  sql: `
-- Immutable revision log. Append-only via triggers.
CREATE TABLE epistemic_revisions (
  revision_id          TEXT PRIMARY KEY,
  record_id            INTEGER NOT NULL,
  revision_number      INTEGER NOT NULL,
  previous_revision_id TEXT REFERENCES epistemic_revisions(revision_id),
  record_payload       TEXT NOT NULL,
  valid_from           TEXT NOT NULL,
  valid_until          TEXT,
  supersedes_record_id INTEGER,
  superseded_by_record_id INTEGER,
  source_event_id      TEXT NOT NULL REFERENCES cognitive_events(event_id),
  created_at           TEXT NOT NULL,
  UNIQUE(record_id, revision_number)
);
CREATE INDEX idx_revisions_record ON epistemic_revisions(record_id, revision_number DESC);
CREATE INDEX idx_revisions_valid_from ON epistemic_revisions(valid_from);
CREATE INDEX idx_revisions_source_event ON epistemic_revisions(source_event_id);

CREATE TRIGGER epistemic_revisions_reject_update
BEFORE UPDATE ON epistemic_revisions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'epistemic_revisions is append-only: updates are rejected');
END;

CREATE TRIGGER epistemic_revisions_reject_delete
BEFORE DELETE ON epistemic_revisions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'epistemic_revisions is append-only: deletes are rejected');
END;

-- Append-only receipts. Five types per EPB-001 D14; ReviewDeadlineReceipt
-- arrives with Slice 3 (it is forward-compatible because the CHECK is
-- already in place for the four base types).
CREATE TABLE epistemic_receipts (
  receipt_id       TEXT PRIMARY KEY,
  record_id        INTEGER NOT NULL,
  revision_id      TEXT NOT NULL REFERENCES epistemic_revisions(revision_id),
  source_event_id  TEXT NOT NULL REFERENCES cognitive_events(event_id),
  receipt_type     TEXT NOT NULL CHECK (receipt_type IN
                    ('ChallengeReceipt','BeliefUseReceipt','DecisionOutcomeReceipt',
                     'ContradictionSignal','ReviewDeadlineReceipt')),
  receipt_payload  TEXT NOT NULL,
  independence_key TEXT,
  observed_at      TEXT NOT NULL,
  recorded_at      TEXT NOT NULL
);
CREATE INDEX idx_receipts_record ON epistemic_receipts(record_id, receipt_type);
CREATE INDEX idx_receipts_revision ON epistemic_receipts(revision_id);
CREATE INDEX idx_receipts_source_event ON epistemic_receipts(source_event_id);

CREATE TRIGGER epistemic_receipts_reject_update
BEFORE UPDATE ON epistemic_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'epistemic_receipts is append-only: updates are rejected');
END;

CREATE TRIGGER epistemic_receipts_reject_delete
BEFORE DELETE ON epistemic_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'epistemic_receipts is append-only: deletes are rejected');
END;

-- Immutable provenance links.
CREATE TABLE epistemic_provenance (
  provenance_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id        INTEGER NOT NULL,
  revision_id      TEXT NOT NULL REFERENCES epistemic_revisions(revision_id),
  source_memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  source_event_id  TEXT NOT NULL REFERENCES cognitive_events(event_id),
  excerpt_hash     TEXT,
  observed_at      TEXT NOT NULL,
  recorded_by      TEXT NOT NULL,
  observed_by_role TEXT,
  authority_input  TEXT
);
CREATE INDEX idx_provenance_record ON epistemic_provenance(record_id);
CREATE INDEX idx_provenance_revision ON epistemic_provenance(revision_id);
CREATE INDEX idx_provenance_source_event ON epistemic_provenance(source_event_id);

CREATE TRIGGER epistemic_provenance_reject_update
BEFORE UPDATE ON epistemic_provenance
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'epistemic_provenance is append-only: updates are rejected');
END;

CREATE TRIGGER epistemic_provenance_reject_delete
BEFORE DELETE ON epistemic_provenance
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'epistemic_provenance is append-only: deletes are rejected');
END;

-- Current projection. Rebuildable from revisions. D20: source_memory_id
-- FK to memories(id) ON DELETE SET NULL. Never auto-create or auto-update
-- memories from an epistemic admission.
CREATE TABLE epistemic_records (
  record_id              INTEGER PRIMARY KEY,
  project_id             TEXT NOT NULL,
  scope                  TEXT NOT NULL CHECK (scope IN ('exact-project','_global')),
  statement              TEXT NOT NULL,
  epistemic_status       TEXT NOT NULL CHECK (epistemic_status IN
                          ('verified','corroborated','inferred','reported',
                           'assumed','contested','stale','retracted')),
  verification_level     TEXT NOT NULL,
  source_quality         TEXT NOT NULL,
  confidence             REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  valid_from             TEXT NOT NULL,
  valid_until            TEXT,
  current_revision_id    TEXT NOT NULL REFERENCES epistemic_revisions(revision_id),
  source_event_id        TEXT NOT NULL REFERENCES cognitive_events(event_id),
  source_memory_id       INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  superseded_by_record_id INTEGER REFERENCES epistemic_records(record_id)
);
CREATE INDEX idx_records_project ON epistemic_records(project_id);
CREATE INDEX idx_records_status ON epistemic_records(epistemic_status);
CREATE INDEX idx_records_valid_from ON epistemic_records(valid_from);
CREATE INDEX idx_records_current_revision ON epistemic_records(current_revision_id);
CREATE INDEX idx_records_source_memory ON epistemic_records(source_memory_id);
`,
  post_check: `SELECT
    CASE
      WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='epistemic_revisions')
       AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='epistemic_receipts')
       AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='epistemic_provenance')
       AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='epistemic_records')
      THEN 1 ELSE 0
    END AS ok`,
};

export const MIGRATIONS: ReadonlyArray<Migration> = [v1, v2];
