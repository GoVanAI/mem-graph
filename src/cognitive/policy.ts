import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { appendCognitiveEvent } from './events.js';
import type {
  CreatePolicyCandidateInput,
  EvaluatePolicyInput,
  PolicyCandidate,
  PolicyEvaluationOutcome,
  PolicyStatus,
} from './types.js';

export interface FindPolicyCandidatesInput {
  project_id: string;
  trigger_type: string;
  trigger_value: string;
  limit?: number;
}

interface PolicyRow {
  policy_id: string;
  project_id: string;
  title: string;
  statement: string;
  trigger_type: string;
  trigger_value: string;
  action_json: string;
  exclusions_json: string;
  verifier_json: string;
  status: PolicyStatus;
  evaluation_count: number;
  success_count: number;
  failure_count: number;
  inconclusive_count: number;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

const POLICY_STATUSES: readonly PolicyStatus[] = ['candidate', 'strengthened', 'revised', 'rejected'];
const EVALUATION_OUTCOMES: readonly PolicyEvaluationOutcome[] = [
  'succeeded',
  'failed',
  'inconclusive',
];

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function requireRecord(value: Record<string, unknown>, field: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON values must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('JSON values must not be undefined, bigint, or functions');
}

function idFor(prefix: string, idempotencyKey?: string): string {
  if (!idempotencyKey) return `${prefix}-${randomUUID()}`;
  return `${prefix}-${createHash('sha256').update(idempotencyKey).digest('hex')}`;
}

function mapPolicy(row: PolicyRow): PolicyCandidate {
  if (!POLICY_STATUSES.includes(row.status)) throw new Error(`Unknown policy status: ${row.status}`);
  return {
    policy_id: row.policy_id,
    project_id: row.project_id,
    title: row.title,
    statement: row.statement,
    trigger_type: row.trigger_type,
    trigger_value: row.trigger_value,
    action: JSON.parse(row.action_json) as Record<string, unknown>,
    exclusions: JSON.parse(row.exclusions_json) as string[],
    verifier: JSON.parse(row.verifier_json) as Record<string, unknown>,
    status: row.status,
    evaluation_count: row.evaluation_count,
    success_count: row.success_count,
    failure_count: row.failure_count,
    inconclusive_count: row.inconclusive_count,
    source_event_id: row.source_event_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function readPolicy(db: Database.Database, policyId: string): PolicyCandidate {
  const row = db
    .prepare('SELECT * FROM policy_candidates WHERE policy_id = ?')
    .get(policyId) as PolicyRow | undefined;
  if (!row) throw new Error(`Policy candidate not found: ${policyId}`);
  return mapPolicy(row);
}

function validateCreateInput(input: CreatePolicyCandidateInput): void {
  requireNonEmpty(input.project_id, 'project_id');
  requireNonEmpty(input.title, 'title');
  requireNonEmpty(input.statement, 'statement');
  requireNonEmpty(input.trigger_type, 'trigger_type');
  requireNonEmpty(input.trigger_value, 'trigger_value');
  requireNonEmpty(input.task_id, 'task_id');
  requireRecord(input.action, 'action');
  requireRecord(input.verifier, 'verifier');
  if (!Array.isArray(input.exclusions) || input.exclusions.some((item) => typeof item !== 'string')) {
    throw new Error('exclusions must be an array of strings');
  }
}

/**
 * Persist a candidate and its ledger event as one transaction. Candidate status
 * deliberately starts at `candidate`; evaluation is evidence collection, not promotion.
 */
export function createPolicyCandidate(
  db: Database.Database,
  input: CreatePolicyCandidateInput,
): PolicyCandidate {
  validateCreateInput(input);
  const policyId = idFor('policy', input.idempotency_key);
  const actionJson = stableJson(input.action);
  const exclusionsJson = stableJson(input.exclusions);
  const verifierJson = stableJson(input.verifier);

  return db.transaction(() => {
    const event = appendCognitiveEvent(db, {
      event_type: 'PolicyCandidateCreated',
      task_id: input.task_id,
      project_id: input.project_id,
      session_id: input.session_id,
      idempotency_key: input.idempotency_key,
      payload: {
        policy_id: policyId,
        title: input.title,
        statement: input.statement,
        trigger_type: input.trigger_type,
        trigger_value: input.trigger_value,
        action: JSON.parse(actionJson) as Record<string, unknown>,
        exclusions: JSON.parse(exclusionsJson) as string[],
        verifier: JSON.parse(verifierJson) as Record<string, unknown>,
      },
    });

    const existing = db
      .prepare('SELECT * FROM policy_candidates WHERE source_event_id = ?')
      .get(event.event_id) as PolicyRow | undefined;
    if (existing) return mapPolicy(existing);

    db.prepare(
      `INSERT INTO policy_candidates (
        policy_id, project_id, title, statement, trigger_type, trigger_value,
        action_json, exclusions_json, verifier_json, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      policyId,
      input.project_id,
      input.title,
      input.statement,
      input.trigger_type,
      input.trigger_value,
      actionJson,
      exclusionsJson,
      verifierJson,
      event.event_id,
    );
    return readPolicy(db, policyId);
  })();
}

/** Return matching active candidates, with exact project scope preceding `_global`. */
export function findPolicyCandidates(
  db: Database.Database,
  input: FindPolicyCandidatesInput,
): PolicyCandidate[] {
  requireNonEmpty(input.project_id, 'project_id');
  requireNonEmpty(input.trigger_type, 'trigger_type');
  requireNonEmpty(input.trigger_value, 'trigger_value');
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('limit must be an integer between 1 and 500');
  }

  const rows = db
    .prepare(
      `SELECT * FROM policy_candidates
       WHERE project_id IN (?, '_global')
         AND trigger_type = ?
         AND trigger_value = ?
         AND status != 'rejected'
       ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END,
                updated_at DESC,
                policy_id ASC
       LIMIT ?`,
    )
    .all(input.project_id, input.trigger_type, input.trigger_value, input.project_id, limit) as PolicyRow[];
  return rows.map(mapPolicy);
}

function validateEvaluationInput(input: EvaluatePolicyInput): void {
  requireNonEmpty(input.policy_id, 'policy_id');
  requireNonEmpty(input.task_id, 'task_id');
  requireNonEmpty(input.project_id, 'project_id');
  if (!EVALUATION_OUTCOMES.includes(input.outcome)) throw new Error(`Unknown evaluation outcome: ${input.outcome}`);
  requireRecord(input.metrics, 'metrics');
  for (const value of Object.values(input.metrics)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('metrics values must be finite');
    }
    if (value !== null && !['number', 'boolean', 'string'].includes(typeof value)) {
      throw new Error('metrics values must be strings, numbers, booleans, or null');
    }
  }
}

/**
 * Record evidence for an existing candidate. This intentionally never changes
 * `status`: promotion or authority expansion remains an explicit future action.
 */
export function evaluatePolicyCandidate(
  db: Database.Database,
  input: EvaluatePolicyInput,
): PolicyCandidate {
  validateEvaluationInput(input);
  const evaluationId = idFor('evaluation', input.idempotency_key);
  const metricsJson = stableJson(input.metrics);

  return db.transaction(() => {
    const policy = readPolicy(db, input.policy_id);
    if (policy.project_id !== input.project_id) {
      throw new Error(`Policy ${input.policy_id} does not belong to project ${input.project_id}`);
    }

    const event = appendCognitiveEvent(db, {
      event_type: 'PolicyEvaluated',
      task_id: input.task_id,
      project_id: input.project_id,
      session_id: input.session_id,
      correlation_id: input.correlation_id,
      causation_id: input.causation_id,
      idempotency_key: input.idempotency_key,
      payload: {
        policy_id: input.policy_id,
        evaluation_id: evaluationId,
        outcome: input.outcome,
        metrics: JSON.parse(metricsJson) as Record<string, number | boolean | string | null>,
        guardrail_regression: input.guardrail_regression,
      },
    });

    const existing = db
      .prepare('SELECT 1 FROM policy_evaluations WHERE source_event_id = ?')
      .get(event.event_id);
    if (existing) return readPolicy(db, input.policy_id);

    db.prepare(
      `INSERT INTO policy_evaluations (
        evaluation_id, policy_id, project_id, task_id, outcome, metrics_json,
        guardrail_regression, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      evaluationId,
      input.policy_id,
      input.project_id,
      input.task_id,
      input.outcome,
      metricsJson,
      input.guardrail_regression ? 1 : 0,
      event.event_id,
    );

    const counter =
      input.outcome === 'succeeded'
        ? 'success_count'
        : input.outcome === 'failed'
          ? 'failure_count'
          : 'inconclusive_count';
    db.prepare(
      `UPDATE policy_candidates
       SET evaluation_count = evaluation_count + 1,
           ${counter} = ${counter} + 1,
           updated_at = datetime('now')
       WHERE policy_id = ?`,
    ).run(input.policy_id);
    return readPolicy(db, input.policy_id);
  })();
}
