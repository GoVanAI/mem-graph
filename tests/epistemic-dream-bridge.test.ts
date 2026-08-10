import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  createDreamAdmissionEnvelope,
} from '../src/epistemic/dream-bridge.js';
import {
  EpistemicTaskLedger,
  ledgerFromSnapshot,
  type CreateLedgerInput,
  type TaskLedgerSnapshot,
} from '../src/epistemic/task-ledger.js';

function baseInput(overrides: Record<string, unknown> = {}): CreateLedgerInput {
  return {
    project_id: 'cognitive-os',
    task_id: 'dream-bridge-fixture',
    session_id: 'dream-bridge-session',
    done_condition: 'Dream receives only a terminal, auditable task ledger.',
    intent: 'Provide terminal task context to a governed Dream admission pass.',
    ...overrides,
  };
}

function closedSnapshot(): TaskLedgerSnapshot {
  const ledger = new EpistemicTaskLedger(baseInput());
  ledger.recordCheckpoint({
    kind: 'evidence',
    recorded_at: '2026-08-09T00:00:00.000Z',
    summary: 'focused tests passed',
    references: ['test:epistemic-dream-bridge'],
  });
  ledger.recordWorkingBelief({
    material: true,
    record_id: 101,
    statement: 'Closed snapshots retain auditable intent.',
    confidence: 1,
  });
  ledger.recordWorkingBelief({
    material: false,
    statement: 'A one-off observation remains non-material.',
    confidence: 0.5,
  });
  ledger.close();
  return ledger.snapshot();
}

describe('Dream task-ledger bridge', () => {
  it('round-trips closed-ledger identity and preserves terminal context', () => {
    const snapshot = closedSnapshot();
    const handoff = createDreamAdmissionEnvelope(snapshot);

    expect(handoff.source).toBe('task-ledger');
    expect(handoff.ledger_snapshot.project_id).toBe(snapshot.project_id);
    expect(handoff.ledger_snapshot.task_id).toBe(snapshot.task_id);
    expect(handoff.ledger_snapshot.agent_id).toBe(snapshot.agent_id);
    expect(handoff.ledger_snapshot.closed_at).toBe(snapshot.closed_at);
    expect(handoff.done_condition).toBe(snapshot.done_condition);
    expect(handoff.intent).toBe(snapshot.intent);
  });

  it('exposes only material beliefs in the top-level working set', () => {
    const handoff = createDreamAdmissionEnvelope(closedSnapshot());

    expect(handoff.working_set).toHaveLength(1);
    expect(handoff.working_set.every((entry) => entry.material)).toBe(true);
    expect(handoff.ledger_snapshot.epistemic_working_set).toHaveLength(2);
  });

  it('preserves the phase trail, done condition, and intent', () => {
    const snapshot = closedSnapshot();
    const handoff = createDreamAdmissionEnvelope(snapshot);

    expect(handoff.phase_trail).toEqual(snapshot.phase_trail);
    expect(handoff.done_condition).toContain('terminal');
    expect(handoff.intent).toContain('Dream admission');
  });

  it('retains done condition and intent when a snapshot is restored', () => {
    const snapshot = closedSnapshot();
    const restored = ledgerFromSnapshot(snapshot);

    expect(restored.done_condition).toBe(snapshot.done_condition);
    expect(restored.intent).toBe(snapshot.intent);
  });

  it('refuses open and structurally inconsistent snapshots', () => {
    const open = closedSnapshot();
    open.status = 'open';
    expect(() => createDreamAdmissionEnvelope(open)).toThrow(/open/i);

    const inconsistent = closedSnapshot();
    inconsistent.closed_at = null;
    expect(() => createDreamAdmissionEnvelope(inconsistent)).toThrow(/closed_at/i);

    const invalidTimestamp = closedSnapshot();
    invalidTimestamp.updated_at = 'not-a-timestamp';
    expect(() => createDreamAdmissionEnvelope(invalidTimestamp)).toThrow(/timestamp/i);

    const malformedTrail = closedSnapshot();
    malformedTrail.phase_trail = [null] as unknown as TaskLedgerSnapshot['phase_trail'];
    expect(() => createDreamAdmissionEnvelope(malformedTrail)).toThrow(/phase trail/i);

    const malformedWorkingSet = closedSnapshot();
    malformedWorkingSet.epistemic_working_set = [
      { material: true, statement: '', confidence: 2 },
    ];
    expect(() => createDreamAdmissionEnvelope(malformedWorkingSet)).toThrow(/working-set/i);
  });

  it('isolates the result from later caller mutation', () => {
    const snapshot = closedSnapshot();
    const handoff = createDreamAdmissionEnvelope(snapshot);

    snapshot.phase_trail[0].summary = 'mutated input';
    snapshot.phase_trail[0].references?.push('input-reference');
    snapshot.epistemic_working_set[0].statement = 'mutated input belief';

    expect(handoff.phase_trail[0].summary).toBe('focused tests passed');
    expect(handoff.phase_trail[0].references).toEqual(['test:epistemic-dream-bridge']);
    expect(handoff.working_set[0].statement).toBe('Closed snapshots retain auditable intent.');

    handoff.ledger_snapshot.phase_trail[0].summary = 'mutated result';
    handoff.working_set[0].statement = 'mutated result belief';
    expect(snapshot.phase_trail[0].summary).toBe('mutated input');
    expect(snapshot.epistemic_working_set[0].statement).toBe('mutated input belief');

    expect(handoff.phase_trail[0].summary).toBe('focused tests passed');
    expect(handoff.ledger_snapshot.epistemic_working_set[0].statement)
      .toBe('Closed snapshots retain auditable intent.');
  });

  it('is a pure static bridge with no tool, persistence, or MCP dependency', async () => {
    const source = await readFile(
      new URL('../src/epistemic/dream-bridge.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toMatch(/from ['\"][^'\"]*(?:tools|db|mcp|memory)[^'\"]*['\"]/i);
    expect(source).not.toMatch(/appendCognitiveEvent|memory_(?:add|update|create)|setInterval/);
  });
});
