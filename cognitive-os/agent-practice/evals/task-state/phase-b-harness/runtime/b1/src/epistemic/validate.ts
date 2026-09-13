import { z } from 'zod';
import {
  AssessmentSchema,
  CalibratedConfidenceSchema,
  CompactPrimeSchema,
  EpistemicRecordSchema,
  SynthesisArtifactSchema,
} from './schema.js';
import type {
  Assessment,
  CalibratedConfidence,
  CompactPrime,
  EpistemicRecord,
  EpistemicScope,
  PrimeMode,
  SynthesisArtifact,
  ValidationIssue,
  ValidationResult,
} from './types.js';

export interface SemanticValidationOptions {
  /** Supplying a catalog enables closed-reference validation without any database dependency. */
  catalog?: ReadonlyMap<string, EpistemicRecord>;
  /** IDs intentionally outside the supplied catalog. They are allowed only for relation targets. */
  externalReferenceIds?: ReadonlySet<string>;
  /** Eligibility mode for compact-prime validation. Defaults to ordinary. */
  mode?: PrimeMode;
  /** Optional projection time used to reject record state or provenance from the future. */
  evaluationTime?: string;
}

export interface SynthesisValidationOptions extends SemanticValidationOptions {
  assessments?: ReadonlyMap<string, Assessment>;
}

export interface EpistemicBundle {
  records: readonly unknown[];
  compact_primes?: readonly unknown[];
  assessments?: readonly unknown[];
  syntheses?: readonly unknown[];
}

export interface EpistemicBundleOptions {
  externalReferenceIds?: ReadonlySet<string>;
}

const bindingAuthorities = new Set(['operator_adopted', 'system_governing']);
const bindingRecordTypes = new Set(['decision', 'policy', 'preference', 'action']);
const nonBindingStatuses = new Set(['proposed', 'superseded', 'rejected', 'archived']);
const relationSelfTypes = new Set(['supersedes', 'contradicts', 'depends_on']);
const scopeKeys = ['workspace', 'project', 'thread', 'task', 'subject'] as const;
const hierarchicalScopeKeys = ['workspace', 'project', 'thread', 'task'] as const;
const scopeWeights: Readonly<Record<(typeof scopeKeys)[number], number>> = {
  workspace: 0.10,
  project: 0.25,
  thread: 0.20,
  task: 0.30,
  subject: 0.15,
};

/** Locale-invariant ordering for hashes, receipts, fixtures, and queue ties. */
export function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ScopeApplicability {
  eligible: boolean;
  score: number;
  reason?: string;
}

/**
 * Missing scope is unspecified, never universal. Applicability therefore
 * requires at least one explicit matching dimension and rejects mismatches or
 * records narrower than the request. Cross-project exceptions require a
 * future explicit, verified applicability mechanism and are not inferred here.
 */
export function evaluateScopeApplicability(
  recordScope: EpistemicScope,
  requestScope: EpistemicScope,
): ScopeApplicability {
  const requestHasScope = scopeKeys.some((key) => requestScope[key] !== undefined);
  const recordHasScope = scopeKeys.some((key) => recordScope[key] !== undefined);
  if (!requestHasScope) return { eligible: false, score: 0, reason: 'request scope is unspecified' };
  if (!recordHasScope) return { eligible: false, score: 0, reason: 'record scope is unspecified' };
  if (requestScope.project !== undefined || recordScope.project !== undefined) {
    if (requestScope.project === undefined) return { eligible: false, score: 0, reason: 'request project is unspecified' };
    if (recordScope.project === undefined) return { eligible: false, score: 0, reason: 'record project is unspecified' };
    if (requestScope.project !== recordScope.project) return { eligible: false, score: 0, reason: 'scope mismatch for project' };
  }
  const deepestRequest = hierarchicalScopeKeys.reduce(
    (deepest, key, index) => requestScope[key] === undefined ? deepest : index,
    -1,
  );
  for (const [index, key] of hierarchicalScopeKeys.entries()) {
    if (recordScope[key] !== undefined && requestScope[key] === undefined && index > deepestRequest) {
      return { eligible: false, score: 0, reason: `record scope is more specific than request for ${key}` };
    }
  }
  if (recordScope.subject !== undefined && requestScope.subject === undefined) {
    return { eligible: false, score: 0, reason: 'record scope is more specific than request for subject' };
  }
  let matched = 0;
  for (const key of scopeKeys) {
    const requested = requestScope[key];
    const actual = recordScope[key];
    if (requested !== undefined && actual !== undefined && requested !== actual) {
      return { eligible: false, score: 0, reason: `scope mismatch for ${key}` };
    }
    if (requested !== undefined && actual === requested) matched += scopeWeights[key];
  }
  if (matched === 0) return { eligible: false, score: 0, reason: 'record has no matching explicit scope' };
  return { eligible: true, score: matched };
}

