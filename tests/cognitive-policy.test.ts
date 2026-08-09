import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { DECAY_MATRIX_SEED, SCHEMA_SQL } from '../src/db.js';
import { COGNITIVE_SCHEMA_SQL } from '../src/cognitive/schema.js';
import {
  createPolicyCandidate,
  evaluatePolicyCandidate,
  findPolicyCandidates,
} from '../src/cognitive/policy.js';

function candidateInput(project_id: string, overrides: Partial<Parameters<typeof createPolicyCandidate>[1]> = {}) {
  return {
    project_id,
    title: `${project_id} canonical guidance`,
    statement: 'Search active exact-project canonical memory before graph expansion.',
    trigger_type: 'request_type',
    trigger_value: 'current_canonical_guidance',
    action: { search: 'active_exact_project_first', graph_expansion: 'on_related_context_request' },
    exclusions: ['historical audit', 'cross-project analogy'],
    verifier: { inactive_results: 0, cross_project_results: 0, canonical_present: true },
    task_id: `task-${project_id}`,
    ...overrides,
  };
}

describe('Cognitive policy projection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    db.exec(DECAY_MATRIX_SEED);
    db.exec(COGNITIVE_SCHEMA_SQL);
  });

  it('orders exact-project candidates ahead of matching global candidates and excludes rejected rows', () => {
    const global = createPolicyCandidate(db, candidateInput('_global'));
    const exact = createPolicyCandidate(db, candidateInput('project-a'));
    const rejected = createPolicyCandidate(db, candidateInput('project-a', { title: 'rejected', task_id: 'reject' }));
    db.prepare("UPDATE policy_candidates SET status = 'rejected' WHERE policy_id = ?").run(rejected.policy_id);

    const candidates = findPolicyCandidates(db, {
      project_id: 'project-a',
      trigger_type: 'request_type',
      trigger_value: 'current_canonical_guidance',
    });
    expect(candidates.map((candidate) => candidate.policy_id)).toEqual([exact.policy_id, global.policy_id]);
  });

  it('records each evaluation, guardrail metrics, and counters without promoting the candidate', () => {
    const policy = createPolicyCandidate(db, candidateInput('project-a'));
    evaluatePolicyCandidate(db, {
      policy_id: policy.policy_id,
      project_id: 'project-a',
      task_id: 'evaluation-1',
      outcome: 'succeeded',
      metrics: { inactive_results: 0, canonical_present: true },
      guardrail_regression: false,
    });
    evaluatePolicyCandidate(db, {
      policy_id: policy.policy_id,
      project_id: 'project-a',
      task_id: 'evaluation-2',
      outcome: 'failed',
      metrics: { cross_project_results: 1, reason: 'contamination' },
      guardrail_regression: true,
    });
    const result = evaluatePolicyCandidate(db, {
      policy_id: policy.policy_id,
      project_id: 'project-a',
      task_id: 'evaluation-3',
      outcome: 'inconclusive',
      metrics: { canonical_present: null },
      guardrail_regression: false,
    });

    expect(result).toMatchObject({
      status: 'candidate',
      evaluation_count: 3,
      success_count: 1,
      failure_count: 1,
      inconclusive_count: 1,
    });
    const evaluations = db
      .prepare('SELECT metrics_json, guardrail_regression FROM policy_evaluations ORDER BY task_id')
      .all() as Array<{ metrics_json: string; guardrail_regression: number }>;
    expect(evaluations).toHaveLength(3);
    expect(evaluations[1]).toEqual({
      metrics_json: '{"cross_project_results":1,"reason":"contamination"}',
      guardrail_regression: 1,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM cognitive_events WHERE event_type = 'PolicyEvaluated'").get(),
    ).toEqual({ count: 3 });
  });

  it('uses idempotency keys without duplicating candidates or evidence', () => {
    const input = candidateInput('project-a', { idempotency_key: 'candidate-once' });
    const first = createPolicyCandidate(db, input);
    const again = createPolicyCandidate(db, input);
    expect(again.policy_id).toBe(first.policy_id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM policy_candidates').get()).toEqual({ count: 1 });

    const evaluation = {
      policy_id: first.policy_id,
      project_id: 'project-a',
      task_id: 'evaluation-once',
      outcome: 'succeeded' as const,
      metrics: { canonical_present: true },
      guardrail_regression: false,
      correlation_id: 'correlation-evaluation-once',
      causation_id: 'causation-policy-retrieved',
      idempotency_key: 'evaluation-once',
    };
    evaluatePolicyCandidate(db, evaluation);
    const result = evaluatePolicyCandidate(db, evaluation);
    expect(result).toMatchObject({ evaluation_count: 1, success_count: 1, status: 'candidate' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM policy_evaluations').get()).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT correlation_id, causation_id FROM cognitive_events WHERE event_type = 'PolicyEvaluated'",
        )
        .get(),
    ).toEqual({
      correlation_id: 'correlation-evaluation-once',
      causation_id: 'causation-policy-retrieved',
    });
    expect(() =>
      evaluatePolicyCandidate(db, {
        ...evaluation,
        causation_id: 'changed-causation',
      }),
    ).toThrow('Idempotency key was already used with different cognitive event content');
  });

  it('rejects a project mismatch before emitting an evaluation event', () => {
    const policy = createPolicyCandidate(db, candidateInput('project-a'));
    expect(() =>
      evaluatePolicyCandidate(db, {
        policy_id: policy.policy_id,
        project_id: 'project-b',
        task_id: 'wrong-project',
        outcome: 'failed',
        metrics: {},
        guardrail_regression: true,
      }),
    ).toThrow('does not belong to project');
    expect(db.prepare("SELECT COUNT(*) AS count FROM cognitive_events WHERE event_type = 'PolicyEvaluated'").get()).toEqual({
      count: 0,
    });
  });

  it('rolls back the creation event when candidate projection insertion fails', () => {
    db.exec(`
      CREATE TRIGGER fail_policy_projection
      BEFORE INSERT ON policy_candidates
      BEGIN SELECT RAISE(ABORT, 'projection failure'); END;
    `);
    expect(() => createPolicyCandidate(db, candidateInput('project-a'))).toThrow('projection failure');
    expect(db.prepare('SELECT COUNT(*) AS count FROM policy_candidates').get()).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM cognitive_events WHERE event_type = 'PolicyCandidateCreated'").get(),
    ).toEqual({ count: 0 });
  });
});
