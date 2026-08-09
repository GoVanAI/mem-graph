/**
 * Per-event-type payload contracts for the Cognitive OS event ledger.
 *
 * Per EPB-001 D3 and [[283]] Step 3: every new admission is structurally and
 * semantically validated against the contract registered for its event_type.
 * Malformed payloads fail closed with a stable uppercase error code.
 *
 * Scope note: validators apply to NEW admissions only. Existing rows in
 * `cognitive_events` are immutable per the append-only triggers; legacy
 * payloads written before a contract existed are auditable via
 * `auditCognitiveEventShapes` but are not rejected retroactively. This
 * preserves [[283]] Locked Invariant #2 (existing event history remains
 * readable and hash-verifiable without rewrite).
 *
 * Stable error codes used here:
 *   INVALID_EVENT_VERSION       — payload `schema_version` not supported
 *   MISSING_REQUIRED_FIELD      — required field absent or empty
 *   INVALID_FIELD_TYPE          — field has wrong primitive type
 *   INVALID_FIELD_VALUE         — field value out of allowed set
 *   INVALID_CAUSATION_SHAPE     — causation_id present but malformed
 *   INVALID_REVISION_REFERENCE  — BeliefRevised without prior reference when required
 *   INVALID_PROVENANCE_SHAPE    — EvidenceObserved missing source_event_id reference
 */

import type { CognitiveEventType } from './types.js';

export interface ValidationFailure {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  failures: ValidationFailure[];
}

export type PayloadValidator = (payload: unknown) => ValidationResult;

/** Helper: require a non-empty string field at `path`. */
function requireString(payload: Record<string, unknown>, path: string): ValidationFailure | null {
  const v = payload[path];
  if (typeof v !== 'string' || v.length === 0) {
    return { code: 'MISSING_REQUIRED_FIELD', path, message: `${path} must be a non-empty string` };
  }
  return null;
}

/** Helper: require an optional string field at `path` (when present). */
function optionalString(payload: Record<string, unknown>, path: string): ValidationFailure | null {
  const v = payload[path];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    return { code: 'INVALID_FIELD_TYPE', path, message: `${path} must be a string when provided` };
  }
  return null;
}

/**
 * BeliefRevised payload — per v0.4 stale-belief semantics.
 * A revision MUST reference either a prior revision_id (for chain) or be a
 * genesis revision for a record_id, never both. record_id is required.
 */
const beliefRevisedValidator: PayloadValidator = (payload) => {
  const failures: ValidationFailure[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    failures.push({ code: 'INVALID_FIELD_TYPE', path: '$', message: 'payload must be a JSON object' });
    return { ok: false, failures };
  }
  const p = payload as Record<string, unknown>;

  const recordId = requireString(p, 'record_id');
  if (recordId) failures.push(recordId);

  // Optional: previous_revision_id (UUID) OR genesis:true marker
  const prev = p['previous_revision_id'];
  const genesis = p['genesis'];
  if (prev === undefined && genesis !== true) {
    failures.push({
      code: 'INVALID_REVISION_REFERENCE',
      path: '$',
      message: 'BeliefRevised must set previous_revision_id OR genesis=true',
    });
  }
  if (prev !== undefined && (typeof prev !== 'string' || prev.length === 0)) {
    failures.push({ code: 'INVALID_FIELD_TYPE', path: 'previous_revision_id', message: 'previous_revision_id must be a non-empty string when provided' });
  }
  if (genesis !== undefined && genesis !== true) {
    failures.push({ code: 'INVALID_FIELD_VALUE', path: 'genesis', message: 'genesis must be true when provided' });
  }

  // confidence is required and finite, range 0..1
  const conf = p['confidence'];
  if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
    failures.push({ code: 'INVALID_FIELD_TYPE', path: 'confidence', message: 'confidence must be a finite number in [0,1]' });
  }

  // statement is required
  const stmt = requireString(p, 'statement');
  if (stmt) failures.push(stmt);

  // epistemic_status must be from the canonical set (matches DB CHECK)
  const status = p['epistemic_status'];
  const allowed = ['verified', 'corroborated', 'inferred', 'reported', 'assumed', 'contested', 'stale', 'retracted'];
  if (typeof status !== 'string' || !allowed.includes(status)) {
    failures.push({
      code: 'INVALID_FIELD_VALUE',
      path: 'epistemic_status',
      message: `epistemic_status must be one of ${allowed.join(', ')}`,
    });
  }

  // Optional: scope ('exact-project' | '_global')
  const scope = optionalString(p, 'scope');
  if (scope) failures.push(scope);
  else if (p['scope'] !== undefined) {
    const s = p['scope'];
    if (s !== 'exact-project' && s !== '_global') {
      failures.push({
        code: 'INVALID_FIELD_VALUE',
        path: 'scope',
        message: "scope must be 'exact-project' or '_global' when provided",
      });
    }
  }

  return { ok: failures.length === 0, failures };
};

