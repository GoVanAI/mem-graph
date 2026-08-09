import { describe, expect, it } from 'vitest';
import { synthesizeAssessments } from '../src/epistemic/synthesize.js';
import type { Assessment, EpistemicRecord, SynthesizeInput } from '../src/epistemic/types.js';

const NOW = '2026-08-08T16:30:00Z';
const scope = { workspace: 'lab', project: 'parser', task: 'delimiter' };

function record(id: string): EpistemicRecord {
  return {
    schema_version: '0.3', id, type: 'observation', assertion_kind: 'descriptive', statement: 'Synthetic parser fixture fails.', scope,
    provenance: [{ source_type: 'synthetic_fixture', source_ref: id, observed_at: NOW }],
    confidence: { score: 0.9, band: 'high', basis: ['DIRECT_DOCUMENT_OBSERVATION'], rationale: 'Observed in fixture.' },
    status: 'active', authority: 'informational', relations: [], created_at: NOW, updated_at: NOW,
  };
}

function assessment(id: string, supporting: string[], counterbeliefs: string[] = []): Assessment {
  return {
    schema_version: '0.3', assessment_id: id, assigned_stance: id === 'assessment.a01' ? 'argue for change' : 'argue for retention', scope,
    conclusion: 'A bounded conclusion based on the supplied record references.',
    confidence: { score: id === 'assessment.a01' ? 0.9 : 0.55, band: id === 'assessment.a01' ? 'high' : 'medium', basis: ['SINGLE_SOURCE_REPORT'], rationale: 'Assessment-local calibration.' },
    supporting_record_refs: supporting, counterbelief_refs: counterbeliefs, decisive_missing_evidence: ['Version-matched specification.'], proposed_actions: ['Inspect the specification.'],
  };
}

function input(overrides: Partial<SynthesizeInput> = {}): SynthesizeInput {
  const observation = record('obs.fixture.001');
  const counter = record('belief.counter.001');
  return {
    synthesis_id: 'synthesis.parser.001', scope, assessments: [assessment('assessment.a01', [observation.id], [counter.id]), assessment('assessment.b01', [observation.id], [counter.id])], records: [observation, counter],
    shared_observations: ['Synthetic fixture failure is reproducible.'], genuine_disagreements: ['Whether the failure requires a code change now.'], decisive_missing_evidence: ['Version-matched specification.'],
    candidate_decision: 'Preserve the baseline while inspecting the specification.',
    confidence: { score: 0.61, band: 'medium', basis: ['MISSING_DIRECT_EVIDENCE'], rationale: 'The key contract is unresolved.' },
    next_actions: ['Inspect the specification.'], ...overrides,
  };
}

describe('synthesizeAssessments', () => {
  it('assembles explicitly supplied semantics into a proposed artifact without averaging confidence', () => {
    const result = synthesizeAssessments(input());

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ candidate_decision_status: 'proposed', confidence: { score: 0.61 } });
    expect(result.value?.shared_observations).toEqual(['Synthetic fixture failure is reproducible.']);
    expect(result.value?.assessment_refs).toEqual(['assessment.a01', 'assessment.b01']);
    expect(result.value?.next_actions).toEqual(['Inspect the specification.']);
  });

  it('rejects unresolved or duplicate record references rather than inferring them from prose', () => {
  const source = input({ assessments: [assessment('assessment.a01', ['missing.record.001']), assessment('assessment.b01', ['missing.record.001'])] });
    const result = synthesizeAssessments(source);

    expect(result.ok).toBe(false);
    expect(result.issues.some((entry) => entry.code === 'REFERENCE_UNRESOLVED')).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('enforces the bounded next-action lane', () => {
    const result = synthesizeAssessments(input({ next_actions: ['a', 'b', 'c', 'd'] }));

    expect(result.ok).toBe(false);
    expect(result.issues.some((entry) => entry.code === 'NEXT_ACTIONS_INVALID')).toBe(true);
  });

  it('rejects cross-project record citations and assessment scope', () => {
    const crossProjectRecord = { ...record('obs.other.001'), scope: { workspace: 'lab', project: 'other', task: 'delimiter' } };
    const recordCitation = synthesizeAssessments(input({
      records: [crossProjectRecord, record('belief.counter.001')],
      assessments: [assessment('assessment.a01', [crossProjectRecord.id]), assessment('assessment.b01', [crossProjectRecord.id])],
    }));
    const otherAssessment = { ...assessment('assessment.a01', ['obs.fixture.001']), scope: { workspace: 'lab', project: 'other', task: 'delimiter' } };
    const assessmentScope = synthesizeAssessments(input({
      assessments: [otherAssessment, assessment('assessment.b01', ['obs.fixture.001'])],
    }));

    expect(recordCitation.issues.map((entry) => entry.code)).toContain('SCOPE_NOT_APPLICABLE');
    expect(assessmentScope.issues.map((entry) => entry.code)).toContain('SCOPE_NOT_APPLICABLE');
  });
});
