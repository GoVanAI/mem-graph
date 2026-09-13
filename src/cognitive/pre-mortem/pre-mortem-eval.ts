/**
 * Pre-mortem rubric evaluator.
 *
 * Implements the contract defined in
 * `cognitive-os/agent-practice/reasoning-gates.v1.json`. The output
 * status is one of `passed` | `flagged` | `approval_required` — never
 * `accepted_risk` or `waived` (per Sol H7: only authorized actors
 * emit those).
 *
 * This evaluator is intentionally separate from `agent-practice-eval.ts`
 * (Sol H4): it has its own rubric, scenario types, and weight normalization
 * so it does not interfere with the 100-point mem-graph compliance score.
 *
 * Critical checks (any failure forces `flagged`):
 *   - schema_version present and matches
 *   - non-empty expected_outcome and commitment_boundary
 *   - category coverage across PRE_MORTEM_REQUIRED_CATEGORIES
 *   - causal independence (no duplicate mechanisms, normalized)
 *   - mechanism specificity (no generic labels)
 *   - warning_check_status valid; evidence present when verified/refused
 *   - rollback_recovery present when applies_to demands it
 *   - accepted_risk waivers have authority_reference, no_additional_authority: true
 *   - residual status: open modes without mitigation or waiver flagged
 */

import {
  PRE_MORTEM_REQUIRED_CATEGORIES,
  PreMortemAcceptedRisk,
  PreMortemCheck,
  PreMortemFailureMode,
  PreMortemGrade,
  PreMortemRecord,
  PreMortemStatus,
  WarningCheckStatus,
} from './types.js';

const RUBRIC_VERSION = '1.0.0' as const;

const GENERIC_LABELS = [
  'bugs',
  'bug',
  'unexpected issues',
  'unexpected issue',
  'issues',
  'problems',
  'misc',
  'miscellaneous',
  'various',
  'things',
  'edge cases',
];

