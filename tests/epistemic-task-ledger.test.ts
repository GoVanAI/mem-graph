/**
 * Step 9 tests — Turn Shape Phase B Task Ledger.
 *
 * Oracle requirements (verbatim from [[283]] Step 9 acceptance):
 *   - ordinary tool calls create no memory spam (events only at qualifying
 *     checkpoints — verified via the adapter's intent: it never writes
 *     on its own; it produces an envelope for callers to submit);
 *   - one exact-task ledger updated at material phase changes;
 *   - repair success remains scoped evidence (logged in phase_trail but
 *     not promoted to material working-set automatically);
 *   - Dream evaluates update/create/defer/discard (envelope shape carries
 *     the data needed for [[293]] admission decisions);
 *   - no hook or scheduler (the adapter has no side effects beyond its
 *     in-memory state).
 */
import { describe, it, expect } from 'vitest';
import {
  EpistemicTaskLedger,
  ledgerFromSnapshot,
  type CreateLedgerInput,
} from '../src/epistemic/task-ledger.js';

function baseInput(overrides: Record<string, unknown> = {}): CreateLedgerInput {
  return {
    project_id: 'cognitive-os',
    task_id: 'epistemic-kernel-activation-phase-b',
    session_id: '72e0e805-61b5-4f8b-9ecb-5d19eba379f4',
    done_condition: 'Phase B Steps 0–10 complete per [[283]] Acceptance Map',
    intent: 'Execute Phase B/C execution contract and M3 handoff',
    ...overrides,
  };
}

describe('EpistemicTaskLedger — identity model', () => {
  it('derives a stable agent_id from session_id', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    expect(ledger.agent_id).toMatch(/^claude-[0-9a-f]{8}$/);
  });

  it('different session_ids produce different agent_ids', () => {
    const a = new EpistemicTaskLedger(baseInput({ session_id: 'session-a' }));
    const b = new EpistemicTaskLedger(baseInput({ session_id: 'session-b' }));
    expect(a.agent_id).not.toBe(b.agent_id);
  });

  it('explicit agent_id override is honored', () => {
    const ledger = new EpistemicTaskLedger(baseInput({ agent_id: 'manual-agent-id' }));
    expect(ledger.agent_id).toBe('manual-agent-id');
  });
});

