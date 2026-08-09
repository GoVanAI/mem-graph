import { z } from 'zod';
import type { EpistemicRecord, EpistemicScope, ProvenanceRef } from './types.js';
import { EpistemicScopeSchema, ProvenanceRefSchema } from './schema.js';
import { compareStableText, validateEpistemicRecord } from './validate.js';

export type ChallengeResult = 'supported' | 'contradicted' | 'inconclusive';
export type OutcomeRole = 'decisive' | 'supporting' | 'contextual' | 'not_testable';
export type OutcomeResult = 'matched' | 'missed' | 'inconclusive';
export type ContradictionSeverity = 'low' | 'medium' | 'high';
export type BeliefReviewState =
  | 'challenged'
  | 'overdue'
  | 'worldview_audit'
  | 'review_due'
  | 'current';

/** Deliberate-review settings; none are inferred from retrieval or repetition. */
export interface BeliefReviewPolicy {
  /** Exact record identity and scope prevent a policy from drifting onto another belief. */
  belief_id: string;
  scope: EpistemicScope;
  review_after?: string;
  review_interval_ms?: number;
  risk?: number;
  risk_score?: number;
  volatility?: number;
  volatility_score?: number;
  high_influence_threshold?: number;
  worldview_project_threshold?: number;
  worldview_distinct_project_threshold?: number;
  worldview_use_threshold?: number;
  worldview_decisive_supporting_use_threshold?: number;
  applicability_floor?: number;
}

export interface ChallengeReceipt {
  id: string;
  belief_id: string;
  prediction_or_claim?: string;
  claim_under_test?: string;
  falsifier: string;
  method: string;
  result: ChallengeResult;
  challenged_at: string;
  provenance: ProvenanceRef[];
  independence_key: string;
}

export interface BeliefUseReceipt {
  id: string;
  belief_id: string;
  decision_id: string;
  project_id: string;
  used_at: string;
  role: OutcomeRole;
  provenance: ProvenanceRef[];
  independence_key: string;
}

export interface DecisionOutcomeReceipt {
  id: string;
  belief_id: string;
  decision_id: string;
  predicted_result: string;
  predicted_at: string;
  observed_result: string;
  role: OutcomeRole;
  result: OutcomeResult;
  observed_at: string;
  provenance: ProvenanceRef[];
  independence_key: string;
  independently_attributable: boolean;
  /** Required for an attributable decisive/supporting outcome. */
  attribution_use_receipt_id?: string;
}

export interface ContradictionSignal {
  id: string;
  belief_id: string;
  observation_id: string;
  rationale: string;
  severity: ContradictionSeverity;
  signaled_at: string;
  provenance: ProvenanceRef[];
}

export interface MaintenanceIssue {
  code: string;
  path: Array<string | number>;
  message: string;
  severity: 'error' | 'warning';
}

export interface MaintenanceResult<T> {
  ok: boolean;
  value?: T;
  issues: MaintenanceIssue[];
}

export interface ProjectBeliefMaintenanceInput {
  belief: EpistemicRecord;
  policy: BeliefReviewPolicy;
  now: string;
  applicability_score?: number;
  challenge_receipts?: readonly ChallengeReceipt[];
  use_receipts?: readonly BeliefUseReceipt[];
  outcome_receipts?: readonly DecisionOutcomeReceipt[];
  contradiction_signals?: readonly ContradictionSignal[];
}

export interface BeliefMaintenanceProjection {
  belief_id: string;
  /** A historical value: maintenance never recalibrates or rewrites it. */
  historical_confidence: number;
  status_unchanged: EpistemicRecord['status'];
  authority_unchanged: EpistemicRecord['authority'];
  support: {
    challenges: { supported: number; contradicted: number; inconclusive: number; unique_count: number };
    outcomes: {
      matched: number;
      missed: number;
      inconclusive: number;
      independently_attributable_count: number;
      ignored_count: number;
    };
    contradictions: { count: number; pressure: number };
  };
  applicability_freshness: {
    applicability_score: number;
    applicability_floor: number;
    applicable: boolean;
    freshness_score: number;
    reference_at: string;
    stale: boolean;
  };
  influence_score: number;
  review_priority_score: number;
  ordinary_priming_factor: number;
  review: { states: BeliefReviewState[]; reasons: string[]; next_review_at: string };
  audit_visibility: 'full' | 'standard';
}

