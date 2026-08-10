import { describe, expect, it } from 'vitest';
import { createDreamAdmissionEnvelope } from '../src/epistemic/dream-bridge.js';
import { recordSelfCorrectRepair } from '../src/epistemic/self-correct-bridge.js';
import { EpistemicTaskLedger } from '../src/epistemic/task-ledger.js';

describe('Phase B Step 9 bridge composition', () => {
  it('carries scoped repair evidence into Dream without promoting or admitting it', () => {
    const ledger = new EpistemicTaskLedger({
      project_id: 'cognitive-os',
      task_id: 'step-9-composition',
      session_id: 'step-9-composition-session',
      done_condition: 'The repaired task closes with a pure Dream envelope.',
      intent: 'Prove the self-correct and Dream boundaries compose.',
    });

    ledger.recordCheckpoint({
      phase: 'understand',
      kind: 'phase',
      recorded_at: '2026-08-09T00:00:00.000Z',
      summary: 'scope and oracle fixed',
    });
    ledger.recordCheckpoint({
      phase: 'gather',
      kind: 'phase',
      recorded_at: '2026-08-09T00:01:00.000Z',
      summary: 'source evidence gathered',
    });

    const repair = recordSelfCorrectRepair(ledger, {
      verified: true,
      non_trivial: true,
      changes_verifier_path: true,
      phase: 'build',
      recorded_at: '2026-08-09T00:02:00.000Z',
      summary: 'recovery: replaced the stale fixture and reran the build oracle',
      references: ['cognitive_event:repair-outcome-step-9'],
    });

    ledger.recordWorkingBelief({
      material: true,
      statement: 'The stale fixture pattern may affect later analogous work.',
      confidence: 0.8,
    });
    ledger.recordWorkingBelief({
      material: false,
      statement: 'The first local command included a typo.',
      confidence: 1,
    });
    ledger.recordCheckpoint({
      phase: 'verify',
      kind: 'evidence',
      recorded_at: '2026-08-09T00:03:00.000Z',
      summary: 'the unchanged oracle passed',
    });
    ledger.recordCheckpoint({
      phase: 'report',
      kind: 'handoff',
      recorded_at: '2026-08-09T00:04:00.000Z',
      summary: 'terminal handoff prepared',
    });
    ledger.close();

    const envelope = createDreamAdmissionEnvelope(ledger.snapshot());

    expect(repair).toMatchObject({ recorded: true, reason: 'recorded' });
    expect(envelope.source).toBe('task-ledger');
    expect(envelope.phase_trail.map((entry) => entry.phase)).toEqual([
      'understand',
      'gather',
      'build',
      'verify',
      'report',
    ]);
    expect(envelope.phase_trail.filter((entry) => entry.kind === 'repair')).toHaveLength(1);
    expect(envelope.working_set).toHaveLength(1);
    expect(envelope.working_set[0].statement).toContain('stale fixture pattern');
    expect(envelope.working_set.some((entry) => entry.statement.includes('recovery:'))).toBe(false);
    expect(envelope).not.toHaveProperty('disposition');
  });
});