function issue(
  code: string,
  path: Array<string | number>,
  message: string,
  severity: ValidationIssue['severity'],
  record_id?: string,
): ValidationIssue {
  return { code, path, message, severity, ...(record_id ? { record_id } : {}) };
}

function comparePath(left: Array<string | number>, right: Array<string | number>): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (typeof a === 'number' && typeof b === 'number' && a !== b) return a - b;
    const compared = compareStableText(String(a), String(b));
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

/** Stable issue ordering makes validator results suitable for deterministic fixtures and receipts. */
export function sortValidationIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort((left, right) => {
    const recordComparison = compareStableText(left.record_id ?? '', right.record_id ?? '');
    if (recordComparison !== 0) return recordComparison;
    const pathComparison = comparePath(left.path, right.path);
    if (pathComparison !== 0) return pathComparison;
    return compareStableText(left.code, right.code);
  });
}

function result<T>(value: T | undefined, issues: ValidationIssue[]): ValidationResult<T> {
  const ordered = sortValidationIssues(issues);
  return { ok: !ordered.some((entry) => entry.severity === 'error'), ...(value ? { value } : {}), issues: ordered };
}

function rawRecordId(value: unknown, property: 'id' | 'assessment_id' | 'synthesis_id' = 'id'): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' ? candidate : undefined;
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, record_id?: string): ValidationResult<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return result(parsed.data, []);
  return result<T>(undefined, parsed.error.issues.map((entry) => issue(
    'SCHEMA_INVALID',
    entry.path.map((segment) => typeof segment === 'symbol' ? String(segment) : segment),
    entry.message,
    'error',
    record_id,
  )));
}

export function confidenceBandFor(score: number): CalibratedConfidence['band'] {
  if (score >= 0.8) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

function validateConfidence(confidence: CalibratedConfidence, record_id?: string, path: Array<string | number> = ['confidence']): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const expectedBand = confidenceBandFor(confidence.score);
  if (confidence.band !== expectedBand) {
    issues.push(issue('CONFIDENCE_BAND_MISMATCH', [...path, 'band'], `Confidence score requires ${expectedBand} band.`, 'error', record_id));
  }
  confidence.basis.forEach((basis, index) => {
    if (confidence.basis.indexOf(basis) !== index) {
      issues.push(issue('CONFIDENCE_BASIS_DUPLICATE', [...path, 'basis', index], 'Confidence basis codes must be unique.', 'error', record_id));
    }
  });
  const blockedHigh = confidence.basis.includes('MISSING_DIRECT_EVIDENCE')
    || confidence.basis.includes('CONTRADICTED')
    || (confidence.basis.length === 1 && confidence.basis[0] === 'PLAUSIBLE_INFERENCE');
  if (confidence.band === 'high' && blockedHigh) {
    issues.push(issue('CONFIDENCE_BASIS_OVERCLAIM', [...path, 'basis'], 'The stated confidence basis cannot support a high band.', 'error', record_id));
  }
  return issues;
}

function parseTime(value: string): number {
  return Date.parse(value);
}

