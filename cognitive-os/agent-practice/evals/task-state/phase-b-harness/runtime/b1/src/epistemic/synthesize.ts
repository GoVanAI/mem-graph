import type {
  Assessment,
  EpistemicRecord,
  SynthesisArtifact,
  SynthesisResult,
  SynthesizeInput,
  ValidationIssue,
} from './types.js';
import { sortValidationIssues, validateAssessment, validateEpistemicRecord, validateSynthesisArtifact } from './validate.js';

function issue(code: string, path: Array<string | number>, message: string): ValidationIssue {
  return { code, path, message, severity: 'error' };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => seen.has(value) || !seen.add(value));
}

/**
 * Deterministically assembles only caller-supplied structured semantic lists.
 * It deliberately makes no claim about what prose means and never weighs an
 * assigned stance or averages the assessments' confidence values.
 */
export function synthesizeAssessments(input: SynthesizeInput): SynthesisResult {
  const shape = input as SynthesizeInput & {
    assessments: readonly Assessment[]; records: readonly EpistemicRecord[]; synthesis_id: string;
    shared_observations: readonly string[]; genuine_disagreements: readonly string[];
    decisive_missing_evidence: readonly string[]; candidate_decision: string; next_actions: readonly string[];
    confidence: SynthesisArtifact['confidence']; scope: Record<string, unknown>;
  };
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(shape.assessments) || shape.assessments.length < 2) issues.push(issue('ASSESSMENT_COUNT_INVALID', ['assessments'], 'At least two assessments are required.'));
  if (!nonEmpty(shape.synthesis_id)) issues.push(issue('SYNTHESIS_ID_INVALID', ['synthesis_id'], 'synthesis_id must be non-empty.'));
  if (!nonEmpty(shape.candidate_decision)) issues.push(issue('CANDIDATE_DECISION_INVALID', ['candidate_decision'], 'candidate_decision must be non-empty.'));
  if (!Array.isArray(shape.next_actions) || shape.next_actions.length > 3 || shape.next_actions.some((action) => !nonEmpty(action))) issues.push(issue('NEXT_ACTIONS_INVALID', ['next_actions'], 'next_actions must contain at most three non-empty actions.'));
  for (const [key, values] of [['shared_observations', shape.shared_observations], ['genuine_disagreements', shape.genuine_disagreements], ['decisive_missing_evidence', shape.decisive_missing_evidence]] as const) {
    if (!Array.isArray(values) || values.some((value) => !nonEmpty(value))) issues.push(issue('SEMANTIC_LIST_INVALID', [key], `${key} must be an explicit list of non-empty strings.`));
    if (Array.isArray(values) && duplicate(values)) issues.push(issue('REFERENCE_DUPLICATE', [key], `${key} contains duplicates.`));
  }
  if (!shape.confidence || !Number.isFinite(shape.confidence.score) || shape.confidence.score < 0 || shape.confidence.score > 1 || !nonEmpty(shape.confidence.rationale)) issues.push(issue('SYNTHESIS_CONFIDENCE_INVALID', ['confidence'], 'confidence must be calibrated and explicit.'));

  const catalog = new Map<string, EpistemicRecord>();
  for (const record of shape.records ?? []) {
    const result = validateEpistemicRecord(record);
    if (!result.ok) { issues.push(...result.issues); continue; }
    if (catalog.has(record.id)) issues.push(issue('REFERENCE_DUPLICATE', ['records', record.id], `Duplicate record ${record.id}.`));
    catalog.set(record.id, record);
  }
  const assessmentIds = (shape.assessments ?? []).map((assessment) => assessment.assessment_id);
  if (duplicate(assessmentIds)) issues.push(issue('REFERENCE_DUPLICATE', ['assessments'], 'Assessment references must be unique.'));
  for (const [index, assessment] of (shape.assessments ?? []).entries()) {
    const checked = validateAssessment(assessment, { catalog });
    if (!checked.ok) {
      issues.push(...checked.issues);
      continue;
    }
    if (!assessment || assessment.schema_version !== '0.3' || !nonEmpty(assessment.assessment_id) || !nonEmpty(assessment.assigned_stance) || !nonEmpty(assessment.conclusion)) {
      issues.push(issue('ASSESSMENT_INVALID', ['assessments', index], 'Assessment is structurally incomplete.')); continue;
    }
    const refs = [...assessment.supporting_record_refs, ...assessment.counterbelief_refs];
    if (duplicate(refs)) issues.push(issue('REFERENCE_DUPLICATE', ['assessments', index], 'Assessment record references must be unique.'));
    for (const recordId of refs) {
      if (!catalog.has(recordId)) issues.push(issue('REFERENCE_UNRESOLVED', ['assessments', index], `Record ${recordId} does not resolve.`));
    }
  }
  if (issues.some((entry) => entry.severity === 'error')) return { ok: false, issues: sortValidationIssues(issues) } as SynthesisResult;
  const artifact: SynthesisArtifact = {
    schema_version: '0.3', synthesis_id: shape.synthesis_id, scope: { ...shape.scope }, assessment_refs: [...assessmentIds],
    shared_observations: [...shape.shared_observations], genuine_disagreements: [...shape.genuine_disagreements], decisive_missing_evidence: [...shape.decisive_missing_evidence],
    candidate_decision: shape.candidate_decision, candidate_decision_status: 'proposed', confidence: { ...shape.confidence, basis: [...shape.confidence.basis] }, next_actions: [...shape.next_actions],
  };
  const validatedArtifact = validateSynthesisArtifact(artifact, {
    assessments: new Map(shape.assessments.map((assessment) => [assessment.assessment_id, assessment])),
  });
  issues.push(...validatedArtifact.issues);
  if (!validatedArtifact.ok) return { ok: false, issues: sortValidationIssues(issues) } as SynthesisResult;
  return { ok: true, value: artifact, issues: sortValidationIssues(issues) } as SynthesisResult;
}
