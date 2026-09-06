/**
 * Tests for the pre-mortem rubric evaluator.
 *
 * Verifies each clause of `reasoning-gates.v1.json` is enforced and that
 * the validator never emits `accepted_risk` or `waived` (per Sol H7).
 */
import { describe, it, expect } from 'vitest';
import { gradePreMortem } from '../src/cognitive/pre-mortem/pre-mortem-eval.js';
import type {
  PreMortemAcceptedRisk,
  PreMortemFailureMode,
  PreMortemRecord,
} from '../src/cognitive/pre-mortem/types.js';

const ALL_CATEGORIES = [
  'requirement',
  'evidence',
  'plan',
  'implementation',
  'verification',
  'operational',
  'security',
  'human',
] as const;

function makeMode(
  partial: Partial<PreMortemFailureMode> & {
    mechanism: string;
    category: (typeof ALL_CATEGORIES)[number];
  },
): PreMortemFailureMode {
  return {
    id: partial.id ?? `FM-${Math.random().toString(36).slice(2, 8)}`,
    warning_check_status: partial.warning_check_status ?? 'verified',
    warning_check_evidence: partial.warning_check_evidence ?? 'observed during smoke test',
    mitigation: partial.mitigation ?? 'add a guard',
    rollback_recovery: partial.rollback_recovery,
    disposition: partial.disposition ?? 'mitigated',
    ...partial,
  };
}

function buildRecord(overrides: Partial<PreMortemRecord> = {}): PreMortemRecord {
  const modes = ALL_CATEGORIES.map((category, idx) =>
    makeMode({
      id: `FM-${idx + 1}`,
      mechanism: `${category}-specific failure mode ${idx + 1}`,
      category,
      rollback_recovery: 'snapshot then revert',
    }),
  );
  return {
    schema_version: '1.0.0',
    expected_outcome: 'irreversible migration completes within window',
    commitment_boundary: 'apply schema migration to production database',
    applies_to: ['irreversible_action', 'persistent_state_change'],
    failure_modes: modes,
    accepted_risks: [],
    ...overrides,
  };
}

describe('pre-mortem evaluator — happy path', () => {
  it('passes a fully-populated record with category coverage and rollback', () => {
    const record = buildRecord();
    const grade = gradePreMortem(record);
    expect(grade.rubric_version).toBe('1.0.0');
    expect(grade.status).toBe('passed');
    expect(grade.passed).toBe(true);
    expect(grade.critical_failures).toEqual([]);
    expect(grade.score).toBeGreaterThanOrEqual(95);
  });
});

describe('pre-mortem evaluator — structural failures', () => {
  it('flags when input is not an object', () => {
    const grade = gradePreMortem('not a record');
    expect(grade.status).toBe('flagged');
    expect(grade.passed).toBe(false);
    expect(grade.critical_failures).toContain('pre_mortem.parse');
  });

  it('flags when schema_version is wrong', () => {
    const grade = gradePreMortem(buildRecord({ schema_version: '0.3' as '1.0.0' }));
    expect(grade.status).toBe('flagged');
    expect(grade.critical_failures).toContain('pre_mortem.parse');
  });

  it('flags when expected_outcome is missing', () => {
    const grade = gradePreMortem(buildRecord({ expected_outcome: '' }));
    expect(grade.critical_failures).toContain('pre_mortem.expected_outcome_present');
    expect(grade.status).toBe('flagged');
  });

  it('flags when commitment_boundary is missing', () => {
    const grade = gradePreMortem(buildRecord({ commitment_boundary: '   ' }));
    expect(grade.critical_failures).toContain('pre_mortem.commitment_boundary_present');
    expect(grade.status).toBe('flagged');
  });
});

describe('pre-mortem evaluator — coverage failures', () => {
  it('flags when a category is missing', () => {
    const record = buildRecord();
    record.failure_modes = record.failure_modes.filter((m) => m.category !== 'human');
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.category_coverage');
    expect(grade.status).toBe('flagged');
  });

  it('flags when multiple categories are missing', () => {
    const record = buildRecord();
    record.failure_modes = record.failure_modes.filter(
      (m) => m.category !== 'human' && m.category !== 'security',
    );
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.category_coverage');
  });
});