function validateRecordSemantics(record: EpistemicRecord, options: SemanticValidationOptions): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { id } = record;
  issues.push(...validateConfidence(record.confidence, id));
  if (parseTime(record.updated_at) < parseTime(record.created_at)) {
    issues.push(issue('TIMESTAMP_ORDER_INVALID', ['updated_at'], 'updated_at must not be earlier than created_at.', 'error', id));
  }
  record.provenance.forEach((entry, index) => {
    if (parseTime(entry.observed_at) > parseTime(record.updated_at)) {
      issues.push(issue('PROVENANCE_AFTER_RECORD_UPDATE', ['provenance', index, 'observed_at'], 'Provenance observation cannot postdate the record state that cites it.', 'error', id));
    }
  });
  if (options.evaluationTime) {
    const evaluationTime = parseTime(options.evaluationTime);
    for (const [field, timestamp] of [['created_at', record.created_at], ['updated_at', record.updated_at]] as const) {
      if (parseTime(timestamp) > evaluationTime) {
        issues.push(issue('TIMESTAMP_IN_FUTURE', [field], `${field} cannot be later than the evaluation time.`, 'error', id));
      }
    }
    record.provenance.forEach((entry, index) => {
      if (parseTime(entry.observed_at) > evaluationTime) {
        issues.push(issue('PROVENANCE_IN_FUTURE', ['provenance', index, 'observed_at'], 'Provenance observation cannot be later than the evaluation time.', 'error', id));
      }
    });
  }
  if (record.scope.valid_from && record.scope.valid_until && parseTime(record.scope.valid_until) < parseTime(record.scope.valid_from)) {
    issues.push(issue('TIMESTAMP_ORDER_INVALID', ['scope', 'valid_until'], 'valid_until must not be earlier than valid_from.', 'error', id));
  }
  if (record.provenance.length === 0) {
    const syntheticException = record.type === 'question' || record.type === 'action';
    issues.push(issue(
      syntheticException ? 'SYNTHETIC_PROVENANCE_EXCEPTION' : 'PROVENANCE_REQUIRED',
      ['provenance'],
      syntheticException
        ? 'Synthetic questions and actions may omit provenance, but the exception is recorded.'
        : 'At least one provenance entry is required for this record type.',
      syntheticException ? 'warning' : 'error',
      id,
    ));
  }
  const seenRelations = new Set<string>();
  record.relations.forEach((relation, index) => {
    const relationKey = `${relation.type}\u0000${relation.target_id}`;
    if (seenRelations.has(relationKey)) {
      issues.push(issue('DUPLICATE_RELATION', ['relations', index], 'Relation type and target_id pairs must be unique.', 'error', id));
    }
    seenRelations.add(relationKey);
    if (relationSelfTypes.has(relation.type) && relation.target_id === id) {
      issues.push(issue('SELF_RELATION_INVALID', ['relations', index, 'target_id'], 'This relation type cannot target the same record.', 'error', id));
    }
    if (options.catalog && !options.catalog.has(relation.target_id) && !options.externalReferenceIds?.has(relation.target_id)) {
      issues.push(issue('REFERENCE_UNRESOLVED', ['relations', index, 'target_id'], 'Relation target does not resolve in the supplied closed catalog.', 'error', id));
    }
  });
  if (record.status === 'disputed' && !record.relations.some((relation) => relation.type === 'contradicts')) {
    issues.push(issue('DISPUTE_WITHOUT_CONTRADICTION', ['relations'], 'Disputed records require a contradiction relation.', 'error', id));
  }
  if (record.status === 'conditional' && (!record.conditions || record.conditions.length === 0)) {
    issues.push(issue('CONDITIONS_REQUIRED', ['conditions'], 'Conditional records require at least one explicit condition.', 'error', id));
  }
  if (record.provenance.length > 0
    && record.provenance.every((entry) => entry.source_type === 'execution_audit')
    && record.type === 'evidence'
    && /\b(repository|system|source|implementation|codebase|does not|doesn't|lacks|missing)\b/i.test(record.statement)) {
    issues.push(issue('EXECUTION_AUDIT_OVERCLAIM', ['provenance'], 'Execution-audit provenance alone may describe the audit, not prove an underlying-system claim.', 'warning', id));
  }
  if (bindingAuthorities.has(record.authority) && nonBindingStatuses.has(record.status)) {
    issues.push(issue('BINDING_STATUS_INVALID', ['status'], 'This authority claim is non-binding at the record lifecycle status.', 'warning', id));
  }
  return issues;
}

