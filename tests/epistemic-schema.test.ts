import { describe, expect, it } from 'vitest';
import {
  AssessmentSchema,
  CalibratedConfidenceSchema,
  CompactPrimeSchema,
  EpistemicRecordSchema,
  SynthesisArtifactSchema,
} from '../src/epistemic/schema.js';
import { EPISTEMIC_TYPES, type EpistemicRecord } from '../src/epistemic/types.js';

function record(overrides: Partial<EpistemicRecord> = {}): EpistemicRecord {
  return {
    schema_version: '0.3',
    id: 'observation.schema.001',
    type: 'observation',
    assertion_kind: 'descriptive',
    statement: 'A synthetic schema observation was recorded.',
    scope: { workspace: 'learning-lab', project: 'schema-demo' },
    provenance: [{ source_type: 'synthetic_fixture', source_ref: 'fixture:schema', observed_at: '2026-08-08T00:00:00Z' }],
    confidence: { score: 0.8, band: 'high', basis: ['DIRECT_DOCUMENT_OBSERVATION'], rationale: 'A synthetic fixture supplied this observation.' },
    status: 'active',
    authority: 'informational',
    relations: [],
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    ...overrides,
  };
}

describe('epistemic v0.3 structural schemas', () => {
  it('accepts a structurally valid record for every epistemic type', () => {
    for (const type of EPISTEMIC_TYPES) {
      const parsed = EpistemicRecordSchema.safeParse(record({ id: `${type}.schema.001`, type }));
      expect(parsed.success, type).toBe(true);
    }
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite or out-of-range confidence score %p',
    (score) => {
      expect(CalibratedConfidenceSchema.safeParse({
        score,
        band: 'low',
        basis: ['SINGLE_SOURCE_REPORT'],
        rationale: 'Synthetic confidence rationale.',
      }).success).toBe(false);
    },
  );

  it('rejects malformed IDs, timestamps, and blank human-readable fields', () => {
    expect(EpistemicRecordSchema.safeParse(record({ id: 'no' })).success).toBe(false);
    expect(EpistemicRecordSchema.safeParse(record({ created_at: 'yesterday' })).success).toBe(false);
    expect(EpistemicRecordSchema.safeParse(record({ statement: '   ' })).success).toBe(false);
    expect(EpistemicRecordSchema.safeParse(record({
      provenance: [{ source_type: 'synthetic_fixture', source_ref: ' ', observed_at: '2026-08-08T00:00:00Z' }],
    })).success).toBe(false);
  });

  it('accepts all public artifact structures with bounded reference lanes', () => {
    const prime = CompactPrimeSchema.safeParse({
      schema_version: '0.3', generated_at: '2026-08-08T00:00:00Z', query: 'Synthetic query.',
      scope: {}, current_focus: 'Synthetic focus.', record_refs: [], contradiction_refs: [],
      open_question_refs: [], recommended_action_refs: [], exclusions: [],
      audit: { candidate_count: 0, eligible_count: 0, included_count: 0, contradiction_count: 0, mutation: 'none' },
    });
    const assessment = AssessmentSchema.safeParse({
      schema_version: '0.3', assessment_id: 'assessment.schema.001', assigned_stance: 'Review evidence.', scope: {},
      conclusion: 'A synthetic conclusion.', confidence: record().confidence, supporting_record_refs: [], counterbelief_refs: [],
      decisive_missing_evidence: [], proposed_actions: [],
    });
    const synthesis = SynthesisArtifactSchema.safeParse({
      schema_version: '0.3', synthesis_id: 'synthesis.schema.001', scope: {}, assessment_refs: [], shared_observations: [],
      genuine_disagreements: [], decisive_missing_evidence: [], candidate_decision: 'Keep the baseline while evidence is collected.',
      candidate_decision_status: 'proposed', confidence: record().confidence, next_actions: [],
    });
    expect(prime.success).toBe(true);
    expect(assessment.success).toBe(true);
    expect(synthesis.success).toBe(true);
  });
});