describe('pre-mortem evaluator — causal independence', () => {
  it('flags when two modes share a normalized mechanism', () => {
    const record = buildRecord();
    record.failure_modes[0].mechanism = 'DUPLICATE FAILURE MECHANISM';
    record.failure_modes[1].mechanism = 'duplicate failure mechanism';
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.causal_independence');
    expect(grade.status).toBe('flagged');
  });

  it('accepts mechanisms that differ only in case if they are distinct words', () => {
    const record = buildRecord();
    record.failure_modes[0].mechanism = 'rollback failure mid-migration';
    record.failure_modes[1].mechanism = 'rollback failure post-migration';
    // Different after normalization (mid vs post), so distinct.
    const grade = gradePreMortem(record);
    // Will still fail category coverage if those two share a category; here they don't.
    // Actually our buildRecord has unique categories per mode, so this is fine.
    expect(grade.critical_failures).not.toContain('pre_mortem.causal_independence');
  });
});

describe('pre-mortem evaluator — mechanism specificity', () => {
  it('flags generic labels like "bugs"', () => {
    const record = buildRecord();
    record.failure_modes[0].mechanism = 'bugs';
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.mechanism_specificity');
    expect(grade.status).toBe('flagged');
  });

  it('flags generic labels like "unexpected issues"', () => {
    const record = buildRecord();
    record.failure_modes[0].mechanism = 'unexpected issues';
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.mechanism_specificity');
  });
});

describe('pre-mortem evaluator — warning check status', () => {
  it('flags when warning_check_status is invalid', () => {
    const record = buildRecord();
    record.failure_modes[0].warning_check_status = 'unknown' as 'verified';
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.warning_check_status_valid');
  });

  it('flags when verified status lacks evidence', () => {
    const record = buildRecord();
    record.failure_modes[0].warning_check_status = 'verified';
    record.failure_modes[0].warning_check_evidence = undefined;
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.warning_check_evidence_present');
  });

  it('flags when refused status lacks evidence', () => {
    const record = buildRecord();
    record.failure_modes[0].warning_check_status = 'refused';
    record.failure_modes[0].warning_check_evidence = undefined;
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.warning_check_evidence_present');
  });

  it('allows unverified status without evidence (per contract: required only when verified or refused)', () => {
    const record = buildRecord();
    record.failure_modes[0].warning_check_status = 'unverified';
    record.failure_modes[0].warning_check_evidence = undefined;
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).not.toContain('pre_mortem.warning_check_evidence_present');
  });
});

describe('pre-mortem evaluator — rollback requirement', () => {
  it('flags when irreversible commitment lacks rollback recovery', () => {
    const record = buildRecord({ applies_to: ['irreversible_action'] });
    for (const mode of record.failure_modes) {
      mode.rollback_recovery = undefined;
    }
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.rollback_for_irreversible');
  });

  it('does not require rollback for non-irreversible commitments', () => {
    const record = buildRecord({ applies_to: ['implementation_commitment'] });
    for (const mode of record.failure_modes) {
      mode.rollback_recovery = undefined;
    }
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).not.toContain('pre_mortem.rollback_for_irreversible');
  });
});