export function validateEpistemicRecord(value: unknown, options: SemanticValidationOptions = {}): ValidationResult<EpistemicRecord> {
  const parsed = parseSchema(EpistemicRecordSchema, value, rawRecordId(value));
  if (!parsed.value) return parsed;
  return result(parsed.value, validateRecordSemantics(parsed.value, options));
}

function validateUniqueReferences(
  refs: readonly string[],
  path: string,
  record_id: string,
  issues: ValidationIssue[],
): void {
  const seen = new Set<string>();
  refs.forEach((id, index) => {
    if (seen.has(id)) issues.push(issue('REFERENCE_DUPLICATE', [path, index], 'Reference IDs must be unique.', 'error', record_id));
    seen.add(id);
  });
}

function primeEligible(record: EpistemicRecord, now: string, mode: PrimeMode): boolean {
  if (parseTime(record.created_at) > parseTime(now) || parseTime(record.updated_at) > parseTime(now)) return false;
  if (record.provenance.some((entry) => parseTime(entry.observed_at) > parseTime(now))) return false;
  if (record.scope.valid_from && parseTime(record.scope.valid_from) > parseTime(now)) return false;
  if (mode !== 'historical') {
    if (record.status === 'superseded' || record.status === 'rejected' || record.status === 'archived') return false;
    if (record.scope.valid_until && parseTime(record.scope.valid_until) < parseTime(now)) return false;
  }
  if (mode === 'ordinary' && record.status === 'completed') return false;
  if (mode === 'completion' && record.status === 'completed' && record.type !== 'action') return false;
  return true;
}

function recordsContradict(left: EpistemicRecord, right: EpistemicRecord): boolean {
  return left.relations.some((relation) => relation.type === 'contradicts' && relation.target_id === right.id)
    || right.relations.some((relation) => relation.type === 'contradicts' && relation.target_id === left.id);
}

