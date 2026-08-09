import { describe, expect, it } from 'vitest';
import scenarioFixture from './fixtures/epistemic/scenarios.json';
import type { Assessment, EpistemicRecord } from '../src/epistemic/types.js';
import {
  isBindingEligible,
  validateAssessment,
  validateCompactPrime,
  validateEpistemicBundle,
  validateEpistemicRecord,
  validateSynthesisArtifact,
} from '../src/epistemic/validate.js';

function record(overrides: Partial<EpistemicRecord> = {}): EpistemicRecord {
  return {
    schema_version: '0.3', id: 'belief.validate.001', type: 'belief', assertion_kind: 'descriptive',
    statement: 'A synthetic validation belief remains under review.', scope: { workspace: 'learning-lab', project: 'validation-demo' },
    provenance: [{ source_type: 'synthetic_fixture', source_ref: 'fixture:validation', observed_at: '2026-08-08T00:00:00Z' }],
    confidence: { score: 0.6, band: 'medium', basis: ['STRONG_INFERENCE'], rationale: 'A synthetic test provides this basis.' },
    status: 'active', authority: 'informational', relations: [],
    created_at: '2026-08-08T00:00:00Z', updated_at: '2026-08-08T00:00:00Z', ...overrides,
  };
}

function codes(value: { issues: Array<{ code: string }> }): string[] {
  return value.issues.map((entry) => entry.code);
}

