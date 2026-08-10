import { describe, expect, it } from 'vitest';
import {
  isStableRepairReference,
  recordSelfCorrectRepair,
} from '../src/epistemic/self-correct-bridge.js';
import {
  EpistemicTaskLedger,
  type ActiveTurnShapePhase,
  type CreateLedgerInput,
} from '../src/epistemic/task-ledger.js';

function baseInput(overrides: Partial<CreateLedgerInput> = {}): CreateLedgerInput {
  return {
    project_id: 'cognitive-os',
    task_id: 'epistemic-kernel-activation-phase-b',
    session_id: 'self-correct-bridge-test-session',
    done_condition: 'A verified repair is recorded only when it changes verification.',
    intent: 'Exercise the recovery-only Task Ledger bridge.',
    ...overrides,
  };
}

function recordPhase(
  ledger: EpistemicTaskLedger,
  phase: ActiveTurnShapePhase,
  index: number,
): void {
  ledger.recordCheckpoint({
    kind: 'phase',
    phase,
    recorded_at: `2026-08-09T00:0${index}:00.000Z`,
    summary: `${phase} completed`,
  });
}

describe('self-correct-loop Task Ledger bridge', () => {
  it('records only a verified recovery in a deterministic five-phase task after build fails', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    recordPhase(ledger, 'understand', 0);
    recordPhase(ledger, 'gather', 1);

    // Build (step 3) fails deliberately. The caller passes failure context to
    // self-correct-loop; this bridge intentionally records none of that failure.
    const originalFailure = 'build acceptance failed: expected verifier fixture to pass';
    expect(originalFailure).toContain('build acceptance failed');
    expect(ledger.phase_trail).toHaveLength(2);

    // The caller simulates self-correct-loop recovery after re-verification.
    const result = recordSelfCorrectRepair(ledger, {
      verified: true,
      non_trivial: true,
      changes_verifier_path: true,
      phase: 'build',
      recorded_at: '2026-08-09T00:02:30.000Z',
      summary: 'recovery: replaced stale fixture setup and re-ran the build verifier',
      references: ['cognitive_event:repair-outcome-001', 'artifact:build-verifier-log-001'],
    });

    recordPhase(ledger, 'verify', 3);
    recordPhase(ledger, 'report', 4);

    expect(result).toMatchObject({ recorded: true, reason: 'recorded' });
    expect(ledger.phase_trail).toHaveLength(5);
    expect(ledger.phase_trail.map((entry) => entry.kind)).toEqual([
      'phase',
      'phase',
      'repair',
      'phase',
      'phase',
    ]);
    expect(ledger.phase_trail.map((entry) => entry.phase)).toEqual([
      'understand',
      'gather',
      'build',
      'verify',
      'report',
    ]);
    expect(ledger.phase_trail[2]).toMatchObject({
      kind: 'repair',
      summary: 'recovery: replaced stale fixture setup and re-ran the build verifier',
      references: ['cognitive_event:repair-outcome-001', 'artifact:build-verifier-log-001'],
    });
    expect(ledger.phase_trail.some((entry) => entry.summary === originalFailure)).toBe(false);
    expect(ledger.epistemic_working_set).toEqual([]);
  });

  it('does not append a checkpoint for a trivial repair and leaves the working set unchanged', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    ledger.recordWorkingBelief({
      material: true,
      statement: 'Existing material belief stays owned by the caller.',
      confidence: 0.8,
    });
    const workingSetBefore = ledger.snapshot().epistemic_working_set;

    const result = recordSelfCorrectRepair(ledger, {
      verified: true,
      non_trivial: false,
      changes_verifier_path: true,
      phase: 'build',
      recorded_at: '2026-08-09T00:03:00.000Z',
      summary: 'recovery: corrected one-character command typo',
      references: ['artifact:terminal-log-002'],
    });

    expect(result).toEqual({ recorded: false, reason: 'repair_trivial' });
    expect(ledger.phase_trail).toEqual([]);
    expect(ledger.epistemic_working_set).toEqual(workingSetBefore);
  });

  it('requires verified, verifier-path-changing repair outcomes with stable event or artifact references', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    const input = {
      verified: true,
      non_trivial: true,
      changes_verifier_path: true,
      phase: 'verify' as const,
      recorded_at: '2026-08-09T00:04:00.000Z',
      summary: 'recovery: repaired deterministic verifier setup',
      references: [],
    };

    expect(recordSelfCorrectRepair(ledger, input)).toEqual({
      recorded: false,
      reason: 'missing_stable_references',
    });
    expect(recordSelfCorrectRepair(ledger, {
      ...input,
      references: ['unstructured console output'],
    })).toEqual({ recorded: false, reason: 'missing_stable_references' });
    expect(recordSelfCorrectRepair(ledger, {
      ...input,
      verified: false,
      references: ['artifact:repair-proof-003'],
    })).toEqual({ recorded: false, reason: 'repair_not_verified' });
    expect(recordSelfCorrectRepair(ledger, {
      ...input,
      changes_verifier_path: false,
      references: ['artifact:repair-proof-003'],
    })).toEqual({ recorded: false, reason: 'verifier_path_unchanged' });
    expect(recordSelfCorrectRepair(ledger, {
      ...input,
      phase: 'complete',
      references: ['artifact:repair-proof-003'],
    } as unknown as Parameters<typeof recordSelfCorrectRepair>[1])).toEqual({
      recorded: false,
      reason: 'invalid_checkpoint',
    });
    expect(recordSelfCorrectRepair(ledger, {
      ...input,
      recorded_at: 'not-a-timestamp',
      references: ['artifact:repair-proof-003'],
    })).toEqual({ recorded: false, reason: 'invalid_checkpoint' });
    expect(recordSelfCorrectRepair(ledger, {
      ...input,
      summary: '   ',
      references: ['artifact:repair-proof-003'],
    })).toEqual({ recorded: false, reason: 'invalid_checkpoint' });
    expect(ledger.phase_trail).toEqual([]);
    expect(isStableRepairReference('cognitive_event:repair-outcome-003')).toBe(true);
    expect(isStableRepairReference('artifact:repair proof')).toBe(false);
  });

  it('refuses to mutate a closed ledger', () => {
    const ledger = new EpistemicTaskLedger(baseInput());
    ledger.close();

    expect(recordSelfCorrectRepair(ledger, {
      verified: true,
      non_trivial: true,
      changes_verifier_path: true,
      phase: 'verify',
      recorded_at: '2026-08-09T00:05:00.000Z',
      summary: 'recovery: repaired an invalid projection invariant',
      references: ['artifact:projection-repair-proof-004'],
    })).toEqual({ recorded: false, reason: 'ledger_closed' });
  });
});