export function validateCompactPrime(value: unknown, options: SemanticValidationOptions = {}): ValidationResult<CompactPrime> {
  const parsed = parseSchema(CompactPrimeSchema, value);
  if (!parsed.value) return parsed;
  const prime = parsed.value;
  const issues: ValidationIssue[] = [];
  const mode = options.mode ?? 'ordinary';
  const lanes: Array<[string, typeof prime.record_refs]> = [
    ['record_refs', prime.record_refs],
    ['contradiction_refs', prime.contradiction_refs],
    ['open_question_refs', prime.open_question_refs],
    ['recommended_action_refs', prime.recommended_action_refs],
  ];
  const seen = new Set<string>();
  for (const [lane, refs] of lanes) {
    refs.forEach((reference, index) => {
      if (seen.has(reference.id)) issues.push(issue('REFERENCE_DUPLICATE', [lane, index, 'id'], 'A compact-prime record can appear in only one lane.', 'error'));
      seen.add(reference.id);
      const record = options.catalog?.get(reference.id);
      if (options.catalog && !record) {
        issues.push(issue('REFERENCE_UNRESOLVED', [lane, index, 'id'], 'Prime reference does not resolve in the supplied catalog.', 'error'));
      } else if (record && !primeEligible(record, prime.generated_at, mode)) {
        issues.push(issue('REFERENCE_INELIGIBLE', [lane, index, 'id'], `Prime reference is not eligible in ${mode} mode.`, 'error', record.id));
      } else if (record && !evaluateScopeApplicability(record.scope, prime.scope).eligible) {
        const applicability = evaluateScopeApplicability(record.scope, prime.scope);
        issues.push(issue('SCOPE_NOT_APPLICABLE', [lane, index, 'id'], `Prime reference scope is ineligible: ${applicability.reason}.`, 'error', record.id));
      } else if (record && lane === 'open_question_refs' && record.type !== 'question') {
        issues.push(issue('REFERENCE_INELIGIBLE', [lane, index, 'id'], 'Open-question references must resolve to question records.', 'error', record.id));
      } else if (record && lane === 'recommended_action_refs' && record.type !== 'action') {
        issues.push(issue('REFERENCE_INELIGIBLE', [lane, index, 'id'], 'Recommended-action references must resolve to action records.', 'error', record.id));
      } else if (record && lane === 'record_refs' && (record.type === 'question' || record.type === 'action')) {
        issues.push(issue('REFERENCE_INELIGIBLE', [lane, index, 'id'], 'Question and action records belong in their dedicated lanes.', 'error', record.id));
      }
    });
  }
  for (const reference of prime.record_refs) {
    const record = options.catalog?.get(reference.id);
    if (record?.status === 'disputed') {
      const hasChallenger = prime.contradiction_refs.some((entry) => {
        const challenger = options.catalog?.get(entry.id);
        return challenger !== undefined && recordsContradict(record, challenger);
      });
      if (!hasChallenger) {
        issues.push(issue('REFERENCE_INELIGIBLE', ['record_refs'], 'Disputed primary material requires a related challenger in the contradiction lane.', 'error', record.id));
      }
    }
  }
  for (const [index, reference] of prime.contradiction_refs.entries()) {
    const challenger = options.catalog?.get(reference.id);
    if (challenger && !prime.record_refs.some((entry) => {
      const primary = options.catalog?.get(entry.id);
      return primary !== undefined && recordsContradict(primary, challenger);
    })) {
      issues.push(issue('REFERENCE_INELIGIBLE', ['contradiction_refs', index, 'id'], 'Contradiction references must directly challenge a selected primary record.', 'error', challenger.id));
    }
  }
  if (prime.audit.included_count !== prime.record_refs.length || prime.audit.contradiction_count !== prime.contradiction_refs.length) {
    issues.push(issue('PRIME_AUDIT_MISMATCH', ['audit'], 'Prime audit counts must match the emitted references.', 'error'));
  }
  if (prime.audit.candidate_count < prime.audit.eligible_count || prime.audit.eligible_count < prime.audit.included_count) {
    issues.push(issue('PRIME_AUDIT_MISMATCH', ['audit'], 'Candidate, eligible, and included counts must be monotonically bounded.', 'error'));
  }
  return result(prime, issues);
}

export function validateAssessment(value: unknown, options: SemanticValidationOptions = {}): ValidationResult<Assessment> {
  const parsed = parseSchema(AssessmentSchema, value, rawRecordId(value, 'assessment_id'));
  if (!parsed.value) return parsed;
  const assessment = parsed.value;
  const issues = validateConfidence(assessment.confidence, assessment.assessment_id);
  const refs = [...assessment.supporting_record_refs, ...assessment.counterbelief_refs];
  validateUniqueReferences(refs, 'record_refs', assessment.assessment_id, issues);
  refs.forEach((reference, index) => {
    const record = options.catalog?.get(reference);
    if (options.catalog && !record) {
      issues.push(issue('REFERENCE_UNRESOLVED', ['record_refs', index], 'Assessment record reference does not resolve in the supplied catalog.', 'error', assessment.assessment_id));
    } else if (record && !evaluateScopeApplicability(record.scope, assessment.scope).eligible) {
      issues.push(issue('SCOPE_NOT_APPLICABLE', ['record_refs', index], 'Assessment record reference is outside the assessment scope.', 'error', assessment.assessment_id));
    }
  });
  return result(assessment, issues);
}

