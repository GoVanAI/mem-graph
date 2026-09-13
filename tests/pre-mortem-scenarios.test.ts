/**
 * End-to-end synthetic scenarios for the pre-mortem rubric validator.
 *
 * Builds complete `PreMortemRecord` instances from realistic use cases and
 * asserts the expected status outcome for each. Per the Item 6
 * implementation plan §"Synthetic integration tests":
 *
 *   - reversible novel plan → `passed`
 *   - irreversible migration missing rollback → `flagged`
 *   - plan with authorized waiver → `approval_required` (per Sol H7: the
 *     skill NEVER emits `accepted_risk`; an authorized actor would record
 *     that through the memory-admission gate)
 *   - trivial read-only task → skill does NOT fire (validator accepts
 *     because no trigger conditions apply; the gate is upstream in
 *     turn-shape)
 */
import { describe, it, expect } from 'vitest';
import { gradePreMortem } from '../src/cognitive/pre-mortem/pre-mortem-eval.js';
import type {
  PreMortemCategory,
  PreMortemFailureMode,
  PreMortemRecord,
} from '../src/cognitive/pre-mortem/types.js';

const ALL_CATEGORIES: readonly PreMortemCategory[] = [
  'requirement',
  'evidence',
  'plan',
  'implementation',
  'verification',
  'operational',
  'security',
  'human',
];

function mode(
  category: PreMortemCategory,
  mechanism: string,
  extra: Partial<PreMortemFailureMode> = {},
): PreMortemFailureMode {
  return {
    id: `FM-${category}`,
    category,
    mechanism,
    warning_check_status: 'verified',
    warning_check_evidence: `${category} verification observed`,
    mitigation: `${category} mitigation in place`,
    rollback_recovery: category === 'security' || category === 'operational'
      ? undefined
      : 'snapshot then revert',
    disposition: 'mitigated',
    ...extra,
  };
}

describe('pre-mortem scenario — reversible novel plan → passed', () => {
  it('produces passed status for a reversible implementation plan with full coverage', () => {
    const record: PreMortemRecord = {
      schema_version: '1.0.0',
      expected_outcome: 'feature ships behind flag within the iteration window',
      commitment_boundary: 'merge feature branch behind env flag',
      applies_to: ['implementation_commitment'],
      failure_modes: ALL_CATEGORIES.map((category, idx) =>
        mode(category, `${category} failure mode specific to feature flag rollout ${idx + 1}`),
      ),
      accepted_risks: [],
    };
    const grade = gradePreMortem(record);
    expect(grade.status).toBe('passed');
    expect(grade.passed).toBe(true);
    expect(grade.critical_failures).toEqual([]);
  });
});

describe('pre-mortem scenario — irreversible migration missing rollback → flagged', () => {
  it('flags an irreversible schema migration that lacks rollback recovery', () => {
    const record: PreMortemRecord = {
      schema_version: '1.0.0',
      expected_outcome: 'production schema migration completes',
      commitment_boundary: 'apply schema migration to production database',
      applies_to: ['irreversible_action', 'persistent_state_change'],
      failure_modes: ALL_CATEGORIES.map((category) =>
        // Intentionally omit rollback_recovery for the operational mode
        mode(category, `${category} migration failure mode`, {
          rollback_recovery:
            category === 'operational' ? undefined : 'snapshot then revert',
        }),
      ),
      accepted_risks: [],
    };
    const grade = gradePreMortem(record);
    expect(grade.status).toBe('flagged');
    expect(grade.passed).toBe(false);
    expect(grade.critical_failures).toContain('pre_mortem.rollback_for_irreversible');
  });
});

