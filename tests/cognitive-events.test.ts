import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { appendCognitiveEvent, listCognitiveEvents, verifyCognitiveEventChain } from '../src/cognitive/events.js';
import { COGNITIVE_SCHEMA_SQL } from '../src/cognitive/schema.js';

function createLedger(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(COGNITIVE_SCHEMA_SQL);
  return db;
}

describe('Cognitive OS event ledger', () => {
  it('appends deterministic JSON events and reconstructs them in sequence order', () => {
    const db = createLedger();
    const first = appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: 'task-1',
      project_id: 'project-a',
      payload: { z: 1, nested: { b: true, a: 'first' } },
      observed_at: '2026-08-01T00:00:00.000Z',
    });
    const second = appendCognitiveEvent(db, {
      event_type: 'ExecutionObserved',
      task_id: 'task-1',
      project_id: 'project-a',
      payload: { result: 'changed' },
      observed_at: '2026-08-01T00:01:00.000Z',
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previous_hash).toBe(first.event_hash);
    expect(listCognitiveEvents(db).map((event) => event.event_id)).toEqual([first.event_id, second.event_id]);
    expect(db.prepare('SELECT payload FROM cognitive_events WHERE sequence = 1').get()).toEqual({
      payload: '{"nested":{"a":"first","b":true},"z":1}',
    });
    db.close();
  });

  it('returns the existing event for identical idempotent input and rejects changed content', () => {
    const db = createLedger();
    const input = {
      event_type: 'EvidenceObserved' as const,
      task_id: 'task-2',
      project_id: 'project-a',
      payload: { evidence: 'clean retrieval', count: 1 },
      idempotency_key: 'evidence-task-2',
      observed_at: '2026-08-01T00:00:00.000Z',
    };
    const original = appendCognitiveEvent(db, input);
    const replay = appendCognitiveEvent(db, { ...input, payload: { count: 1, evidence: 'clean retrieval' } });

    expect(replay).toEqual(original);
    expect(listCognitiveEvents(db)).toHaveLength(1);
    expect(() => appendCognitiveEvent(db, { ...input, payload: { evidence: 'contaminated retrieval', count: 1 } }))
      .toThrow(/Idempotency key/);
    db.close();
  });

  it('rejects direct mutation and deletion while retaining a verifiable hash chain', () => {
    const db = createLedger();
    appendCognitiveEvent(db, {
      event_type: 'PolicyCandidateCreated', task_id: 'task-3', project_id: 'project-a', payload: { policy: 'strict' },
    });
    appendCognitiveEvent(db, {
      event_type: 'PolicyEvaluated', task_id: 'task-3', project_id: 'project-a', payload: { outcome: 'succeeded' },
    });

    expect(() => db.prepare("UPDATE cognitive_events SET task_id = 'tampered' WHERE sequence = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM cognitive_events WHERE sequence = 1').run()).toThrow(/append-only/);
    expect(verifyCognitiveEventChain(db)).toEqual({ valid: true, event_count: 2 });
    db.close();
  });

  it('detects a broken chain during audit verification', () => {
    const db = createLedger();
    appendCognitiveEvent(db, {
      event_type: 'DecisionMade', task_id: 'task-4', project_id: 'project-a', payload: { choice: 'A' },
    });
    db.exec('DROP TRIGGER cognitive_events_reject_update');
    db.prepare("UPDATE cognitive_events SET event_hash = 'tampered' WHERE sequence = 1").run();

    expect(verifyCognitiveEventChain(db)).toMatchObject({
      valid: false,
      event_count: 1,
      failing_sequence: 1,
    });
    db.close();
  });
});
