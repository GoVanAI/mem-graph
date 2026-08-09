/**
 * Event-contract tests — Step 3 of EPB-001.
 *
 * Oracle requirements (verbatim from [[283]] Step 3 acceptance):
 *   - every new event type/version has a validator and stable invariant codes;
 *   - malformed or unsupported input consumes no sequence and changes no hash;
 *   - version-1 history remains readable;
 *   - event_type CHECK evolution occurs only through a migration;
 *   - causation and project/task compatibility are checked;
 *   - existing policy/retrieval semantics remain unchanged.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  appendCognitiveEvent,
  listCognitiveEvents,
  verifyCognitiveEventChain,
  auditCognitiveEventShapes,
} from '../src/cognitive/events.js';
import {
  validateCognitiveEventPayload,
  EVENT_CONTRACTS,
  SUPPORTED_SCHEMA_VERSIONS,
  isSupportedSchemaVersion,
} from '../src/cognitive/event-contracts.js';
import { COGNITIVE_SCHEMA_SQL } from '../src/cognitive/schema.js';
import { COGNITIVE_EVENT_TYPES } from '../src/cognitive/types.js';

function createLedger(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(COGNITIVE_SCHEMA_SQL);
  return db;
}

describe('event contracts — registry surface', () => {
  it('every CognitiveEventType has a registered validator', () => {
    for (const t of COGNITIVE_EVENT_TYPES) {
      expect(EVENT_CONTRACTS[t]).toBeDefined();
      expect(typeof EVENT_CONTRACTS[t]).toBe('function');
    }
  });

  it('supported schema versions include 1 (legacy) and 2 (typed)', () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(1);
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(2);
    expect(isSupportedSchemaVersion(1)).toBe(true);
    expect(isSupportedSchemaVersion(2)).toBe(true);
    expect(isSupportedSchemaVersion(99)).toBe(false);
  });
});

describe('event contracts — BeliefRevised (v0.4 semantics)', () => {
  it('accepts a genesis BeliefRevised with record_id, statement, confidence, epistemic_status', () => {
    const r = validateCognitiveEventPayload('BeliefRevised', {
      record_id: 'rec-1',
      genesis: true,
      statement: 'Activation is contextual, not canonical retrieval.',
      confidence: 0.85,
      epistemic_status: 'inferred',
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a chained BeliefRevised with previous_revision_id', () => {
    const r = validateCognitiveEventPayload('BeliefRevised', {
      record_id: 'rec-1',
      previous_revision_id: 'uuid-v4-here',
      statement: 'Activation is contextual.',
      confidence: 0.9,
      epistemic_status: 'corroborated',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects BeliefRevised missing both previous_revision_id and genesis', () => {
    const r = validateCognitiveEventPayload('BeliefRevised', {
      record_id: 'rec-1',
      statement: 'orphan',
      confidence: 0.5,
      epistemic_status: 'inferred',
    });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.code)).toContain('INVALID_REVISION_REFERENCE');
  });

  it('rejects BeliefRevised with confidence outside [0,1]', () => {
    const r = validateCognitiveEventPayload('BeliefRevised', {
      record_id: 'rec-1',
      genesis: true,
      statement: 'x',
      confidence: 1.5,
      epistemic_status: 'inferred',
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0].code).toBe('INVALID_FIELD_TYPE');
    expect(r.failures[0].path).toBe('confidence');
  });

  it('rejects BeliefRevised with unknown epistemic_status', () => {
    const r = validateCognitiveEventPayload('BeliefRevised', {
      record_id: 'rec-1',
      genesis: true,
      statement: 'x',
      confidence: 0.5,
      epistemic_status: 'maybe',
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0].code).toBe('INVALID_FIELD_VALUE');
  });
});

describe('event contracts — EvidenceObserved (provenance)', () => {
  it('accepts EvidenceObserved with source_event_id', () => {
    const r = validateCognitiveEventPayload('EvidenceObserved', {
      source_event_id: 'uuid-of-prior-event',
    });
    expect(r.ok).toBe(true);
  });

  it('accepts EvidenceObserved with source_memory_id (integer FK)', () => {
    const r = validateCognitiveEventPayload('EvidenceObserved', {
      source_memory_id: 42,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects EvidenceObserved with neither reference', () => {
    const r = validateCognitiveEventPayload('EvidenceObserved', { excerpt_hash: 'abc' });
    expect(r.ok).toBe(false);
    expect(r.failures[0].code).toBe('INVALID_PROVENANCE_SHAPE');
  });

  it('rejects EvidenceObserved with non-integer source_memory_id', () => {
    const r = validateCognitiveEventPayload('EvidenceObserved', { source_memory_id: '42' });
    expect(r.ok).toBe(false);
    // The shape validator runs first; a string for source_memory_id means
    // neither reference is well-formed, so INVALID_PROVENANCE_SHAPE fires
    // before INVALID_FIELD_TYPE.
    expect(r.failures.map((f) => f.code)).toContain('INVALID_PROVENANCE_SHAPE');
  });
});

describe('event contracts — appendCognitiveEvent gating', () => {
  it('legacy v1 admission accepts opaque payloads (Locked Invariant #2)', () => {
    const db = createLedger();
    // No schema_version → defaults to legacy v1; opaque payload is fine.
    const ev = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't1',
      project_id: 'p1',
      payload: { anything: 'goes', even: ['array'] },
    });
    expect(ev.sequence).toBe(1);
    expect(verifyCognitiveEventChain(db).valid).toBe(true);
  });

  it('v2 admission rejects payload that violates the typed contract', () => {
    const db = createLedger();
    expect(() =>
      appendCognitiveEvent(db, {
        event_type: 'DecisionMade',
        task_id: 't1',
        project_id: 'p1',
        payload: { title: '' },
        schema_version: 2,
      }),
    ).toThrow(/EPISTEMIC_PAYLOAD_INVALID/);
    // No sequence was consumed; ledger is empty.
    expect(listCognitiveEvents(db)).toHaveLength(0);
  });

  it('v2 admission accepts a contract-compliant DecisionMade', () => {
    const db = createLedger();
    const ev = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't1',
      project_id: 'p1',
      payload: { title: 'Use strict retrieval before graph expansion', statement: 'See mvp-001' },
      schema_version: 2,
    });
    expect(ev.sequence).toBe(1);
    expect(ev.schema_version).toBe(2);
  });

  it('v2 admission rejects a BeliefRevised missing the revision reference', () => {
    const db = createLedger();
    expect(() =>
      appendCognitiveEvent(db, {
        event_type: 'BeliefRevised',
        task_id: 't1',
        project_id: 'p1',
        payload: {
          record_id: 'rec-x',
          statement: 'orphan',
          confidence: 0.5,
          epistemic_status: 'inferred',
        },
        schema_version: 2,
      }),
    ).toThrow(/INVALID_REVISION_REFERENCE/);
    expect(listCognitiveEvents(db)).toHaveLength(0);
  });
});

describe('event contracts — read-only integrity audit', () => {
  it('auditCognitiveEventShapes returns zero violations on an empty ledger', () => {
    const db = createLedger();
    const audit = auditCognitiveEventShapes(db);
    expect(audit.total_events).toBe(0);
    expect(audit.v1_events).toBe(0);
    expect(audit.v2_events).toBe(0);
    expect(audit.shape_violations).toEqual([]);
  });

  it('audit treats v1 events as legacy and reports no violations', () => {
    const db = createLedger();
    appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't',
      project_id: 'p',
      payload: { anything: 'goes' },
    });
    const audit = auditCognitiveEventShapes(db);
    expect(audit.v1_events).toBe(1);
    expect(audit.v2_events).toBe(0);
    expect(audit.shape_violations).toEqual([]);
  });

  it('audit flags v2 events whose payload violates the contract', () => {
    const db = createLedger();
    // Bypass the admission gate by inserting directly to simulate
    // post-hoc audit of legacy or migrated data that should be flagged.
    db.prepare(
      `INSERT INTO cognitive_events
       (sequence, event_id, event_type, task_id, project_id, payload,
        schema_version, observed_at, created_at, previous_hash, event_hash)
       VALUES (1, ?, 'BeliefRevised', 't', 'p', ?, 2,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, ?)`,
    ).run(
      'manual-uuid',
      JSON.stringify({
        record_id: 'rec-1',
        statement: 'no revision ref',
        confidence: 0.5,
        epistemic_status: 'inferred',
      }),
      'manual-hash',
    );
    const audit = auditCognitiveEventShapes(db);
    expect(audit.v2_events).toBe(1);
    expect(audit.shape_violations).toHaveLength(1);
    expect(audit.shape_violations[0].event_type).toBe('BeliefRevised');
    expect(audit.shape_violations[0].failures[0].code).toBe('INVALID_REVISION_REFERENCE');
  });

  it('audit is read-only: it never mutates access counters or sequences', () => {
    const db = createLedger();
    appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't',
      project_id: 'p',
      payload: { title: 'x', statement: 'y' },
      schema_version: 2,
    });
    const beforeSeq = (db.prepare('SELECT MAX(sequence) AS s FROM cognitive_events').get() as {
      s: number;
    }).s;
    auditCognitiveEventShapes(db);
    const afterSeq = (db.prepare('SELECT MAX(sequence) AS s FROM cognitive_events').get() as {
      s: number;
    }).s;
    expect(afterSeq).toBe(beforeSeq);
    const eventCount = (db.prepare('SELECT COUNT(*) AS c FROM cognitive_events').get() as {
      c: number;
    }).c;
    expect(eventCount).toBe(1);
  });

  it('audit reports unsupported schema versions as INVALID_EVENT_VERSION', () => {
    const db = createLedger();
    // Bypass the gate by inserting directly (simulates legacy / migrated data).
    db.prepare(
      `INSERT INTO cognitive_events
       (sequence, event_id, event_type, task_id, project_id, payload,
        schema_version, observed_at, created_at, previous_hash, event_hash)
       VALUES (1, ?, 'DecisionMade', 't', 'p', '{}', 99,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, ?)`,
    ).run('manual-uuid', 'manual-hash');
    const audit = auditCognitiveEventShapes(db);
    expect(audit.total_events).toBe(1);
    expect(audit.shape_violations).toHaveLength(1);
    expect(audit.shape_violations[0].failures[0].code).toBe('INVALID_EVENT_VERSION');
  });
});

describe('event contracts — backward compat with existing chain verification', () => {
  it('mixed v1+v2 events still verify under chain integrity', () => {
    const db = createLedger();
    appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 't',
      project_id: 'p',
      payload: { legacy: true },
    });
    appendCognitiveEvent(db, {
      event_type: 'BeliefRevised',
      task_id: 't',
      project_id: 'p',
      payload: {
        record_id: 'rec-1',
        genesis: true,
        statement: 'fresh',
        confidence: 0.7,
        epistemic_status: 'inferred',
      },
      schema_version: 2,
    });
    const result = verifyCognitiveEventChain(db);
    expect(result.valid).toBe(true);
    expect(result.event_count).toBe(2);
  });
});