describe('epistemic v0.3 semantic validation', () => {
  it('derives confidence bands at both threshold edges without rewriting the record', () => {
    expect(validateEpistemicRecord(record({ confidence: { score: 0.54, band: 'low', basis: ['SINGLE_SOURCE_REPORT'], rationale: 'Synthetic lower edge.' } })).ok).toBe(true);
    expect(validateEpistemicRecord(record({ confidence: { score: 0.55, band: 'medium', basis: ['SINGLE_SOURCE_REPORT'], rationale: 'Synthetic upper edge.' } })).ok).toBe(true);
    const invalid = validateEpistemicRecord(record({ confidence: { score: 0.55, band: 'low', basis: ['SINGLE_SOURCE_REPORT'], rationale: 'Synthetic mismatch.' } }));
    expect(codes(invalid)).toContain('CONFIDENCE_BAND_MISMATCH');
    expect(invalid.value?.confidence.band).toBe('low');
  });

  it.each([
    ['MISSING_DIRECT_EVIDENCE'],
    ['CONTRADICTED'],
    ['PLAUSIBLE_INFERENCE'],
  ])('rejects high confidence overclaim for %j', (basis) => {
    const result = validateEpistemicRecord(record({ confidence: { score: 0.9, band: 'high', basis: [basis] as EpistemicRecord['confidence']['basis'], rationale: 'Synthetic overclaim.' } }));
    expect(codes(result)).toContain('CONFIDENCE_BASIS_OVERCLAIM');
  });

  it('rejects timestamp order, duplicate/self relations, and disputed records lacking a contradiction', () => {
    const invalid = validateEpistemicRecord(record({
      status: 'disputed', updated_at: '2026-08-07T00:00:00Z',
      relations: [
        { type: 'supports', target_id: 'belief.other.001' },
        { type: 'supports', target_id: 'belief.other.001' },
        { type: 'contradicts', target_id: 'belief.validate.001' },
      ],
    }));
    expect(codes(invalid)).toEqual(expect.arrayContaining([
      'TIMESTAMP_ORDER_INVALID', 'DUPLICATE_RELATION', 'SELF_RELATION_INVALID',
    ]));
    expect(codes(validateEpistemicRecord(record({ status: 'disputed' })))).toContain('DISPUTE_WITHOUT_CONTRADICTION');
    expect(codes(validateEpistemicRecord(record({ status: 'conditional' })))).toContain('CONDITIONS_REQUIRED');
  });

  it('permits only the documented synthetic provenance exception as a warning', () => {
    const question = validateEpistemicRecord(record({
      id: 'question.validate.001', type: 'question', provenance: [],
    }));
    const belief = validateEpistemicRecord(record({ provenance: [] }));
    expect(question.ok).toBe(true);
    expect(codes(question)).toContain('SYNTHETIC_PROVENANCE_EXCEPTION');
    expect(codes(belief)).toContain('PROVENANCE_REQUIRED');
  });

  it('validates a closed catalog, accepting explicitly declared external relation IDs only', () => {
    const local = record({ relations: [{ type: 'supports', target_id: 'evidence.external.001' }] });
    const unresolved = validateEpistemicBundle({ records: [local] });
    const external = validateEpistemicBundle({ records: [local] }, { externalReferenceIds: new Set(['evidence.external.001']) });
    expect(codes(unresolved)).toContain('REFERENCE_UNRESOLVED');
    expect(external.ok).toBe(true);
  });

  it('warns conservatively when execution audit alone overclaims an underlying system feature', () => {
    const result = validateEpistemicRecord(record({
      type: 'evidence', statement: 'The repository does not implement the synthetic feature.',
      provenance: [{ source_type: 'execution_audit', source_ref: 'audit:synthetic', observed_at: '2026-08-08T00:00:00Z' }],
    }));
    expect(result.ok).toBe(true);
    expect(codes(result)).toContain('EXECUTION_AUDIT_OVERCLAIM');
  });

  it('keeps authority a Phase 0 claim unless an explicit verified ID set confirms an active policy or decision', () => {
    const proposed = record({ id: 'policy.validate.001', type: 'policy', status: 'proposed', authority: 'system_governing' });
    const active = record({ id: 'decision.validate.001', type: 'decision', authority: 'operator_adopted' });
    const preference = record({ id: 'preference.validate.001', type: 'preference', authority: 'operator_adopted' });
    const observation = record({ id: 'observation.validate.002', type: 'observation', authority: 'operator_adopted' });
    expect(validateEpistemicRecord(proposed).ok).toBe(true);
    expect(codes(validateEpistemicRecord(proposed))).toContain('BINDING_STATUS_INVALID');
    expect(isBindingEligible(active)).toBe(false);
    expect(isBindingEligible(active, new Set([active.id]))).toBe(true);
    expect(isBindingEligible(preference, new Set([preference.id]))).toBe(true);
    expect(isBindingEligible(observation, new Set([observation.id]))).toBe(false);
    expect(isBindingEligible(proposed, new Set([proposed.id]))).toBe(false);
  });

  it('checks compact-prime and assessment/synthesis reference integrity deterministically', () => {
    const source = record({ id: 'observation.validate.001', type: 'observation' });
    const catalog = new Map([[source.id, source]]);
    const prime = validateCompactPrime({
      schema_version: '0.3', generated_at: '2026-08-08T00:00:00Z', query: 'Synthetic review.', scope: source.scope, current_focus: 'Synthetic focus.',
      record_refs: [{ id: source.id, reason: 'A short synthetic inclusion reason.' }], contradiction_refs: [], open_question_refs: [], recommended_action_refs: [], exclusions: [],
      audit: { candidate_count: 1, eligible_count: 1, included_count: 1, contradiction_count: 0, mutation: 'none' },
    }, { catalog });
    const assessment: Assessment = {
      schema_version: '0.3', assessment_id: 'assessment.validate.001', assigned_stance: 'Inspect uncertainty.', scope: source.scope, conclusion: 'The synthetic observation is relevant.',
      confidence: source.confidence, supporting_record_refs: [source.id], counterbelief_refs: [], decisive_missing_evidence: [], proposed_actions: [],
    };
    const checkedAssessment = validateAssessment(assessment, { catalog });
    const synthesis = validateSynthesisArtifact({
      schema_version: '0.3', synthesis_id: 'synthesis.validate.001', scope: source.scope, assessment_refs: [assessment.assessment_id, 'assessment.missing.001'],
      shared_observations: [], genuine_disagreements: [], decisive_missing_evidence: [], candidate_decision: 'Collect one more synthetic observation.',
      candidate_decision_status: 'proposed', confidence: source.confidence, next_actions: [],
    }, { assessments: new Map([[assessment.assessment_id, assessment]]) });
    expect(prime.ok).toBe(true);
    expect(checkedAssessment.ok).toBe(true);
    expect(codes(synthesis)).toContain('REFERENCE_UNRESOLVED');
  });

  it('validates a disputed primary only when its contradiction lane contains a direct challenger', () => {
    const disputed = record({
      id: 'belief.disputed.001',
      status: 'disputed',
      relations: [{ type: 'contradicts', target_id: 'belief.challenger.001' }],
    });
    const challenger = record({ id: 'belief.challenger.001' });
    const unrelated = record({ id: 'belief.unrelated.001' });
    const base = {
      schema_version: '0.3' as const,
      generated_at: '2026-08-08T00:00:00Z',
      query: 'Synthetic dispute.',
      scope: disputed.scope,
      current_focus: 'Inspect the synthetic dispute.',
      record_refs: [{ id: disputed.id, reason: 'Selected disputed belief.' }],
      open_question_refs: [],
      recommended_action_refs: [],
      exclusions: [],
      audit: { candidate_count: 3, eligible_count: 3, included_count: 1, contradiction_count: 1, mutation: 'none' as const },
    };
    const catalog = new Map([disputed, challenger, unrelated].map((entry) => [entry.id, entry]));

    expect(validateCompactPrime({
      ...base,
      contradiction_refs: [{ id: challenger.id, reason: 'Direct challenger.' }],
    }, { catalog }).ok).toBe(true);
    expect(codes(validateCompactPrime({
      ...base,
      contradiction_refs: [{ id: unrelated.id, reason: 'Unrelated belief.' }],
    }, { catalog }))).toContain('REFERENCE_INELIGIBLE');
  });

  it('reports duplicate references and orders semantic issues by record ID, path, then code', () => {
    const first = record({ id: 'belief.alpha.001', status: 'disputed' });
    const second = record({ id: 'belief.beta.001', provenance: [], relations: [{ type: 'supports', target_id: 'missing.reference.001' }] });
    const checked = validateEpistemicBundle({ records: [second, first] });
    expect(codes(checked)).toContain('REFERENCE_UNRESOLVED');
    expect(checked.issues.map((entry) => entry.record_id).filter(Boolean)).toEqual([
      'belief.alpha.001', 'belief.beta.001', 'belief.beta.001',
    ]);
    const duplicateAssessment = validateAssessment({
      schema_version: '0.3', assessment_id: 'assessment.duplicate.001', assigned_stance: 'Check references.', scope: {},
      conclusion: 'Synthetic duplicate reference check.', confidence: first.confidence,
      supporting_record_refs: [first.id, first.id], counterbelief_refs: [], decisive_missing_evidence: [], proposed_actions: [],
    });
    expect(codes(duplicateAssessment)).toContain('REFERENCE_DUPLICATE');
  });

  it('rejects compact-prime references outside explicit project, task, subject, or any specified scope', () => {
    const projectRecord = record({ id: 'belief.scope.project', scope: { workspace: 'lab', project: 'other', task: 'one', subject: 'alpha' } });
    const taskRecord = record({ id: 'belief.scope.task', scope: { workspace: 'lab', project: 'target', task: 'other', subject: 'alpha' } });
    const subjectRecord = record({ id: 'belief.scope.subject', scope: { workspace: 'lab', project: 'target', task: 'one', subject: 'other' } });
    const unscopedRecord = record({ id: 'belief.scope.missing', scope: {} });
    const catalog = new Map([projectRecord, taskRecord, subjectRecord, unscopedRecord].map((entry) => [entry.id, entry]));
    const base = {
      schema_version: '0.3' as const,
      generated_at: '2026-08-08T00:00:00Z',
      query: 'Synthetic scope validation.',
      scope: { workspace: 'lab', project: 'target', task: 'one', subject: 'alpha' },
      current_focus: 'Keep references in scope.',
      contradiction_refs: [], open_question_refs: [], recommended_action_refs: [], exclusions: [],
      audit: { candidate_count: 1, eligible_count: 1, included_count: 1, contradiction_count: 0, mutation: 'none' as const },
    };

    for (const source of [projectRecord, taskRecord, subjectRecord, unscopedRecord]) {
      const checked = validateCompactPrime({ ...base, record_refs: [{ id: source.id, reason: 'Synthetic cross-scope reference.' }] }, { catalog });
      expect(codes(checked), source.id).toContain('SCOPE_NOT_APPLICABLE');
    }
    const blank = validateCompactPrime({ ...base, scope: {}, record_refs: [{ id: unscopedRecord.id, reason: 'No explicit applicability.' }] }, { catalog });
    expect(codes(blank)).toContain('SCOPE_NOT_APPLICABLE');
  });

  it('accepts every shared clean-room scenario as a closed structural and relation bundle', () => {
    for (const scenario of scenarioFixture.scenarios) {
      const checked = validateEpistemicBundle({ records: scenario.records });
      expect(checked.ok, scenario.name).toBe(true);
    }
  });
});