function makeCheck(
  id: string,
  passed: boolean,
  critical: boolean,
  weight: number,
  detail: string,
): PreMortemCheck {
  return { id, passed, critical, weight, detail };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMechanism(text: string): string {
  // Strip whitespace and lowercase to detect duplicate mechanisms.
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isValidWarningCheckStatus(value: unknown): value is WarningCheckStatus {
  return value === 'verified' || value === 'refused' || value === 'unverified';
}

function isValidDisposition(value: unknown): value is PreMortemFailureMode['disposition'] {
  return (
    value === 'open' ||
    value === 'mitigated' ||
    value === 'accepted_risk' ||
    value === 'blocked'
  );
}

/**
 * Defensive parser that returns the record (or null) and any structural
 * issues. Only schema-level issues (not object, wrong schema_version)
 * force early return; field-level issues are validated by the per-field
 * checks so they appear in `critical_failures` with their specific check id.
 */
function parseRecord(value: unknown): { record: PreMortemRecord | null; issues: string[] } {
  const issues: string[] = [];
  if (!isPlainObject(value)) {
    return { record: null, issues: ['record must be an object'] };
  }
  if (value.schema_version !== '1.0.0') {
    issues.push(
      `schema_version must be '1.0.0' (got ${JSON.stringify(value.schema_version)})`,
    );
    return { record: null, issues };
  }
  return { record: value as unknown as PreMortemRecord, issues: [] };
}

export function gradePreMortem(value: unknown): PreMortemGrade {
  const checks: PreMortemCheck[] = [];
  const { record, issues: parseIssues } = parseRecord(value);

  if (record === null) {
    for (const issue of parseIssues) {
      checks.push(makeCheck('pre_mortem.parse', false, true, 100, issue));
    }
    return {
      rubric_version: RUBRIC_VERSION,
      status: 'flagged',
      score: 0,
      passed: false,
      critical_failures: ['pre_mortem.parse'],
      checks,
    };
  }

  // 1. Non-empty expected_outcome and commitment_boundary
  checks.push(
    makeCheck(
      'pre_mortem.expected_outcome_present',
      isNonEmptyString(record.expected_outcome),
      true,
      5,
      record.expected_outcome
        ? 'expected_outcome present'
        : 'expected_outcome missing or empty',
    ),
  );
  checks.push(
    makeCheck(
      'pre_mortem.commitment_boundary_present',
      isNonEmptyString(record.commitment_boundary),
      true,
      5,
      record.commitment_boundary
        ? 'commitment_boundary present'
        : 'commitment_boundary missing or empty',
    ),
  );

  // 2. Category coverage across PRE_MORTEM_REQUIRED_CATEGORIES
  const seenCategories = new Set(record.failure_modes.map((m) => m.category));
  const missingCategories = PRE_MORTEM_REQUIRED_CATEGORIES.filter(
    (c) => !seenCategories.has(c),
  );
  checks.push(
    makeCheck(
      'pre_mortem.category_coverage',
      missingCategories.length === 0,
      true,
      15,
      missingCategories.length === 0
        ? 'all 8 categories covered'
        : `missing categories: ${missingCategories.join(', ')}`,
    ),
  );

  // 3. Causal independence — distinct mechanisms (normalized)
  const mechanisms = record.failure_modes.map((m) => m.mechanism);
  const normalized = mechanisms.map(normalizeMechanism);
  const duplicates = normalized.filter(
    (m, idx) => normalized.indexOf(m) !== idx,
  );
  const uniqueDuplicates = Array.from(new Set(duplicates));
  checks.push(
    makeCheck(
      'pre_mortem.causal_independence',
      uniqueDuplicates.length === 0,
      true,
      10,
      uniqueDuplicates.length === 0
        ? 'all failure modes are causally independent'
        : `duplicate mechanisms: ${uniqueDuplicates.map((d) => `"${d}"`).join(', ')}`,
    ),
  );

  // 4. Mechanism specificity — no generic labels
  const genericMechanisms = mechanisms.filter((m) =>
    GENERIC_LABELS.includes(m.trim().toLowerCase()),
  );
  checks.push(
    makeCheck(
      'pre_mortem.mechanism_specificity',
      genericMechanisms.length === 0,
      true,
      10,
      genericMechanisms.length === 0
        ? 'all mechanisms are specific'
        : `generic labels rejected: ${genericMechanisms.join(', ')}`,
    ),
  );

  // 5. Per-mode field validation
  let invalidStatusCount = 0;
  let missingEvidenceCount = 0;
  let invalidDispositionCount = 0;
  let missingMitigationCount = 0;
  const openModesWithoutMitigation: PreMortemFailureMode[] = [];

  for (const mode of record.failure_modes) {
    if (!isValidWarningCheckStatus(mode.warning_check_status)) {
      invalidStatusCount += 1;
    }
    if (
      mode.warning_check_status === 'verified' ||
      mode.warning_check_status === 'refused'
    ) {
      if (!isNonEmptyString(mode.warning_check_evidence)) {
        missingEvidenceCount += 1;
      }
    }
    if (!isValidDisposition(mode.disposition)) {
      invalidDispositionCount += 1;
    }
    if (!isNonEmptyString(mode.mitigation)) {
      missingMitigationCount += 1;
    }
    if (mode.disposition === 'open' && !isNonEmptyString(mode.mitigation)) {
      openModesWithoutMitigation.push(mode);
    }
  }

  checks.push(
    makeCheck(
      'pre_mortem.warning_check_status_valid',
      invalidStatusCount === 0,
      true,
      8,
      invalidStatusCount === 0
        ? 'all warning_check_status values valid'
        : `${invalidStatusCount} modes have invalid warning_check_status`,
    ),
  );
  checks.push(
    makeCheck(
      'pre_mortem.warning_check_evidence_present',
      missingEvidenceCount === 0,
      true,
      8,
      missingEvidenceCount === 0
        ? 'warning check evidence present where required'
        : `${missingEvidenceCount} modes missing evidence for verified/refused checks`,
    ),
  );
  checks.push(
    makeCheck(
      'pre_mortem.disposition_valid',
      invalidDispositionCount === 0,
      true,
      5,
      invalidDispositionCount === 0
        ? 'all dispositions valid'
        : `${invalidDispositionCount} modes have invalid disposition`,
    ),
  );
  checks.push(
    makeCheck(
      'pre_mortem.mitigation_present',
      missingMitigationCount === 0,
      true,
      8,
      missingMitigationCount === 0
        ? 'all modes have mitigations'
        : `${missingMitigationCount} modes missing mitigation`,
    ),
  );

  // 6. Rollback required for irreversible / persistent-state commitments
  const requiresRollback = record.applies_to.some((a) =>
    ['irreversible_action', 'persistent_state_change'].includes(a),
  );
  let missingRollbackCount = 0;
  if (requiresRollback) {
    for (const mode of record.failure_modes) {
      if (!isNonEmptyString(mode.rollback_recovery)) {
        missingRollbackCount += 1;
      }
    }
  }
  checks.push(
    makeCheck(
      'pre_mortem.rollback_for_irreversible',
      !requiresRollback || missingRollbackCount === 0,
      true,
      10,
      !requiresRollback
        ? 'no rollback requirement for this commitment type'
        : missingRollbackCount === 0
          ? 'all modes have rollback recovery'
          : `${missingRollbackCount} modes missing rollback recovery`,
    ),
  );

  // 7. accepted_risk waivers — every mode with disposition=accepted_risk
  // must have a matching waiver with authority_reference + no_additional_authority: true.
  // Orphan waivers (covering modes with a different disposition or unknown modes)
  // are also reported.
  const waiverIssues: string[] = [];

  // Build a lookup of waivers by normalized mechanism.
  const waiversByMechanism = new Map<string, PreMortemAcceptedRisk>();
  for (const waiver of record.accepted_risks) {
    if (isNonEmptyString(waiver.affected_mode_mechanism)) {
      waiversByMechanism.set(normalizeMechanism(waiver.affected_mode_mechanism), waiver);
    }
  }

  // Validate each mode with accepted_risk disposition.
  const acceptedRiskModes = record.failure_modes.filter((m) => m.disposition === 'accepted_risk');
  for (const mode of acceptedRiskModes) {
    const waiver = waiversByMechanism.get(normalizeMechanism(mode.mechanism));
    if (!waiver) {
      waiverIssues.push(`mode "${mode.mechanism}" has accepted_risk disposition but no matching waiver`);
      continue;
    }
    if (!isNonEmptyString(waiver.authority_reference)) {
      waiverIssues.push(`waiver for "${mode.mechanism}" missing authority_reference`);
    }
    if (waiver.no_additional_authority !== true) {
      waiverIssues.push(
        `waiver for "${mode.mechanism}" does not have no_additional_authority: true`,
      );
    }
    for (const field of [
      'risk_owner',
      'scope',
      'review_or_expiry',
      'reason',
    ] as const) {
      if (!isNonEmptyString(waiver[field])) {
        waiverIssues.push(`waiver for "${mode.mechanism}" missing required field: ${field}`);
      }
    }
  }

  // Orphan-waiver checks: every waiver must reference an actual mode with accepted_risk disposition.
  for (const waiver of record.accepted_risks) {
    if (!isNonEmptyString(waiver.affected_mode_mechanism)) {
      waiverIssues.push('waiver missing affected_mode_mechanism');
      continue;
    }
    const coveredMode = record.failure_modes.find(
      (m) => normalizeMechanism(m.mechanism) === normalizeMechanism(waiver.affected_mode_mechanism),
    );
    if (!coveredMode) {
      waiverIssues.push(
        `waiver for "${waiver.affected_mode_mechanism}" references a failure mode not present in the record`,
      );
    } else if (coveredMode.disposition !== 'accepted_risk') {
      waiverIssues.push(
        `waiver for "${waiver.affected_mode_mechanism}" exists but mode disposition is ${coveredMode.disposition}, not accepted_risk`,
      );
    }
  }

  checks.push(
    makeCheck(
      'pre_mortem.accepted_risk_authority',
      waiverIssues.length === 0,
      true,
      10,
      waiverIssues.length === 0
        ? 'all waivers have valid authority reference'
        : `waiver issues: ${waiverIssues.join('; ')}`,
    ),
  );

  // 8. Residual status — modes with disposition 'open' must have mitigation
  checks.push(
    makeCheck(
      'pre_mortem.open_modes_have_mitigation',
      openModesWithoutMitigation.length === 0,
      false,
      5,
      openModesWithoutMitigation.length === 0
        ? 'no unmitigated open modes'
        : `${openModesWithoutMitigation.length} open modes lack mitigation`,
    ),
  );

  // Compute status. Critical failures → flagged. If the ONLY critical
  // failure is the waiver-authority check AND at least one mode has
  // disposition=accepted_risk, the skill emits `approval_required` —
  // the operator is being asked to authorize.
  const criticalFailures = checks.filter((c) => c.critical && !c.passed).map((c) => c.id);
  const hasModesRequestingWaiver = record.failure_modes.some(
    (m) => m.disposition === 'accepted_risk',
  );
  const onlyWaiverFailure =
    criticalFailures.length > 0 &&
    criticalFailures.every((id) => id === 'pre_mortem.accepted_risk_authority');

  let status: PreMortemStatus;
  if (onlyWaiverFailure && hasModesRequestingWaiver) {
    status = 'approval_required';
  } else if (criticalFailures.length > 0) {
    status = 'flagged';
  } else {
    status = 'passed';
  }

  // Score: simple weighted average of passed checks; informational only.
  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const passedWeight = checks
    .filter((c) => c.passed)
    .reduce((sum, c) => sum + c.weight, 0);
  const score = totalWeight === 0 ? 0 : Math.round((passedWeight / totalWeight) * 100);

  return {
    rubric_version: RUBRIC_VERSION,
    status,
    score,
    passed: status === 'passed',
    critical_failures: criticalFailures,
    checks,
  };
}
