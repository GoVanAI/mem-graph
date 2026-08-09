import { describe, expect, it } from 'vitest';
import {
  buildBeliefReviewQueue,
  projectBeliefMaintenance,
  type BeliefReviewPolicy,
  type ChallengeReceipt,
  type ContradictionSignal,
  type DecisionOutcomeReceipt,
  type BeliefUseReceipt,
} from '../src/epistemic/maintenance.js';
import type { EpistemicRecord, ProvenanceRef } from '../src/epistemic/types.js';

const provenance: ProvenanceRef[] = [{
  source_type: 'synthetic_fixture',
  source_ref: 'maintenance-fixture',
  observed_at: '2026-01-01T00:00:00.000Z',
}];

function belief(overrides: Partial<EpistemicRecord> = {}): EpistemicRecord {
  return {
    schema_version: '0.3',
    id: 'belief.maintenance.001',
    type: 'belief',
    assertion_kind: 'predictive',
    statement: 'The synthetic classifier will preserve the stable label.',
    scope: { project: 'synthetic-lab' },
    provenance,
    confidence: {
      score: 0.72,
      band: 'medium',
      basis: ['STRONG_INFERENCE'],
      rationale: 'Synthetic tests have consistent but incomplete support.',
    },
    status: 'active',
    authority: 'informational',
    relations: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function policy(overrides: Partial<BeliefReviewPolicy> = {}): BeliefReviewPolicy {
  return {
    belief_id: 'belief.maintenance.001',
    scope: { project: 'synthetic-lab' },
    review_interval_ms: 10 * 24 * 60 * 60 * 1000,
    high_influence_threshold: 0.7,
    worldview_distinct_project_threshold: 2,
    worldview_decisive_supporting_use_threshold: 2,
    applicability_floor: 0.5,
    ...overrides,
  };
}

function challenge(overrides: Partial<ChallengeReceipt> = {}): ChallengeReceipt {
  return {
    id: 'challenge.001',
    belief_id: 'belief.maintenance.001',
    prediction_or_claim: 'The label remains stable.',
    falsifier: 'A controlled run produces a different label.',
    method: 'Run a synthetic control set.',
    result: 'supported',
    challenged_at: '2026-01-05T00:00:00.000Z',
    provenance,
    independence_key: 'control-set-a',
    ...overrides,
  };
}

function use(overrides: Partial<BeliefUseReceipt> = {}): BeliefUseReceipt {
  return {
    id: 'use.001',
    belief_id: 'belief.maintenance.001',
    decision_id: 'decision.synthetic.001',
    project_id: 'synthetic-lab-a',
    used_at: '2026-01-05T00:00:00.000Z',
    role: 'supporting',
    provenance,
    independence_key: 'use-a',
    ...overrides,
  };
}

function outcome(overrides: Partial<DecisionOutcomeReceipt> = {}): DecisionOutcomeReceipt {
  return {
    id: 'outcome.001',
    belief_id: 'belief.maintenance.001',
    decision_id: 'decision.synthetic.001',
    predicted_result: 'The stable label will be retained.',
    predicted_at: '2026-01-04T00:00:00.000Z',
    observed_result: 'The stable label was retained.',
    role: 'supporting',
    result: 'matched',
    observed_at: '2026-01-05T00:00:00.000Z',
    provenance,
    independence_key: 'outcome-a',
    independently_attributable: true,
    attribution_use_receipt_id: 'use.001',
    ...overrides,
  };
}

function contradiction(overrides: Partial<ContradictionSignal> = {}): ContradictionSignal {
  return {
    id: 'contradiction.001',
    belief_id: 'belief.maintenance.001',
    observation_id: 'observation.synthetic.001',
    rationale: 'The synthetic observation challenges the predicted stable label.',
    severity: 'high',
    signaled_at: '2026-01-05T00:00:00.000Z',
    provenance,
    ...overrides,
  };
}

describe('projectBeliefMaintenance', () => {
  it('distinguishes an arrived deadline from an overdue review deadline', () => {
    const due = projectBeliefMaintenance({
      belief: belief(),
      policy: policy({ review_after: '2026-01-10T00:00:00.000Z' }),
      now: '2026-01-10T00:00:00.000Z',
    });
    const overdue = projectBeliefMaintenance({
      belief: belief(),
      policy: policy({ review_after: '2026-01-10T00:00:00.000Z' }),
      now: '2026-01-21T00:00:00.000Z',
    });

    expect(due).toMatchObject({ ok: true, value: { review: { states: ['review_due'] }, audit_visibility: 'full' } });
    expect(overdue).toMatchObject({ ok: true, value: { review: { states: ['overdue'] }, audit_visibility: 'full' } });
  });

  it('does not mark a belief due before an explicit future review deadline', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy({ review_after: '2026-01-20T00:00:00.000Z', review_interval_ms: 24 * 60 * 60 * 1000 }),
      now: '2026-01-10T00:00:00.000Z',
    });

    expect(result).toMatchObject({ ok: true, value: { review: { states: ['current'] } } });
  });

  it('requires independent, deliberate challenge receipts and never double-counts them', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy(),
      now: '2026-01-06T00:00:00.000Z',
      challenge_receipts: [
        challenge(),
        challenge({ id: 'challenge.duplicate-key', result: 'contradicted' }),
        challenge({ id: 'challenge.independent', result: 'contradicted', independence_key: 'control-set-b' }),
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { support: { challenges: { supported: 1, contradicted: 1, unique_count: 2 } } },
    });
    expect(result.issues.map((entry) => entry.code)).toContain('DUPLICATE_RECEIPT');
  });

  it('moves the effective review deadline forward from the latest deliberate challenge', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy(),
      now: '2026-01-12T00:00:00.000Z',
      challenge_receipts: [challenge()],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { review: { states: ['current'], next_review_at: '2026-01-15T00:00:00.000Z' } },
    });
  });

  it('only includes independently attributable decisive or supporting outcomes in calibration summaries', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy(),
      now: '2026-01-06T00:00:00.000Z',
      use_receipts: [use()],
      outcome_receipts: [
        outcome(),
        outcome({ id: 'outcome.context', role: 'contextual', result: 'missed', independence_key: 'context-a' }),
        outcome({ id: 'outcome.unattributable', independently_attributable: false, result: 'missed', independence_key: 'unattributable-a' }),
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        historical_confidence: 0.72,
        support: { outcomes: { matched: 1, missed: 0, independently_attributable_count: 1, ignored_count: 2 } },
      },
    });
  });

  it('queues review when an independently attributable prediction misses', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy(),
      now: '2026-01-06T00:00:00.000Z',
      use_receipts: [use()],
      outcome_receipts: [outcome({ result: 'missed' })],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { review: { states: ['challenged'] }, audit_visibility: 'full' },
    });
  });

  it('queues distinct contradiction signals without mutating status or authority', () => {
    const source = belief({ status: 'conditional', authority: 'advisory', conditions: ['The synthetic source remains version-matched.'] });
    const result = projectBeliefMaintenance({
      belief: source,
      policy: policy(),
      now: '2026-01-06T00:00:00.000Z',
      contradiction_signals: [contradiction(), contradiction({ id: 'contradiction.same-observation' })],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        status_unchanged: 'conditional',
        authority_unchanged: 'advisory',
        support: { contradictions: { count: 1, pressure: 0.5 } },
        review: { states: ['challenged'] },
      },
    });
    expect(buildBeliefReviewQueue([result.value!])).toMatchObject([{ state: 'challenged', audit_visibility: 'full' }]);
  });

  it('separates deterministic freshness decay from historical confidence and leaves a stale belief eligible for ordinary priming', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy({ review_interval_ms: 24 * 60 * 60 * 1000 }),
      now: '2026-01-10T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        historical_confidence: 0.72,
        applicability_freshness: { freshness_score: 0, stale: true },
        ordinary_priming_factor: 0.1,
        audit_visibility: 'full',
      },
    });
  });

  it('applies the applicability floor without changing audit semantics', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy({ review_after: '2026-01-02T00:00:00.000Z' }),
      now: '2026-01-03T00:00:00.000Z',
      applicability_score: 0.49,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        applicability_freshness: { applicable: false, applicability_floor: 0.5 },
        ordinary_priming_factor: 0,
        audit_visibility: 'full',
      },
    });
  });

  it('opens worldview audit from explicit independent project uses, never retrieval frequency', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy(),
      now: '2026-01-06T00:00:00.000Z',
      use_receipts: [use(), use({ id: 'use.002', decision_id: 'decision.synthetic.002', project_id: 'synthetic-lab-b', role: 'decisive', independence_key: 'use-b' })],
    });

    expect(result).toMatchObject({ ok: true, value: { review: { states: ['worldview_audit', 'review_due'] }, audit_visibility: 'full' } });
  });

  it('does not count contextual projects toward worldview influence', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy(),
      now: '2026-01-06T00:00:00.000Z',
      use_receipts: [
        use({ role: 'contextual' }),
        use({ id: 'use.002', decision_id: 'decision.synthetic.002', project_id: 'synthetic-lab-b', role: 'contextual', independence_key: 'use-b' }),
      ],
    });

    expect(result.value?.review.states).not.toContain('worldview_audit');
  });

  it('rejects cross-belief and future-dated receipts plus hindsight prediction timestamps', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy(),
      now: '2026-01-06T00:00:00.000Z',
      challenge_receipts: [challenge({ belief_id: 'belief.other.001', challenged_at: '2026-01-07T00:00:00.000Z' })],
      use_receipts: [use()],
      outcome_receipts: [outcome({ predicted_at: '2026-01-06T01:00:00.000Z', observed_at: '2026-01-06T00:00:00.000Z' })],
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'RECEIPT_BELIEF_MISMATCH', 'TIMESTAMP_IN_FUTURE', 'TIMESTAMP_ORDER_INVALID',
    ]));
  });

  it('keeps the ordinary priming safety floor under maximum contradiction pressure', () => {
    const result = projectBeliefMaintenance({
      belief: belief(),
      policy: policy({ review_interval_ms: 24 * 60 * 60 * 1000 }),
      now: '2026-01-10T00:00:00.000Z',
      contradiction_signals: [
        contradiction(),
        contradiction({ id: 'contradiction.002', observation_id: 'observation.synthetic.002' }),
      ],
    });

    expect(result.value?.support.contradictions.pressure).toBe(1);
    expect(result.value?.ordinary_priming_factor).toBe(0.1);
    expect(result.value?.audit_visibility).toBe('full');
  });

  it('rejects non-belief records and invalid timestamps deterministically', () => {
    const invalidType = projectBeliefMaintenance({
      belief: belief({ type: 'observation' }),
      policy: policy(),
      now: '2026-01-06T00:00:00.000Z',
    });
    const invalidTimestamp = projectBeliefMaintenance({
      belief: belief(),
      policy: policy(),
      now: 'not-a-timestamp',
      challenge_receipts: [challenge({ challenged_at: 'not-a-timestamp' })],
    });

    expect(invalidType).toMatchObject({ ok: false, issues: [{ code: 'RECORD_TYPE_INVALID' }] });
    expect(invalidTimestamp.ok).toBe(false);
    expect(invalidTimestamp.issues.map((entry) => entry.code)).toContain('TIMESTAMP_INVALID');
  });

  it('orders the queue by state, influence, then belief ID', () => {
    const challenged = projectBeliefMaintenance({ belief: belief({ id: 'belief.z' }), policy: policy({ belief_id: 'belief.z' }), now: '2026-01-06T00:00:00.000Z', contradiction_signals: [contradiction({ belief_id: 'belief.z' })] }).value!;
    const overdue = projectBeliefMaintenance({ belief: belief({ id: 'belief.a' }), policy: policy({ belief_id: 'belief.a', review_after: '2026-01-01T00:00:00.000Z' }), now: '2026-02-02T00:00:00.000Z' }).value!;
    const worldviewA = projectBeliefMaintenance({ belief: belief({ id: 'belief.b' }), policy: policy({ belief_id: 'belief.b', risk_score: 0.2 }), now: '2026-01-06T00:00:00.000Z', use_receipts: [use({ belief_id: 'belief.b' }), use({ id: 'use.002', belief_id: 'belief.b', project_id: 'synthetic-lab-b', decision_id: 'decision.synthetic.002', independence_key: 'use-b' })] }).value!;
    const worldviewB = projectBeliefMaintenance({ belief: belief({ id: 'belief.c' }), policy: policy({ belief_id: 'belief.c', risk_score: 0.2 }), now: '2026-01-06T00:00:00.000Z', use_receipts: [use({ belief_id: 'belief.c' }), use({ id: 'use.003', belief_id: 'belief.c', project_id: 'synthetic-lab-b', decision_id: 'decision.synthetic.003', independence_key: 'use-c' })] }).value!;
    const due = projectBeliefMaintenance({ belief: belief({ id: 'belief.d' }), policy: policy({ belief_id: 'belief.d', review_after: '2026-01-06T00:00:00.000Z' }), now: '2026-01-06T00:00:00.000Z' }).value!;

    expect(buildBeliefReviewQueue([due, worldviewB, overdue, challenged, worldviewA]).map((entry) => entry.belief_id)).toEqual([
      'belief.z', 'belief.a', 'belief.b', 'belief.c', 'belief.d',
    ]);
  });

  it('does not mutate deeply frozen inputs', () => {
    const input = {
      belief: belief(),
      policy: policy(),
      now: '2026-01-06T00:00:00.000Z',
      challenge_receipts: [challenge({ result: 'contradicted' })],
    };
    const snapshot = structuredClone(input);
    Object.freeze(input.belief);
    Object.freeze(input.belief.confidence);
    Object.freeze(input.challenge_receipts);
    Object.freeze(input.challenge_receipts[0]);

    expect(projectBeliefMaintenance(input)).toMatchObject({ ok: true });
    expect(input).toEqual(snapshot);
  });

  it('binds review policy to the exact belief and scope', () => {
    const wrongBelief = projectBeliefMaintenance({
      belief: belief(),
      policy: policy({ belief_id: 'belief.other.001' }),
      now: '2026-01-06T00:00:00.000Z',
    });
    const wrongScope = projectBeliefMaintenance({
      belief: belief(),
      policy: policy({ scope: { project: 'other-project' } }),
      now: '2026-01-06T00:00:00.000Z',
    });

    expect(wrongBelief.issues.map((entry) => entry.code)).toContain('REVIEW_POLICY_BELIEF_MISMATCH');
    expect(wrongScope.issues.map((entry) => entry.code)).toContain('REVIEW_POLICY_SCOPE_MISMATCH');
  });

  it('rejects future belief provenance and malformed receipts without throwing', () => {
    const futureProvenance = projectBeliefMaintenance({
      belief: belief({
        provenance: [{ ...provenance[0]!, observed_at: '2026-01-07T00:00:00.000Z' }],
      }),
      policy: policy(),
      now: '2026-01-06T00:00:00.000Z',
    });
    const malformedInput = {
      belief: belief(), policy: policy(), now: '2026-01-06T00:00:00.000Z', challenge_receipts: [{}],
    } as unknown as Parameters<typeof projectBeliefMaintenance>[0];

    expect(futureProvenance.issues.map((entry) => entry.code)).toContain('PROVENANCE_IN_FUTURE');
    expect(() => projectBeliefMaintenance(malformedInput)).not.toThrow();
    expect(projectBeliefMaintenance(malformedInput).ok).toBe(false);
  });

  it('requires attributable outcomes to cite a matching use receipt', () => {
    const missing = projectBeliefMaintenance({
      belief: belief(), policy: policy(), now: '2026-01-06T00:00:00.000Z', outcome_receipts: [outcome()],
    });
    const mismatched = projectBeliefMaintenance({
      belief: belief(), policy: policy(), now: '2026-01-06T00:00:00.000Z',
      use_receipts: [use({ role: 'decisive' })], outcome_receipts: [outcome()],
    });

    expect(missing.issues.map((entry) => entry.code)).toContain('OUTCOME_USE_MISMATCH');
    expect(mismatched.issues.map((entry) => entry.code)).toContain('OUTCOME_USE_MISMATCH');
  });

  it('derives influence only from explicit use breadth and rejects one decision claimed by multiple projects', () => {
    const highRiskNoUse = projectBeliefMaintenance({
      belief: belief(), policy: policy({ risk_score: 1, volatility_score: 1 }), now: '2026-01-06T00:00:00.000Z',
    });
    const conflictingDecision = projectBeliefMaintenance({
      belief: belief(), policy: policy(), now: '2026-01-06T00:00:00.000Z',
      use_receipts: [use(), use({ id: 'use.002', project_id: 'other-project', independence_key: 'use-b' })],
    });

    expect(highRiskNoUse).toMatchObject({ ok: true, value: { influence_score: 0, review_priority_score: 0.7 } });
    expect(highRiskNoUse.value?.review.reasons).not.toContain('High-influence belief has no explicit review deadline.');
    expect(conflictingDecision.issues.map((entry) => entry.code)).toContain('USE_DECISION_SCOPE_CONFLICT');
  });
});