describe('pre-mortem evaluator — waiver (accepted_risk) authority', () => {
  it('passes with a complete waiver when mode disposition is accepted_risk', () => {
    const record = buildRecord();
    const target = record.failure_modes[0];
    target.disposition = 'accepted_risk';
    const waiver: PreMortemAcceptedRisk = {
      authority_reference: 'operator_decision_event_12345',
      risk_owner: 'operator',
      scope: 'this migration only',
      review_or_expiry: '2026-09-01',
      no_additional_authority: true,
      reason: 'acceptable for non-critical workload',
      affected_mode_mechanism: target.mechanism,
    };
    record.accepted_risks = [waiver];
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).not.toContain('pre_mortem.accepted_risk_authority');
  });

  it('flags when accepted_risk disposition lacks matching waiver', () => {
    const record = buildRecord();
    record.failure_modes[0].disposition = 'accepted_risk';
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.accepted_risk_authority');
  });

  it('flags when waiver is missing authority_reference', () => {
    const record = buildRecord();
    record.failure_modes[0].disposition = 'accepted_risk';
    const waiver: PreMortemAcceptedRisk = {
      authority_reference: '',
      risk_owner: 'operator',
      scope: 'this migration only',
      review_or_expiry: '2026-09-01',
      no_additional_authority: true,
      reason: 'acceptable',
      affected_mode_mechanism: record.failure_modes[0].mechanism,
    };
    record.accepted_risks = [waiver];
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.accepted_risk_authority');
  });

  it('flags when waiver has no_additional_authority: false', () => {
    const record = buildRecord();
    record.failure_modes[0].disposition = 'accepted_risk';
    const waiver = {
      authority_reference: 'operator_decision_event_12345',
      risk_owner: 'operator',
      scope: 'this migration only',
      review_or_expiry: '2026-09-01',
      no_additional_authority: false as const,
      reason: 'acceptable',
      affected_mode_mechanism: record.failure_modes[0].mechanism,
    } as unknown as PreMortemAcceptedRisk;
    record.accepted_risks = [waiver];
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.accepted_risk_authority');
  });

  it('flags when waiver references a mode not in the record', () => {
    const record = buildRecord();
    record.failure_modes[0].disposition = 'accepted_risk';
    const waiver: PreMortemAcceptedRisk = {
      authority_reference: 'operator_decision_event_12345',
      risk_owner: 'operator',
      scope: 'this migration only',
      review_or_expiry: '2026-09-01',
      no_additional_authority: true,
      reason: 'acceptable',
      affected_mode_mechanism: 'nonexistent mechanism',
    };
    record.accepted_risks = [waiver];
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.accepted_risk_authority');
  });

  it('flags when waiver exists but mode disposition is not accepted_risk', () => {
    const record = buildRecord();
    record.failure_modes[0].disposition = 'mitigated';
    const waiver: PreMortemAcceptedRisk = {
      authority_reference: 'operator_decision_event_12345',
      risk_owner: 'operator',
      scope: 'this migration only',
      review_or_expiry: '2026-09-01',
      no_additional_authority: true,
      reason: 'acceptable',
      affected_mode_mechanism: record.failure_modes[0].mechanism,
    };
    record.accepted_risks = [waiver];
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.accepted_risk_authority');
  });
});

describe('pre-mortem evaluator — status emission contract', () => {
  it('never emits accepted_risk (only authorized actors do)', () => {
    const record = buildRecord();
    record.accepted_risks = [
      {
        authority_reference: 'operator_decision_event_12345',
        risk_owner: 'operator',
        scope: 'this migration only',
        review_or_expiry: '2026-09-01',
        no_additional_authority: true,
        reason: 'acceptable',
        affected_mode_mechanism: record.failure_modes[0].mechanism,
      },
    ];
    record.failure_modes[0].disposition = 'accepted_risk';
    const grade = gradePreMortem(record);
    expect(['passed', 'flagged', 'approval_required']).toContain(grade.status);
    expect(grade.status).not.toBe('accepted_risk');
  });

  it('never emits waived (only authorized actors do)', () => {
    const record = buildRecord();
    const grade = gradePreMortem(record);
    expect(grade.status).not.toBe('waived');
  });

  it('emits approval_required when accepted_risk disposition lacks authority reference', () => {
    const record = buildRecord();
    record.failure_modes[0].disposition = 'accepted_risk';
    // No waiver provided → waiver validation fails
    const grade = gradePreMortem(record);
    expect(grade.status).toBe('approval_required');
  });
});

describe('pre-mortem evaluator — open modes without mitigation', () => {
  it('reports (non-critical) warning for open modes lacking mitigation', () => {
    const record = buildRecord();
    record.failure_modes[0].disposition = 'open';
    record.failure_modes[0].mitigation = '';
    const grade = gradePreMortem(record);
    // Non-critical check still records the issue
    expect(grade.checks.find((c) => c.id === 'pre_mortem.open_modes_have_mitigation')?.passed).toBe(false);
    // But the overall status remains flagged (mitigation_present critical check should also fail)
    expect(grade.status).toBe('flagged');
  });
});

describe('pre-mortem evaluator — score', () => {
  it('computes a 0-100 weighted score', () => {
    const record = buildRecord();
    const grade = gradePreMortem(record);
    expect(grade.score).toBeGreaterThanOrEqual(0);
    expect(grade.score).toBeLessThanOrEqual(100);
  });

  it('score reflects failures (lower when more checks fail)', () => {
    const perfect = gradePreMortem(buildRecord());
    const imperfectRecord = buildRecord();
    imperfectRecord.failure_modes[0].mitigation = '';
    const imperfect = gradePreMortem(imperfectRecord);
    expect(imperfect.score).toBeLessThan(perfect.score);
  });
});