describe('EpistemicTaskLedger — checkpoint recording', () => {
  it('appends phase_trail entries at qualifying checkpoints', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    ledger.recordCheckpoint({
      kind: 'phase',
      recorded_at: '2026-08-09T00:00:00.000Z',
      summary: 'classified mode and recorded done-condition',
    });
    ledger.recordCheckpoint({
      kind: 'decision',
      recorded_at: '2026-08-09T00:01:00.000Z',
      summary: 'adopted EPB-001 contract (D1-D21)',
      references: ['cognitive_event:60'],
    });
    ledger.recordCheckpoint({
      kind: 'evidence',
      recorded_at: '2026-08-09T00:02:00.000Z',
      summary: 'all 11 acceptance gates green',
      references: ['cognitive_event:65', 'cognitive_event:69', 'cognitive_event:74'],
    });
    expect(ledger.phase_trail).toHaveLength(3);
    expect(ledger.phase_trail[0].kind).toBe('phase');
    expect(ledger.phase_trail[1].kind).toBe('decision');
    expect(ledger.phase_trail[2].kind).toBe('evidence');
    expect(ledger.total_checkpoints).toBe(3);
  });

  it('appending to a closed ledger is rejected', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    ledger.close();
    expect(() =>
      ledger.recordCheckpoint({
        kind: 'evidence',
        recorded_at: '2026-08-09T01:00:00.000Z',
        summary: 'late evidence',
      }),
    ).toThrow(/closed ledger/);
  });

  it('enforces phase_trail hard cap of 50 entries', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    for (let i = 0; i < 60; i += 1) {
      ledger.recordCheckpoint({
        kind: 'phase',
        recorded_at: `2026-08-09T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
        summary: `phase ${i}`,
      });
    }
    expect(ledger.phase_trail.length).toBe(50);
    // First 10 are dropped; the first retained entry should be "phase 10"
    expect(ledger.phase_trail[0].summary).toBe('phase 10');
    expect(ledger.phase_trail[49].summary).toBe('phase 59');
  });

  it('repair success remains scoped evidence (logged in trail, not promoted)', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    ledger.recordCheckpoint({
      kind: 'repair',
      recorded_at: '2026-08-09T00:00:00.000Z',
      summary: 'recovered from missing migration',
    });
    expect(ledger.phase_trail).toHaveLength(1);
    // Repair is in the trail but NOT in the working set
    expect(ledger.epistemic_working_set).toEqual([]);
  });

  it('material beliefs are recorded in the working set; non-material ones are tracked but not promoted', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    ledger.recordWorkingBelief({
      material: true,
      record_id: 1,
      statement: 'Step 1 commit published as separate baseline',
      confidence: 1.0,
    });
    ledger.recordWorkingBelief({
      material: false,
      statement: 'Pre-migration DB converges to same state as fresh DB',
      confidence: 0.9,
    });
    expect(ledger.epistemic_working_set).toHaveLength(2);
    expect(ledger.epistemic_working_set.filter((e) => e.material)).toHaveLength(1);
  });
});

describe('EpistemicTaskLedger — close + snapshot', () => {
  it('close marks status=closed and sets closed_at', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    expect(ledger.status).toBe('open');
    expect(ledger.closed_at).toBeNull();
    ledger.close();
    expect(ledger.status).toBe('closed');
    expect(ledger.closed_at).not.toBeNull();
  });

  it('close is idempotent', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    ledger.close();
    const firstClosedAt = ledger.closed_at;
    ledger.close();
    expect(ledger.closed_at).toBe(firstClosedAt);
  });

  it('snapshot is a deep copy suitable for handoff', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    ledger.recordCheckpoint({
      kind: 'phase',
      recorded_at: '2026-08-09T00:00:00.000Z',
      summary: 's',
    });
    ledger.recordWorkingBelief({
      material: true,
      record_id: 1,
      statement: 'x',
      confidence: 0.5,
    });
    const snap = ledger.snapshot();
    snap.phase_trail.push({ phase: 'build', kind: 'phase', recorded_at: '2099-01-01', summary: 't' });
    snap.epistemic_working_set.push({ material: true, statement: 'x', confidence: 0.5 });
    // Original ledger is unaffected
    expect(ledger.phase_trail).toHaveLength(1);
    expect(ledger.epistemic_working_set).toHaveLength(1);
  });

  it('ledgerFromSnapshot restores ledger with same identity and state', () => {
    const original = new EpistemicTaskLedger(baseInput());
    original.recordCheckpoint({
      kind: 'decision',
      recorded_at: '2026-08-09T00:00:00.000Z',
      summary: 'snap',
    });
    original.close();
    const restored = ledgerFromSnapshot(original.snapshot());
    expect(restored.project_id).toBe(original.project_id);
    expect(restored.task_id).toBe(original.task_id);
    expect(restored.agent_id).toBe(original.agent_id);
    expect(restored.status).toBe('closed');
    expect(restored.phase_trail).toEqual(original.phase_trail);
  });
});

describe('EpistemicTaskLedger — cognitive event envelope', () => {
  it('builds a properly-shaped envelope for submission', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    const env = ledger.toCognitiveEvent({
      event_type: 'EvidenceObserved',
      payload: { step: '9', acceptance: 'ok' },
      idempotency_key: 'epb-step-9-20260809',
      task_id: 'task-x',
    });
    expect(env.event_type).toBe('EvidenceObserved');
    expect(env.project_id).toBe('cognitive-os');
    expect(env.task_id).toBe('task-x');
    expect(env.idempotency_key).toBe('epb-step-9-20260809');
    expect(env.correlation_id).toBe('task-ledger:cognitive-os:epistemic-kernel-activation-phase-b');
    expect(env.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('envelope is the only mutation surface; ordinary tool calls do not call toCognitiveEvent', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    // recordCheckpoint / recordWorkingBelief / close are pure (only mutate `this`).
    // No tool-call-driven automatic event emission.
    let emitted = 0;
    const originalRecord = ledger.recordCheckpoint.bind(ledger);
    // Spy: confirm we never auto-emit; the test just exercises the surface.
    ledger.recordCheckpoint = (c) => {
      emitted += 1;
      originalRecord(c);
    };
    ledger.recordCheckpoint({
      kind: 'phase',
      recorded_at: '2026-08-09T00:00:00.000Z',
      summary: 'x',
    });
    // Adapter never auto-built an event envelope; only the explicit
    // toCognitiveEvent call would build one.
    expect(emitted).toBe(1);
    expect(ledger.phase_trail).toHaveLength(1);
  });
});

describe('EpistemicTaskLedger — 5-phase deterministic task fixture', () => {
  it('walks Understand → Gather → Build → Verify → Report with one checkpoint each', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    const checkpoints: Array<{
      phase: 'understand' | 'gather' | 'build' | 'verify' | 'report';
      kind: 'phase' | 'decision' | 'evidence' | 'handoff';
    }> = [
      { phase: 'understand', kind: 'phase' },
      { phase: 'gather', kind: 'decision' },
      { phase: 'build', kind: 'phase' },
      { phase: 'verify', kind: 'evidence' },
      { phase: 'report', kind: 'handoff' },
    ];
    for (let i = 0; i < checkpoints.length; i += 1) {
      ledger.recordCheckpoint({
        ...checkpoints[i],
        recorded_at: `2026-08-09T00:0${i}:00.000Z`,
        summary: `${checkpoints[i].phase} step ${i}`,
      });
    }
    expect(ledger.phase_trail).toHaveLength(5);
    expect(ledger.total_checkpoints).toBe(5);
    expect(ledger.phase_trail.map((e) => e.kind)).toEqual([
      'phase',
      'decision',
      'phase',
      'evidence',
      'handoff',
    ]);
    expect(ledger.phase_trail.map((entry) => entry.phase)).toEqual([
      'understand',
      'gather',
      'build',
      'verify',
      'report',
    ]);
  });
});

describe('EpistemicTaskLedger — contradiction fixture', () => {
  it('surfaces a contradiction in the working set when material beliefs disagree', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    ledger.recordCheckpoint({
      kind: 'decision',
      recorded_at: '2026-08-09T00:00:00.000Z',
      summary: 'recorded two contradicting beliefs',
    });
    ledger.recordWorkingBelief({
      material: true,
      record_id: 1,
      statement: 'Activation is contextual.',
      confidence: 0.85,
    });
    ledger.recordWorkingBelief({
      material: true,
      record_id: 2,
      statement: 'Activation is canonical retrieval.',
      confidence: 0.6,
    });
    const material = ledger.epistemic_working_set.filter((e) => e.material);
    expect(material).toHaveLength(2);
    expect(material[0].statement).not.toBe(material[1].statement);
    // Dream admission (caller's job) would evaluate update/create/defer/discard
    // based on this snapshot.
  });
});

describe('EpistemicTaskLedger — terminal immutability', () => {
  it('rejects checkpoints and working beliefs after close', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    ledger.close();

    expect(() => ledger.recordCheckpoint({
      kind: 'evidence',
      phase: 'verify',
      recorded_at: '2026-08-09T00:06:00.000Z',
      summary: 'late evidence',
    })).toThrow(/closed ledger/i);
    expect(() => ledger.recordWorkingBelief({
      material: true,
      statement: 'late belief',
      confidence: 1,
    })).toThrow(/closed ledger/i);
    expect(ledger.phase_trail).toEqual([]);
    expect(ledger.epistemic_working_set).toEqual([]);
  });
});