/**
 * EvidenceObserved payload — references a prior cognitive event or memory
 * that supplied the evidence. source_event_id is required; source_memory_id
 * is optional. The event MUST NOT be its own source.
 */
const evidenceObservedValidator: PayloadValidator = (payload) => {
  const failures: ValidationFailure[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    failures.push({ code: 'INVALID_FIELD_TYPE', path: '$', message: 'payload must be a JSON object' });
    return { ok: false, failures };
  }
  const p = payload as Record<string, unknown>;

  // Either source_event_id (FK to cognitive_events.event_id) OR
  // source_memory_id (FK to memories.id) must be present.
  const hasEventId = typeof p['source_event_id'] === 'string' && p['source_event_id'].length > 0;
  const hasMemoryId = typeof p['source_memory_id'] === 'number' && Number.isInteger(p['source_memory_id']);
  if (!hasEventId && !hasMemoryId) {
    failures.push({
      code: 'INVALID_PROVENANCE_SHAPE',
      path: '$',
      message: 'EvidenceObserved requires source_event_id (string) or source_memory_id (integer)',
    });
  }
  if (p['source_event_id'] !== undefined && !hasEventId) {
    failures.push({
      code: 'INVALID_FIELD_TYPE',
      path: 'source_event_id',
      message: 'source_event_id must be a non-empty string when provided',
    });
  }
  if (p['source_memory_id'] !== undefined && !hasMemoryId) {
    failures.push({
      code: 'INVALID_FIELD_TYPE',
      path: 'source_memory_id',
      message: 'source_memory_id must be an integer when provided',
    });
  }

  // Optional excerpt_hash
  const excerptHash = optionalString(p, 'excerpt_hash');
  if (excerptHash) failures.push(excerptHash);

  // Optional confidence (0..1)
  if (p['confidence'] !== undefined) {
    const conf = p['confidence'];
    if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
      failures.push({
        code: 'INVALID_FIELD_TYPE',
        path: 'confidence',
        message: 'confidence must be a finite number in [0,1] when provided',
      });
    }
  }

  return { ok: failures.length === 0, failures };
};

/**
 * DecisionMade payload — Phase B uses the existing decision event shape.
 * Requires a title, statement, and a stable decision_id reference for
 * future attribution.
 */
const decisionMadeValidator: PayloadValidator = (payload) => {
  const failures: ValidationFailure[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    failures.push({ code: 'INVALID_FIELD_TYPE', path: '$', message: 'payload must be a JSON object' });
    return { ok: false, failures };
  }
  const p = payload as Record<string, unknown>;

  const title = requireString(p, 'title');
  if (title) failures.push(title);
  const statement = requireString(p, 'statement');
  if (statement) failures.push(statement);

  return { ok: failures.length === 0, failures };
};

/**
 * ExecutionObserved payload — minimal: the executed action's outcome must be
 * one of the canonical strings. Used as a stand-in for richer telemetry
 * until Slice 3.
 */
const executionObservedValidator: PayloadValidator = (payload) => {
  const failures: ValidationFailure[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    failures.push({ code: 'INVALID_FIELD_TYPE', path: '$', message: 'payload must be a JSON object' });
    return { ok: false, failures };
  }
  const p = payload as Record<string, unknown>;
  const outcome = p['outcome'];
  const allowed = ['succeeded', 'failed', 'inconclusive'];
  if (typeof outcome !== 'string' || !allowed.includes(outcome)) {
    failures.push({
      code: 'INVALID_FIELD_VALUE',
      path: 'outcome',
      message: `outcome must be one of ${allowed.join(', ')}`,
    });
  }
  return { ok: failures.length === 0, failures };
};

/**
 * ReflectionProposed — admits a candidate reflection or open question
 * without making it governing.
 */
const reflectionProposedValidator: PayloadValidator = (payload) => {
  const failures: ValidationFailure[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    failures.push({ code: 'INVALID_FIELD_TYPE', path: '$', message: 'payload must be a JSON object' });
    return { ok: false, failures };
  }
  const p = payload as Record<string, unknown>;
  const kind = p['kind'];
  const allowed = ['reflection', 'open_question', 'pattern'];
  if (typeof kind !== 'string' || !allowed.includes(kind)) {
    failures.push({
      code: 'INVALID_FIELD_VALUE',
      path: 'kind',
      message: `kind must be one of ${allowed.join(', ')}`,
    });
  }
  const text = requireString(p, 'text');
  if (text) failures.push(text);
  return { ok: failures.length === 0, failures };
};

