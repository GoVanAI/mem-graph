/**
 * Pre-mortem validator types — dedicated rubric for the pre-commit failure
 * analysis gate defined in `cognitive-os/agent-practice/reasoning-gates.v1.json`.
 *
 * Per the Sol review corrections record (Sol review corrections, H4): this rubric is intentionally
 * separate from `agent-practice-eval.ts`. Bolting pre-mortem checks onto
 * the 100-point mem-graph compliance evaluator would invalidate its rubric.
 *
 * The pre-mortem validator implements the contract clauses:
 *   - category coverage (per applies_to categories)
 *   - causal independence (distinct mechanisms)
 *   - warning check status + evidence required when verified or refused
 *   - rollback required when commitment is irreversible or persistent-state
 *   - accepted_risk requires authority_reference (operator/system event)
 *   - waiver completeness + no_additional_authority: true
 *
 * Status semantics (per Sol H7/H9):
 *   - `passed` proves coverage only; grants no task authority
 *   - `flagged` indicates coverage incomplete or material risk unmitigated
 *   - `approval_required` indicates waiver requested but authority reference missing
 * The validator never emits `accepted_risk` or `waived` — those come from
 * authorized actors via the memory-admission gate.
 */

export type PreMortemCategory =
  | 'requirement'
  | 'evidence'
  | 'plan'
  | 'implementation'
  | 'verification'
  | 'operational'
  | 'security'
  | 'human';

export const PRE_MORTEM_CATEGORIES: readonly PreMortemCategory[] = [
  'requirement',
  'evidence',
  'plan',
  'implementation',
  'verification',
  'operational',
  'security',
  'human',
] as const;

export type WarningCheckStatus = 'verified' | 'refused' | 'unverified';

export type PreMortemAppliesTo =
  | 'irreversible_action'
  | 'implementation_commitment'
  | 'persistent_state_change'
  | 'public_or_expensive_change'
  | 'security_privacy_safety_sensitive'
  | 'difficult_to_verify';

export const PRE_MORTEM_APPLIES_TO: readonly PreMortemAppliesTo[] = [
  'irreversible_action',
  'implementation_commitment',
  'persistent_state_change',
  'public_or_expensive_change',
  'security_privacy_safety_sensitive',
  'difficult_to_verify',
] as const;

// Categories required for non-trivial work. Categories without a recorded
// mode fail the validator unless the commitment is explicitly trivial.
export const PRE_MORTEM_REQUIRED_CATEGORIES: readonly PreMortemCategory[] = [
  ...PRE_MORTEM_CATEGORIES,
];

export interface PreMortemFailureMode {
  /** Stable id within the record (e.g., "FM-1"). */
  id: string;
  category: PreMortemCategory;
  /** Specific mechanism; generic labels like "bugs" are rejected. */
  mechanism: string;
  preconditions?: string;
  affected_criterion?: string;
  earliest_warning?: string;
  warning_check_status: WarningCheckStatus;
  /** Required when warning_check_status is verified or refused. */
  warning_check_evidence?: string;
  detection_oracle?: string;
  prevention?: string;
  mitigation?: string;
  /** Required when applies_to includes irreversible_action or persistent_state_change. */
  rollback_recovery?: string;
  owner?: string;
  residual_risk?: string;
  disposition: 'open' | 'mitigated' | 'accepted_risk' | 'blocked';
}

/**
 * Waiver record emitted by an authorized actor (operator or system), NOT
 * by the pre-mortem skill. Reference: cognitive event with type
 * DecisionMade (operator) or system authorization event.
 */
export interface PreMortemAcceptedRisk {
  authority_reference: string;
  risk_owner: string;
  scope: string;
  review_or_expiry: string;
  /** Must be exactly true; waivers never grant additional authority. */
  no_additional_authority: true;
  reason: string;
  /** Mechanism of the failure mode this waiver covers. */
  affected_mode_mechanism: string;
}

export interface PreMortemRecord {
  schema_version: '1.0.0';
  expected_outcome: string;
  commitment_boundary: string;
  applies_to: PreMortemAppliesTo[];
  failure_modes: PreMortemFailureMode[];
  /** Operator-decided; the validator never emits these. */
  accepted_risks: PreMortemAcceptedRisk[];
}

export type PreMortemStatus = 'passed' | 'flagged' | 'approval_required';

export interface PreMortemCheck {
  id: string;
  passed: boolean;
  /** If true, a failure here forces status to 'flagged' regardless of score. */
  critical: boolean;
  weight: number;
  detail: string;
}

export interface PreMortemGrade {
  rubric_version: '1.0.0';
  /** Skill-emitted status; never 'accepted_risk' or 'waived' (per Sol H7). */
  status: PreMortemStatus;
  /** 0..100; informational; passed requires status === 'passed'. */
  score: number;
  passed: boolean;
  critical_failures: string[];
  checks: PreMortemCheck[];
}
