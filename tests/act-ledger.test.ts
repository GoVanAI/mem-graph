import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { checkpointActLedger } from '../src/cognitive/act/ledger-contract.js';
import { SCHEMA_SQL } from '../src/migrations/baseline.js';

describe('ACT Ledger Contract', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it('mints a new ACT task ledger at phase intake', () => {
    const result = checkpointActLedger(db, {
      project_id: 'mem-graph',
      task_id: 'test-act-001',
      agent_id: 'agy-mem-graph',
      axiom: {
        objective: 'Test ACT ledger initialization',
        grounded_paths: ['src/index.ts'],
        oracle_command: 'npm test',
      },
      cascade: {
        direct_dependents: ['src/cognitive/act/ledger-contract.ts'],
        system_invariants: ['SQLite schema consistency'],
      },
      trace: {
        phase: 'intake',
      },
    });

    expect(result.id).toBeGreaterThan(0);
    expect(result.phase).toBe('intake');
    expect(result.status).toBe('active');
    expect(result.title).toContain('ACT Ledger :: mem-graph :: agy-mem-graph :: test-act-001');

    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.id) as any;
    expect(row).toBeDefined();
    expect(row.layer).toBe('working');
    expect(row.category).toBe('task_ledger');
    expect(row.status).toBe('active');
    expect(row.lifecycle).toBe('ephemeral');

    const parsed = JSON.parse(row.content);
    expect(parsed.act_ledger.axiom.objective).toBe('Test ACT ledger initialization');
    expect(parsed.act_ledger.phase).toBe('intake');
  });

  it('updates an existing ACT ledger on phase close', () => {
    const intake = checkpointActLedger(db, {
      project_id: 'mem-graph',
      task_id: 'test-act-002',
      axiom: {
        objective: 'Task to be closed',
      },
      cascade: {},
      trace: {
        phase: 'intake',
      },
    });

    const closeResult = checkpointActLedger(
      db,
      {
        project_id: 'mem-graph',
        task_id: 'test-act-002',
        axiom: {
          objective: 'Task to be closed',
        },
        cascade: {},
        trace: {
          phase: 'close',
          terminal_evidence: 'All tests passed with exit code 0',
        },
      },
      intake.id,
    );

    expect(closeResult.id).toBe(intake.id);
    expect(closeResult.phase).toBe('close');
    expect(closeResult.status).toBe('archived');

    const row = db.prepare('SELECT status, content FROM memories WHERE id = ?').get(intake.id) as any;
    expect(row.status).toBe('archived');
    const parsed = JSON.parse(row.content);
    expect(parsed.act_ledger.trace.terminal_evidence).toBe('All tests passed with exit code 0');
  });
});