describe('pre-mortem scenario — waiver requested but lacking authority → approval_required', () => {
  it('emits approval_required when a mode has accepted_risk disposition but no waiver', () => {
    const record: PreMortemRecord = {
      schema_version: '1.0.0',
      expected_outcome: 'ship despite known caveat in operator availability',
      commitment_boundary: 'deploy during business hours',
      applies_to: ['public_or_expensive_change'],
      failure_modes: ALL_CATEGORIES.map((category) =>
        mode(category, `${category} failure mode specific to off-hours deploy`, {
          // Only the "human" mode carries the accepted_risk disposition.
          // No matching waiver is provided — the validator requests
          // approval rather than fabricating an accepted_risk.
          disposition: category === 'human' ? 'accepted_risk' : 'mitigated',
        }),
      ),
      accepted_risks: [], // no waiver
    };
    const grade = gradePreMortem(record);
    expect(grade.status).toBe('approval_required');
    expect(grade.critical_failures).toContain('pre_mortem.accepted_risk_authority');
    expect(grade.critical_failures).not.toContain('pre_mortem.category_coverage');
    // Sol H7: validator must never emit accepted_risk or waived
    expect(grade.status).not.toBe('accepted_risk');
    expect(grade.status).not.toBe('waived');
  });

  it('passes when the accepted_risk disposition has a complete waiver with authority reference', () => {
    const record: PreMortemRecord = {
      schema_version: '1.0.0',
      expected_outcome: 'ship despite known caveat in operator availability',
      commitment_boundary: 'deploy during business hours',
      applies_to: ['public_or_expensive_change'],
      failure_modes: ALL_CATEGORIES.map((category, idx) =>
        mode(category, `${category} failure mode specific to off-hours deploy ${idx}`, {
          disposition: category === 'human' ? 'accepted_risk' : 'mitigated',
        }),
      ),
      accepted_risks: [
        {
          authority_reference: 'operator_decision_event_12345',
          risk_owner: 'operator',
          scope: 'this deployment only',
          review_or_expiry: '2026-09-01',
          no_additional_authority: true,
          reason: 'acceptable trade-off given business-hour schedule',
          affected_mode_mechanism:
            'human failure mode specific to off-hours deploy 7',
        },
      ],
    };
    const grade = gradePreMortem(record);
    expect(grade.status).toBe('passed');
    expect(grade.critical_failures).toEqual([]);
  });
});

describe('pre-mortem scenario — trivial read-only task → skill does NOT fire', () => {
  it('flags a record that the upstream gate should have skipped', () => {
    // Per the SKILL.md §2 "When to use" and turn-shape §4 Risk Trigger:
    // the pre-mortem skill should not be invoked for trivial read-only
    // work because no trigger condition applies. If a record IS
    // presented to the validator anyway, full category coverage is
    // still required — the validator will flag the record, which is
    // the correct signal that the upstream gate should have skipped it.
    const record: PreMortemRecord = {
      schema_version: '1.0.0',
      expected_outcome: 'read documentation page',
      commitment_boundary: 'no state change',
      applies_to: ['difficult_to_verify'],
      failure_modes: [
        mode('evidence', 'page content is outdated', {
          mitigation: 'verify against source',
          rollback_recovery: 'no rollback needed (read-only)',
        }),
      ],
      accepted_risks: [],
    };
    const grade = gradePreMortem(record);
    // The validator flags because category coverage is insufficient —
    // this is the correct response when the skill is invoked
    // inappropriately on trivial work.
    expect(grade.status).toBe('flagged');
    expect(grade.critical_failures).toContain('pre_mortem.category_coverage');
    // The correct upstream behavior: turn-shape §4 should not have
    // delegated to pre-mortem for this trivial task.
  });
});

describe('pre-mortem scenario — multi-mode causal independence', () => {
  it('flags when two modes share the same normalized mechanism despite different categories', () => {
    const record: PreMortemRecord = {
      schema_version: '1.0.0',
      expected_outcome: 'deploy with full coverage',
      commitment_boundary: 'apply migration to production',
      applies_to: ['irreversible_action', 'persistent_state_change'],
      failure_modes: [
        mode('requirement', 'rollback procedure missing'),
        mode('evidence', 'rollback procedure missing'),
      ],
      accepted_risks: [],
    };
    const grade = gradePreMortem(record);
    expect(grade.critical_failures).toContain('pre_mortem.causal_independence');
    expect(grade.status).toBe('flagged');
  });
});