/**
 * PolicyCandidateCreated — wraps the policy_candidates table content.
 * statement, trigger_type, trigger_value are required; action and exclusions
 * are optional structured fields.
 */
const policyCandidateCreatedValidator: PayloadValidator = (payload) => {
  const failures: ValidationFailure[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    failures.push({ code: 'INVALID_FIELD_TYPE', path: '$', message: 'payload must be a JSON object' });
    return { ok: false, failures };
  }
  const p = payload as Record<string, unknown>;

  const title = requireString(p, 'title');
  if (title) failures.push(title);
  const statement = requireString(p, 'statement');
  if (statement) failures.push(statement);
  const triggerType = requireString(p, 'trigger_type');
  if (triggerType) failures.push(triggerType);
  const triggerValue = requireString(p, 'trigger_value');
  if (triggerValue) failures.push(triggerValue);

  return { ok: failures.length === 0, failures };
};

/**
 * PolicyRetrieved — admits retrieval of a candidate policy by trigger lookup.
 */
const policyRetrievedValidator: PayloadValidator = (payload) => {
  const failures: ValidationFailure[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    failures.push({ code: 'INVALID_FIELD_TYPE', path: '$', message: 'payload must be a JSON object' });
    return { ok: false, failures };
  }
  const p = payload as Record<string, unknown>;

  const triggerType = requireString(p, 'trigger_type');
  if (triggerType) failures.push(triggerType);
  const triggerValue = requireString(p, 'trigger_value');
  if (triggerValue) failures.push(triggerValue);

  return { ok: failures.length === 0, failures };
};

/**
 * PolicyEvaluated — outcome + metrics required.
 */
const policyEvaluatedValidator: PayloadValidator = (payload) => {
  const failures: ValidationFailure[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    failures.push({ code: 'INVALID_FIELD_TYPE', path: '$', message: 'payload must be a JSON object' });
    return { ok: false, failures };
  }
  const p = payload as Record<string, unknown>;

  const policyId = requireString(p, 'policy_id');
  if (policyId) failures.push(policyId);

  const outcome = p['outcome'];
  const allowed = ['succeeded', 'failed', 'inconclusive'];
  if (typeof outcome !== 'string' || !allowed.includes(outcome)) {
    failures.push({
      code: 'INVALID_FIELD_VALUE',
      path: 'outcome',
      message: `outcome must be one of ${allowed.join(', ')}`,
    });
  }

  if (p['guardrail_regression'] !== undefined && typeof p['guardrail_regression'] !== 'boolean') {
    failures.push({
      code: 'INVALID_FIELD_TYPE',
      path: 'guardrail_regression',
      message: 'guardrail_regression must be a boolean when provided',
    });
  }

  return { ok: failures.length === 0, failures };
};

/**
 * The contract registry. Each event type maps to exactly one validator.
 * Tests may register alternative validators via `registerEventContract`,
 * but production code MUST NOT swap contracts at runtime.
 */
export const EVENT_CONTRACTS: Readonly<Record<CognitiveEventType, PayloadValidator>> = {
  DecisionMade: decisionMadeValidator,
  ExecutionObserved: executionObservedValidator,
  EvidenceObserved: evidenceObservedValidator,
  BeliefRevised: beliefRevisedValidator,
  ReflectionProposed: reflectionProposedValidator,
  PolicyCandidateCreated: policyCandidateCreatedValidator,
  PolicyRetrieved: policyRetrievedValidator,
  PolicyEvaluated: policyEvaluatedValidator,
};

/** Validate a payload for the given event type. */
export function validateCognitiveEventPayload(
  eventType: CognitiveEventType,
  payload: unknown,
): ValidationResult {
  const validator = EVENT_CONTRACTS[eventType];
  if (!validator) {
    return {
      ok: false,
      failures: [{ code: 'INVALID_EVENT_VERSION', path: '$', message: `Unknown event type: ${eventType}` }],
    };
  }
  return validator(payload);
}

/**
 * Schema versions supported per event type. v1 is the legacy opaque-payload
 * shape; v2 introduces the typed contracts above. Future versions append.
 */
export const SUPPORTED_SCHEMA_VERSIONS: ReadonlyArray<number> = [1, 2];

export function isSupportedSchemaVersion(version: number): boolean {
  return SUPPORTED_SCHEMA_VERSIONS.includes(version);
}