export function validateSynthesisArtifact(value: unknown, options: SynthesisValidationOptions = {}): ValidationResult<SynthesisArtifact> {
  const parsed = parseSchema(SynthesisArtifactSchema, value, rawRecordId(value, 'synthesis_id'));
  if (!parsed.value) return parsed;
  const synthesis = parsed.value;
  const issues = validateConfidence(synthesis.confidence, synthesis.synthesis_id);
  validateUniqueReferences(synthesis.assessment_refs, 'assessment_refs', synthesis.synthesis_id, issues);
  synthesis.assessment_refs.forEach((reference, index) => {
    const assessment = options.assessments?.get(reference);
    if (options.assessments && !assessment) {
      issues.push(issue('REFERENCE_UNRESOLVED', ['assessment_refs', index], 'Synthesis assessment reference does not resolve in the supplied catalog.', 'error', synthesis.synthesis_id));
    } else if (assessment && !evaluateScopeApplicability(assessment.scope, synthesis.scope).eligible) {
      issues.push(issue('SCOPE_NOT_APPLICABLE', ['assessment_refs', index], 'Assessment is outside the synthesis scope.', 'error', synthesis.synthesis_id));
    }
  });
  return result(synthesis, issues);
}

/**
 * Phase 0 authority fields are claims, not an authority registry. A caller
 * must explicitly supply IDs it has independently verified as authoritative.
 */
export function isBindingEligible(record: EpistemicRecord, verifiedAuthorityIds?: ReadonlySet<string>): boolean {
  return Boolean(
    verifiedAuthorityIds?.has(record.id)
    && bindingRecordTypes.has(record.type)
    && bindingAuthorities.has(record.authority)
    && !nonBindingStatuses.has(record.status)
    && (record.status === 'active' || record.status === 'conditional'),
  );
}

/** Validates a closed in-memory bundle; external IDs may be declared only for record relations. */
export function validateEpistemicBundle(bundle: EpistemicBundle, options: EpistemicBundleOptions = {}): ValidationResult<{
  records: EpistemicRecord[];
  compact_primes: CompactPrime[];
  assessments: Assessment[];
  syntheses: SynthesisArtifact[];
}> {
  const preliminary = bundle.records.map((entry) => parseSchema(EpistemicRecordSchema, entry, rawRecordId(entry)));
  const records = preliminary.flatMap((entry) => entry.value ? [entry.value] : []);
  const issues = preliminary.flatMap((entry) => entry.issues);
  const catalog = new Map<string, EpistemicRecord>();
  records.forEach((record, index) => {
    if (catalog.has(record.id)) issues.push(issue('REFERENCE_DUPLICATE', ['records', index, 'id'], 'Record IDs must be unique within a bundle.', 'error', record.id));
    catalog.set(record.id, record);
  });
  records.forEach((record) => issues.push(...validateRecordSemantics(record, { catalog, externalReferenceIds: options.externalReferenceIds })));

  const assessments: Assessment[] = [];
  for (const entry of bundle.assessments ?? []) {
    const checked = validateAssessment(entry, { catalog });
    issues.push(...checked.issues);
    if (checked.value) assessments.push(checked.value);
  }
  const assessmentCatalog = new Map(assessments.map((assessment) => [assessment.assessment_id, assessment]));
  const compact_primes: CompactPrime[] = [];
  for (const entry of bundle.compact_primes ?? []) {
    const checked = validateCompactPrime(entry, { catalog });
    issues.push(...checked.issues);
    if (checked.value) compact_primes.push(checked.value);
  }
  const syntheses: SynthesisArtifact[] = [];
  for (const entry of bundle.syntheses ?? []) {
    const checked = validateSynthesisArtifact(entry, { catalog, assessments: assessmentCatalog });
    issues.push(...checked.issues);
    if (checked.value) syntheses.push(checked.value);
  }
  const value = { records, compact_primes, assessments, syntheses };
  return result(value, issues);
}

export { CalibratedConfidenceSchema };