export interface BeliefReviewQueueEntry {
  belief_id: string;
  state: Exclude<BeliefReviewState, 'current'>;
  reasons: string[];
  influence_score: number;
  review_priority_score: number;
  audit_visibility: 'full';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REVIEW_INTERVAL_MS = 30 * DAY_MS;
const DEFAULT_HIGH_INFLUENCE_THRESHOLD = 0.7;
const DEFAULT_WORLDVIEW_PROJECT_THRESHOLD = 2;
const DEFAULT_WORLDVIEW_USE_THRESHOLD = 2;
const DEFAULT_APPLICABILITY_FLOOR = 0.5;
const IsoTimestampSchema = z.iso.datetime({ offset: true });
const OpaqueIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);

function issue(
  code: string,
  path: Array<string | number>,
  message: string,
  severity: 'error' | 'warning' = 'error',
): MaintenanceIssue {
  return { code, path, message, severity };
}

function sortIssues(issues: MaintenanceIssue[]): MaintenanceIssue[] {
  return issues.sort((left, right) => {
    const leftPath = left.path.join('.');
    const rightPath = right.path.join('.');
    return compareStableText(leftPath, rightPath) || compareStableText(left.code, right.code);
  });
}

function parseIso(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  if (!IsoTimestampSchema.safeParse(value).success) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validProvenance(provenance: unknown): provenance is readonly ProvenanceRef[] {
  return Array.isArray(provenance) && provenance.length > 0 && provenance.every((entry) => ProvenanceRefSchema.safeParse(entry).success);
}

function validOpaqueId(value: unknown): value is string {
  return OpaqueIdSchema.safeParse(value).success;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareStableText(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function receiptFingerprint(receipt: object): string {
  return JSON.stringify(canonicalize(receipt));
}

function deduplicate<T extends { id: string; independence_key?: string }>(
  receipts: readonly T[],
  path: string,
  issues: MaintenanceIssue[],
): T[] {
  const ids = new Set<string>();
  const independenceKeys = new Set<string>();
  const fingerprints = new Set<string>();
  const unique: T[] = [];

  receipts.forEach((receipt, index) => {
    const fingerprint = receiptFingerprint(receipt);
    const duplicate = ids.has(receipt.id)
      || fingerprints.has(fingerprint)
      || (receipt.independence_key !== undefined && independenceKeys.has(receipt.independence_key));
    if (duplicate) {
      issues.push(issue('DUPLICATE_RECEIPT', [path, index], 'Duplicate receipt was ignored.', 'warning'));
      return;
    }
    ids.add(receipt.id);
    fingerprints.add(fingerprint);
    if (receipt.independence_key !== undefined) independenceKeys.add(receipt.independence_key);
    unique.push(receipt);
  });
  return unique;
}

function validateChallenge(receipt: ChallengeReceipt, index: number, issues: MaintenanceIssue[]): void {
  const required = [
    ['id', receipt.id],
    ['belief_id', receipt.belief_id],
    ['falsifier', receipt.falsifier],
    ['method', receipt.method],
    ['independence_key', receipt.independence_key],
  ] as const;
  if (!nonBlank(receipt.prediction_or_claim ?? receipt.claim_under_test ?? '')) {
    issues.push(issue('CHALLENGE_RECEIPT_INVALID', ['challenge_receipts', index, 'prediction_or_claim'], 'A prediction or claim under test is required.'));
  }
  for (const [field, value] of required) {
    if (!nonBlank(value)) issues.push(issue('CHALLENGE_RECEIPT_INVALID', ['challenge_receipts', index, field], 'Required field is blank.'));
  }
  for (const [field, value] of [['id', receipt.id], ['belief_id', receipt.belief_id]] as const) {
    if (!validOpaqueId(value)) issues.push(issue('CHALLENGE_RECEIPT_INVALID', ['challenge_receipts', index, field], 'Field must be a stable opaque ID.'));
  }
  if (!['supported', 'contradicted', 'inconclusive'].includes(receipt.result)) {
    issues.push(issue('CHALLENGE_RESULT_INVALID', ['challenge_receipts', index, 'result'], 'Invalid challenge result.'));
  }
  if (parseIso(receipt.challenged_at) === undefined) {
    issues.push(issue('TIMESTAMP_INVALID', ['challenge_receipts', index, 'challenged_at'], 'Timestamp must be ISO 8601.'));
  }
  if (!validProvenance(receipt.provenance)) {
    issues.push(issue('PROVENANCE_INVALID', ['challenge_receipts', index, 'provenance'], 'At least one valid provenance entry is required.'));
  }
}

function validateUse(receipt: BeliefUseReceipt, index: number, issues: MaintenanceIssue[]): void {
  for (const [field, value] of [['id', receipt.id], ['belief_id', receipt.belief_id], ['decision_id', receipt.decision_id], ['project_id', receipt.project_id], ['independence_key', receipt.independence_key]] as const) {
    if (!nonBlank(value)) issues.push(issue('USE_RECEIPT_INVALID', ['use_receipts', index, field], 'Required field is blank.'));
  }
  for (const [field, value] of [['id', receipt.id], ['belief_id', receipt.belief_id], ['decision_id', receipt.decision_id]] as const) {
    if (!validOpaqueId(value)) issues.push(issue('USE_RECEIPT_INVALID', ['use_receipts', index, field], 'Field must be a stable opaque ID.'));
  }
  if (!['decisive', 'supporting', 'contextual', 'not_testable'].includes(receipt.role)) {
    issues.push(issue('USE_ROLE_INVALID', ['use_receipts', index, 'role'], 'Invalid use role.'));
  }
  if (parseIso(receipt.used_at) === undefined) issues.push(issue('TIMESTAMP_INVALID', ['use_receipts', index, 'used_at'], 'Timestamp must be ISO 8601.'));
  if (!validProvenance(receipt.provenance)) issues.push(issue('PROVENANCE_INVALID', ['use_receipts', index, 'provenance'], 'At least one valid provenance entry is required.'));
}

function validateOutcome(receipt: DecisionOutcomeReceipt, index: number, issues: MaintenanceIssue[]): void {
  for (const [field, value] of [
    ['id', receipt.id],
    ['belief_id', receipt.belief_id],
    ['decision_id', receipt.decision_id],
    ['predicted_result', receipt.predicted_result],
    ['observed_result', receipt.observed_result],
    ['independence_key', receipt.independence_key],
  ] as const) {
    if (!nonBlank(value)) issues.push(issue('OUTCOME_RECEIPT_INVALID', ['outcome_receipts', index, field], 'Required field is blank.'));
  }
  for (const [field, value] of [['id', receipt.id], ['belief_id', receipt.belief_id], ['decision_id', receipt.decision_id]] as const) {
    if (!validOpaqueId(value)) issues.push(issue('OUTCOME_RECEIPT_INVALID', ['outcome_receipts', index, field], 'Field must be a stable opaque ID.'));
  }
  if (!['decisive', 'supporting', 'contextual', 'not_testable'].includes(receipt.role)) issues.push(issue('OUTCOME_ROLE_INVALID', ['outcome_receipts', index, 'role'], 'Invalid outcome role.'));
  if (!['matched', 'missed', 'inconclusive'].includes(receipt.result)) issues.push(issue('OUTCOME_RESULT_INVALID', ['outcome_receipts', index, 'result'], 'Invalid outcome result.'));
  if (typeof receipt.independently_attributable !== 'boolean') {
    issues.push(issue('OUTCOME_RECEIPT_INVALID', ['outcome_receipts', index, 'independently_attributable'], 'Attribution must be an explicit boolean.'));
  }
  if (receipt.independently_attributable
    && (receipt.role === 'decisive' || receipt.role === 'supporting')
    && !validOpaqueId(receipt.attribution_use_receipt_id)) {
    issues.push(issue('OUTCOME_RECEIPT_INVALID', ['outcome_receipts', index, 'attribution_use_receipt_id'], 'Attributable outcomes must cite a stable use receipt ID.'));
  }
  const predictedAt = parseIso(receipt.predicted_at);
  if (predictedAt === undefined) issues.push(issue('TIMESTAMP_INVALID', ['outcome_receipts', index, 'predicted_at'], 'Timestamp must be ISO 8601 with a timezone offset.'));
  if (parseIso(receipt.observed_at) === undefined) issues.push(issue('TIMESTAMP_INVALID', ['outcome_receipts', index, 'observed_at'], 'Timestamp must be ISO 8601.'));
  if (predictedAt !== undefined && parseIso(receipt.observed_at) !== undefined && predictedAt > parseIso(receipt.observed_at)!) {
    issues.push(issue('TIMESTAMP_ORDER_INVALID', ['outcome_receipts', index, 'predicted_at'], 'Prediction must be recorded no later than its observed outcome.'));
  }
  if (!validProvenance(receipt.provenance)) issues.push(issue('PROVENANCE_INVALID', ['outcome_receipts', index, 'provenance'], 'At least one valid provenance entry is required.'));
}

function validateContradiction(signal: ContradictionSignal, index: number, issues: MaintenanceIssue[]): void {
  for (const [field, value] of [['id', signal.id], ['belief_id', signal.belief_id], ['observation_id', signal.observation_id], ['rationale', signal.rationale]] as const) {
    if (!nonBlank(value)) issues.push(issue('CONTRADICTION_SIGNAL_INVALID', ['contradiction_signals', index, field], 'Required field is blank.'));
  }
  for (const [field, value] of [['id', signal.id], ['belief_id', signal.belief_id], ['observation_id', signal.observation_id]] as const) {
    if (!validOpaqueId(value)) issues.push(issue('CONTRADICTION_SIGNAL_INVALID', ['contradiction_signals', index, field], 'Field must be a stable opaque ID.'));
  }
  if (!['low', 'medium', 'high'].includes(signal.severity)) issues.push(issue('CONTRADICTION_SEVERITY_INVALID', ['contradiction_signals', index, 'severity'], 'Invalid contradiction severity.'));
  if (parseIso(signal.signaled_at) === undefined) issues.push(issue('TIMESTAMP_INVALID', ['contradiction_signals', index, 'signaled_at'], 'Timestamp must be ISO 8601.'));
  if (!validProvenance(signal.provenance)) issues.push(issue('PROVENANCE_INVALID', ['contradiction_signals', index, 'provenance'], 'At least one valid provenance entry is required.'));
}

/**
 * Creates a read-only review projection for a single belief. It deliberately
 * does not alter the belief's status, authority, or historical confidence.
 */
export function projectBeliefMaintenance(
  input: ProjectBeliefMaintenanceInput,
): MaintenanceResult<BeliefMaintenanceProjection> {
  const issues: MaintenanceIssue[] = [];
  const { belief, policy } = input;
  const checkedBelief = validateEpistemicRecord(belief);
  issues.push(...checkedBelief.issues.map((entry) => ({
    code: entry.code,
    path: ['belief', ...entry.path],
    message: entry.message,
    severity: entry.severity,
  })));
  if (belief.type !== 'belief') {
    issues.push(issue('RECORD_TYPE_INVALID', ['belief', 'type'], 'Maintenance accepts belief records only.'));
  }
  const now = parseIso(input.now);
  if (now === undefined) issues.push(issue('TIMESTAMP_INVALID', ['now'], 'Timestamp must be ISO 8601.'));
  const updatedAt = parseIso(belief.updated_at);
  if (updatedAt === undefined) issues.push(issue('TIMESTAMP_INVALID', ['belief', 'updated_at'], 'Timestamp must be ISO 8601.'));
  if (now !== undefined && updatedAt !== undefined && updatedAt > now) {
    issues.push(issue('TIMESTAMP_IN_FUTURE', ['belief', 'updated_at'], 'Belief state cannot be newer than projection time.'));
  }
  if (!validOpaqueId(policy.belief_id)) {
    issues.push(issue('REVIEW_POLICY_INVALID', ['policy', 'belief_id'], 'Policy belief_id must be a stable opaque ID.'));
  } else if (policy.belief_id !== belief.id) {
    issues.push(issue('REVIEW_POLICY_BELIEF_MISMATCH', ['policy', 'belief_id'], 'Review policy belongs to a different belief.'));
  }
  const policyScope = EpistemicScopeSchema.safeParse(policy.scope);
  if (!policyScope.success) {
    issues.push(issue('REVIEW_POLICY_INVALID', ['policy', 'scope'], 'Policy scope must be a valid explicit epistemic scope.'));
  } else {
    const identityKeys = ['workspace', 'project', 'thread', 'task', 'subject'] as const;
    const policyHasScope = identityKeys.some((key) => policyScope.data[key] !== undefined);
    if (!policyHasScope || identityKeys.some((key) => policyScope.data[key] !== belief.scope[key])) {
      issues.push(issue('REVIEW_POLICY_SCOPE_MISMATCH', ['policy', 'scope'], 'Review policy scope must exactly identify the belief scope.'));
    }
  }
  const reviewAfter = policy.review_after === undefined ? undefined : parseIso(policy.review_after);
  if (policy.review_after !== undefined && reviewAfter === undefined) issues.push(issue('TIMESTAMP_INVALID', ['policy', 'review_after'], 'Timestamp must be ISO 8601.'));
  const interval = policy.review_interval_ms ?? DEFAULT_REVIEW_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval <= 0) issues.push(issue('REVIEW_POLICY_INVALID', ['policy', 'review_interval_ms'], 'Review interval must be a positive finite number.'));
  for (const [field, value] of [
    ['risk_score', policy.risk_score ?? policy.risk ?? 0],
    ['volatility_score', policy.volatility_score ?? policy.volatility ?? 0],
    ['applicability_floor', policy.applicability_floor ?? DEFAULT_APPLICABILITY_FLOOR],
    ['applicability_score', input.applicability_score ?? 1],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) issues.push(issue('SCORE_INVALID', [field === 'applicability_score' ? field : 'policy', field === 'applicability_score' ? '' : field].filter(Boolean), 'Score must be within [0, 1].'));
  }
  const highInfluenceThreshold = policy.high_influence_threshold ?? DEFAULT_HIGH_INFLUENCE_THRESHOLD;
  if (!Number.isFinite(highInfluenceThreshold) || highInfluenceThreshold < 0 || highInfluenceThreshold > 1) {
    issues.push(issue('REVIEW_POLICY_INVALID', ['policy', 'high_influence_threshold'], 'High-influence threshold must be within [0, 1].'));
  }
  for (const [field, value] of [
    ['worldview_distinct_project_threshold', policy.worldview_distinct_project_threshold ?? policy.worldview_project_threshold ?? DEFAULT_WORLDVIEW_PROJECT_THRESHOLD],
    ['worldview_decisive_supporting_use_threshold', policy.worldview_decisive_supporting_use_threshold ?? policy.worldview_use_threshold ?? DEFAULT_WORLDVIEW_USE_THRESHOLD],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) issues.push(issue('REVIEW_POLICY_INVALID', ['policy', field], 'Worldview thresholds must be positive integers.'));
  }

  const challenges = input.challenge_receipts ?? [];
  const uses = input.use_receipts ?? [];
  const outcomes = input.outcome_receipts ?? [];
  const contradictions = input.contradiction_signals ?? [];
  challenges.forEach((receipt, index) => validateChallenge(receipt, index, issues));
  uses.forEach((receipt, index) => validateUse(receipt, index, issues));
  outcomes.forEach((receipt, index) => validateOutcome(receipt, index, issues));
  contradictions.forEach((signal, index) => validateContradiction(signal, index, issues));
  const receiptGroups: Array<[string, readonly { belief_id: string }[]]> = [
    ['challenge_receipts', challenges],
    ['use_receipts', uses],
    ['outcome_receipts', outcomes],
    ['contradiction_signals', contradictions],
  ];
  for (const [path, receipts] of receiptGroups) {
    receipts.forEach((receipt, index) => {
      if (receipt.belief_id !== belief.id) {
        issues.push(issue('RECEIPT_BELIEF_MISMATCH', [path, index, 'belief_id'], 'Receipt belongs to a different belief.'));
      }
    });
  }
  if (now !== undefined) {
    if (Array.isArray(belief.provenance)) {
      belief.provenance.forEach((entry, provenanceIndex) => {
        const observedAt = parseIso(entry.observed_at);
        if (observedAt !== undefined && observedAt > now) {
          issues.push(issue('PROVENANCE_IN_FUTURE', ['belief', 'provenance', provenanceIndex, 'observed_at'], 'Belief provenance cannot postdate projection time.'));
        }
      });
    }
    const receiptTimes: Array<[string, readonly string[]]> = [
      ['challenge_receipts', challenges.map((entry) => entry.challenged_at)],
      ['use_receipts', uses.map((entry) => entry.used_at)],
      ['outcome_receipts', outcomes.map((entry) => entry.observed_at)],
      ['contradiction_signals', contradictions.map((entry) => entry.signaled_at)],
    ];
    for (const [path, timestamps] of receiptTimes) {
      timestamps.forEach((timestamp, index) => {
        const parsed = parseIso(timestamp);
        if (parsed !== undefined && parsed > now) issues.push(issue('TIMESTAMP_IN_FUTURE', [path, index], 'Receipt timestamp cannot be later than projection time.'));
      });
    }
    const provenanceGroups: Array<[string, readonly { provenance: readonly ProvenanceRef[] }[]]> = [
      ['challenge_receipts', challenges],
      ['use_receipts', uses],
      ['outcome_receipts', outcomes],
      ['contradiction_signals', contradictions],
    ];
    for (const [path, receipts] of provenanceGroups) {
      receipts.forEach((receipt, receiptIndex) => {
        if (!Array.isArray(receipt.provenance)) return;
        receipt.provenance.forEach((entry, provenanceIndex) => {
          const observedAt = parseIso(entry.observed_at);
          if (observedAt !== undefined && observedAt > now) {
            issues.push(issue('PROVENANCE_IN_FUTURE', [path, receiptIndex, 'provenance', provenanceIndex, 'observed_at'], 'Receipt provenance cannot postdate projection time.'));
          }
        });
      });
    }
  }

  const uniqueChallenges = deduplicate(challenges, 'challenge_receipts', issues);
  const uniqueUses = deduplicate(uses, 'use_receipts', issues);
  const uniqueOutcomes = deduplicate(outcomes, 'outcome_receipts', issues);
  const contradictionIds = new Set<string>();
  const contradictionFingerprints = new Set<string>();
  const observationIds = new Set<string>();
  const uniqueContradictions = contradictions.filter((signal, index) => {
    const duplicateReceipt = contradictionIds.has(signal.id)
      || contradictionFingerprints.has(receiptFingerprint(signal));
    if (duplicateReceipt || observationIds.has(signal.observation_id)) {
      issues.push(issue(
        duplicateReceipt ? 'DUPLICATE_RECEIPT' : 'DUPLICATE_OBSERVATION_ID',
        ['contradiction_signals', index, duplicateReceipt ? 'id' : 'observation_id'],
        duplicateReceipt ? 'Duplicate contradiction receipt was ignored.' : 'Duplicate observation does not add contradiction pressure.',
        'warning',
      ));
      return false;
    }
    contradictionIds.add(signal.id);
    contradictionFingerprints.add(receiptFingerprint(signal));
    observationIds.add(signal.observation_id);
    return true;
  });

  const decisionProjects = new Map<string, Set<string>>();
  for (const receipt of uniqueUses) {
    const projects = decisionProjects.get(receipt.decision_id) ?? new Set<string>();
    projects.add(receipt.project_id);
    decisionProjects.set(receipt.decision_id, projects);
  }
  for (const [decisionId, projects] of decisionProjects) {
    if (projects.size > 1) {
      issues.push(issue('USE_DECISION_SCOPE_CONFLICT', ['use_receipts'], `Decision ${decisionId} is claimed by multiple projects.`));
    }
  }
  for (const [index, receipt] of uniqueOutcomes.entries()) {
    if (!receipt.independently_attributable || (receipt.role !== 'decisive' && receipt.role !== 'supporting')) continue;
    const useReceipt = uniqueUses.find((use) => use.id === receipt.attribution_use_receipt_id);
    if (!useReceipt
      || useReceipt.belief_id !== receipt.belief_id
      || useReceipt.decision_id !== receipt.decision_id
      || useReceipt.role !== receipt.role) {
      issues.push(issue(
        'OUTCOME_USE_MISMATCH',
        ['outcome_receipts', index, 'attribution_use_receipt_id'],
        'Attributable outcome must match a same-belief, same-decision use receipt with the same decisive/supporting role.',
      ));
    }
  }

  if (issues.some((entry) => entry.severity === 'error')) return { ok: false, issues: sortIssues(issues) };

  const challengeCounts = { supported: 0, contradicted: 0, inconclusive: 0, unique_count: uniqueChallenges.length };
  for (const receipt of uniqueChallenges) challengeCounts[receipt.result] += 1;
  const attributedOutcomes = uniqueOutcomes.filter((receipt) =>
    receipt.independently_attributable && (receipt.role === 'decisive' || receipt.role === 'supporting'),
  );
  const outcomeCounts = { matched: 0, missed: 0, inconclusive: 0, independently_attributable_count: attributedOutcomes.length, ignored_count: uniqueOutcomes.length - attributedOutcomes.length };
  for (const receipt of attributedOutcomes) outcomeCounts[receipt.result] += 1;
  const severityWeight: Record<ContradictionSeverity, number> = { low: 0.15, medium: 0.3, high: 0.5 };
  const pressure = clamp(uniqueContradictions.reduce((total, signal) => total + severityWeight[signal.severity], 0));

  const latestChallenge = uniqueChallenges.reduce<number | undefined>((latest, receipt) => {
    const timestamp = parseIso(receipt.challenged_at)!;
    return latest === undefined || timestamp > latest ? timestamp : latest;
  }, undefined);
  const referenceTime = latestChallenge ?? updatedAt!;
  const effectiveInterval = interval;
  const derivedDeadline = referenceTime + effectiveInterval;
  const nextReviewTime = latestChallenge === undefined
    ? (reviewAfter ?? derivedDeadline)
    : Math.max(reviewAfter ?? Number.NEGATIVE_INFINITY, derivedDeadline);
  const elapsed = Math.max(0, now! - referenceTime);
  const freshnessWindow = Math.max(1, nextReviewTime - referenceTime);
  const freshnessScore = clamp(1 - elapsed / freshnessWindow);
  const applicabilityScore = input.applicability_score ?? 1;
  const applicabilityFloor = policy.applicability_floor ?? DEFAULT_APPLICABILITY_FLOOR;
  const applicable = applicabilityScore >= applicabilityFloor;
  const decisiveSupportingUses = uniqueUses.filter((receipt) => receipt.role === 'decisive' || receipt.role === 'supporting');
  const distinctProjects = new Set(decisiveSupportingUses.map((receipt) => receipt.project_id)).size;
  const projectThreshold = policy.worldview_distinct_project_threshold
    ?? policy.worldview_project_threshold
    ?? DEFAULT_WORLDVIEW_PROJECT_THRESHOLD;
  const useThreshold = policy.worldview_decisive_supporting_use_threshold
    ?? policy.worldview_use_threshold
    ?? DEFAULT_WORLDVIEW_USE_THRESHOLD;
  const worldviewAudit = distinctProjects >= projectThreshold && decisiveSupportingUses.length >= useThreshold;
  const normalizedUseBreadth = Math.min(1, decisiveSupportingUses.length / Math.max(1, useThreshold));
  const normalizedProjectBreadth = Math.min(1, distinctProjects / Math.max(1, projectThreshold));
  const influence = clamp(0.5 * normalizedUseBreadth + 0.5 * normalizedProjectBreadth);
  const reviewPriority = clamp(
    0.4 * (policy.risk_score ?? policy.risk ?? 0)
    + 0.3 * (policy.volatility_score ?? policy.volatility ?? 0)
    + 0.3 * influence,
  );

  const states: BeliefReviewState[] = [];
  const reasons: string[] = [];
  if (challengeCounts.contradicted > 0 || uniqueContradictions.length > 0 || outcomeCounts.missed > 0) {
    states.push('challenged');
    if (challengeCounts.contradicted > 0) reasons.push('A deliberate challenge contradicted the belief.');
    if (uniqueContradictions.length > 0) reasons.push('Distinct contradiction signals require review.');
    if (outcomeCounts.missed > 0) reasons.push('An independently attributable prediction missed its observed outcome.');
  }
  if (now! >= nextReviewTime) {
    if (now! >= nextReviewTime + effectiveInterval) {
      states.push('overdue');
      reasons.push('The effective review deadline has passed by at least one review interval.');
    } else {
      states.push('review_due');
      reasons.push(reviewAfter !== undefined && nextReviewTime === reviewAfter
        ? 'The explicit review deadline has arrived.'
        : 'The belief has reached the configured review interval without a newer deliberate challenge.');
    }
  }
  if (worldviewAudit) {
    states.push('worldview_audit');
    reasons.push('Independent decisive/supporting use spans the configured number of projects.');
  }
  if (influence >= highInfluenceThreshold && reviewAfter === undefined) {
    if (!states.includes('review_due')) states.push('review_due');
    reasons.push('High-influence belief has no explicit review deadline.');
  }
  if (states.length === 0) states.push('current');
  const stale = freshnessScore === 0 || states.includes('review_due') || states.includes('overdue');
  const ordinaryPriming = applicable
    ? clamp(Math.max(0.1, freshnessScore * applicabilityScore * (1 - pressure * 0.4)))
    : 0;
  const auditVisibility = states.some((state) => state !== 'current') ? 'full' : 'standard';

  return {
    ok: true,
    value: {
      belief_id: belief.id,
      historical_confidence: belief.confidence.score,
      status_unchanged: belief.status,
      authority_unchanged: belief.authority,
      support: {
        challenges: challengeCounts,
        outcomes: outcomeCounts,
        contradictions: { count: uniqueContradictions.length, pressure },
      },
      applicability_freshness: {
        applicability_score: applicabilityScore,
        applicability_floor: applicabilityFloor,
        applicable,
        freshness_score: freshnessScore,
        reference_at: new Date(referenceTime).toISOString(),
        stale,
      },
      influence_score: influence,
      review_priority_score: reviewPriority,
      ordinary_priming_factor: ordinaryPriming,
      review: { states, reasons, next_review_at: new Date(nextReviewTime).toISOString() },
      audit_visibility: auditVisibility,
    },
    issues: sortIssues(issues),
  };
}

const reviewOrder: Record<BeliefReviewState, number> = {
  challenged: 0,
  overdue: 1,
  worldview_audit: 2,
  review_due: 3,
  current: 4,
};

/** Produces a deterministic, read-only review queue; current beliefs are omitted. */
export function buildBeliefReviewQueue(
  projections: readonly BeliefMaintenanceProjection[],
): BeliefReviewQueueEntry[] {
  return projections
    .flatMap((projection) => {
      const states = projection.review.states.filter((state): state is Exclude<BeliefReviewState, 'current'> => state !== 'current');
      if (states.length === 0) return [];
      const state = [...states].sort((left, right) => reviewOrder[left] - reviewOrder[right])[0]!;
      return [{
        belief_id: projection.belief_id,
        state,
        reasons: [...projection.review.reasons],
        influence_score: projection.influence_score,
        review_priority_score: projection.review_priority_score,
        audit_visibility: 'full' as const,
      }];
    })
    .sort((left, right) =>
      reviewOrder[left.state] - reviewOrder[right.state]
      || right.influence_score - left.influence_score
      || compareStableText(left.belief_id, right.belief_id),
    );
}
