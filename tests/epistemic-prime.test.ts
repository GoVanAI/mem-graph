import { describe, expect, it } from 'vitest';
import { compileCompactPrime } from '../src/epistemic/prime.js';
import type { EpistemicRecord } from '../src/epistemic/types.js';
import scenariosFixture from './fixtures/epistemic/scenarios.json';

const NOW = '2026-08-08T16:30:00Z';

function record(id: string, overrides: Partial<EpistemicRecord> = {}): EpistemicRecord {
  return {
    schema_version: '0.3', id, type: 'belief', assertion_kind: 'descriptive', statement: 'Parser delimiter behavior needs investigation.',
    scope: { workspace: 'lab', project: 'parser', task: 'delimiter' },
    provenance: [{ source_type: 'synthetic_fixture', source_ref: `fixture:${id}`, observed_at: NOW }],
    confidence: { score: 0.65, band: 'medium', basis: ['STRONG_INFERENCE'], rationale: 'Synthetic fixture supports this bounded inference.' },
    status: 'active', authority: 'informational', relations: [], created_at: NOW, updated_at: NOW,
    ...overrides,
  };
}

function input(records: EpistemicRecord[], overrides: Record<string, unknown> = {}) {
  return { query: 'parser delimiter', current_focus: 'Choose the next parser investigation.', scope: { workspace: 'lab', project: 'parser', task: 'delimiter' }, records, now: NOW, ...overrides };
}

describe('compileCompactPrime', () => {
  it('preserves scope isolation, reports exclusions, and does not mutate input', () => {
    const exact = record('belief.exact.001');
    const otherProject = record('belief.other.001', { scope: { workspace: 'lab', project: 'other', task: 'delimiter' } });
    const source = input([exact, otherProject]);
    const before = JSON.parse(JSON.stringify(source));

    const result = compileCompactPrime(source);

    expect(result.ok).toBe(true);
    expect(result.value?.record_refs.map((ref) => ref.id)).toEqual(['belief.exact.001']);
    expect(result.value?.exclusions).toContainEqual({ id: 'belief.other.001', reason: 'scope mismatch for project' });
    expect(result.value?.audit.mutation).toBe('none');
    expect(source).toEqual(before);
  });

  it('does not let narrower task scope leak into a project-only request or an unspecified project', () => {
    const taskScoped = record('belief.task-only.001');
    const missingProject = record('belief.project-missing.001', { scope: { workspace: 'lab', task: 'delimiter' } });
    const projectOnly = compileCompactPrime(input([taskScoped], {
      scope: { workspace: 'lab', project: 'parser' },
    }));
    const exactTask = compileCompactPrime(input([missingProject]));

    expect(projectOnly.value?.exclusions).toContainEqual({
      id: taskScoped.id,
      reason: 'record scope is more specific than request for task',
    });
    expect(exactTask.value?.exclusions).toContainEqual({
      id: missingProject.id,
      reason: 'record project is unspecified',
    });
  });

  it('keeps a lower-ranked contradiction in its dedicated lane', () => {
    const primary = record('belief.primary.001', { relations: [{ type: 'contradicts', target_id: 'belief.counter.001' }] });
    const counter = record('belief.counter.001', { statement: 'Parser has an alternative behavior.', relations: [] });
    const result = compileCompactPrime(input([primary, counter], { limits: { records: 1, contradictions: 4 } }));

    expect(result.value?.record_refs.map((ref) => ref.id)).toEqual(['belief.primary.001']);
    expect(result.value?.contradiction_refs.map((ref) => ref.id)).toEqual(['belief.counter.001']);
    expect(result.value?.contradiction_refs[0]?.reason).not.toContain(counter.statement);
  });

  it('handles lifecycle modes and preserves separate action/question lanes', () => {
    const completed = record('action.completed.001', { type: 'action', statement: 'Inspect parser delimiter code.', status: 'completed' });
    const question = record('question.open.001', { type: 'question', statement: 'Which parser delimiter contract applies?' });
    const superseded = record('belief.superseded.001', { status: 'superseded' });

    const ordinary = compileCompactPrime(input([completed, question, superseded]));
    const completion = compileCompactPrime(input([completed, question, superseded], { mode: 'completion' }));
    const historical = compileCompactPrime(input([completed, question, superseded], { mode: 'historical' }));

    expect(ordinary.value?.recommended_action_refs).toEqual([]);
    expect(ordinary.value?.open_question_refs.map((ref) => ref.id)).toEqual(['question.open.001']);
    expect(completion.value?.recommended_action_refs.map((ref) => ref.id)).toEqual(['action.completed.001']);
    expect(completion.value?.exclusions.map((entry) => entry.id)).toContain(superseded.id);
    expect(historical.value?.record_refs.map((entry) => entry.id)).toContain(superseded.id);
  });

  it('uses stable score ties and rejects irrelevant authority', () => {
    const b = record('belief.tie.b01');
    const a = record('belief.tie.a01');
    const governing = record('decision.governing.001', {
      type: 'decision', authority: 'system_governing', statement: 'Unrelated deployment procedure.',
    });
    const result = compileCompactPrime(input([b, governing, a], { limits: { records: 2 } }));

    expect(result.value?.record_refs.map((ref) => ref.id)).toEqual(['belief.tie.a01', 'belief.tie.b01']);
    expect(result.value?.exclusions).toContainEqual({ id: 'decision.governing.001', reason: 'no query relevance' });
    expect(result.debug.find((entry) => entry.id === 'belief.tie.a01')).toMatchObject({ total_score: expect.any(Number), relevance: expect.any(Number), scope_specificity: expect.any(Number) });
  });

  it('honors an injected scorer while giving authority weight only to explicitly verified IDs', () => {
    const governing = record('decision.verified.001', {
      type: 'decision',
      authority: 'system_governing',
      statement: 'A synthetic governing claim.',
    });
    const unverified = compileCompactPrime(input([governing], {
      relevance_scorer: () => 1,
    }));
    const verified = compileCompactPrime(input([governing], {
      relevance_scorer: () => 1,
      verified_authority_ids: new Set([governing.id]),
    }));

    expect(unverified.value?.record_refs.map((entry) => entry.id)).toEqual([governing.id]);
    expect(unverified.debug.find((entry) => entry.id === governing.id)?.authority_visibility).toBe(0);
    expect(verified.debug.find((entry) => entry.id === governing.id)?.authority_visibility).toBe(1);
  });

  it('returns a structurally valid exclusion identifier for invalid catalog records', () => {
    const invalid = record('bad id', {
      confidence: { score: Number.NaN, band: 'medium', basis: ['STRONG_INFERENCE'], rationale: 'Invalid synthetic confidence.' },
    });
    const result = compileCompactPrime(input([invalid]));

    expect(result.ok).toBe(false);
    expect(result.value?.exclusions).toContainEqual({ id: 'invalid.record.1', reason: 'invalid record: SCHEMA_INVALID' });
  });

  it('rejects duplicate record IDs in the closed compilation catalog', () => {
    const duplicated = record('belief.duplicate.001');
    const result = compileCompactPrime(input([duplicated, { ...duplicated }]));

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain('PRIME_CATALOG_DUPLICATE');
  });

  it('requires a timezone-bearing projection timestamp', () => {
    const result = compileCompactPrime(input([record('belief.time.001')], { now: '2026-08-08T16:30:00' }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain('PRIME_NOW_INVALID');
  });

  it('rejects future record state and provenance while keeping future validity as a lifecycle exclusion', () => {
    const future = '2026-08-09T16:30:00Z';
    const futureUpdated = compileCompactPrime(input([record('belief.future.updated', { updated_at: future })]));
    const futureCreated = compileCompactPrime(input([record('belief.future.created', {
      created_at: future, updated_at: future,
      provenance: [{ source_type: 'synthetic_fixture', source_ref: 'future-created', observed_at: future }],
    })]));
    const futureProvenance = compileCompactPrime(input([record('belief.future.provenance', {
      provenance: [{ source_type: 'synthetic_fixture', source_ref: 'future-provenance', observed_at: future }],
    })]));
    const notYetValid = compileCompactPrime(input([record('belief.future.validity', { scope: { workspace: 'lab', project: 'parser', task: 'delimiter', valid_from: future } })]));

    expect(futureUpdated.value?.record_refs).toEqual([]);
    expect(futureUpdated.issues.map((entry) => entry.code)).toContain('TIMESTAMP_IN_FUTURE');
    expect(futureCreated.issues.map((entry) => entry.code)).toContain('TIMESTAMP_IN_FUTURE');
    expect(futureProvenance.issues.map((entry) => entry.code)).toContain('PROVENANCE_IN_FUTURE');
    expect(notYetValid).toMatchObject({ ok: true, value: { exclusions: [{ id: 'belief.future.validity', reason: 'not yet valid' }] } });
  });

  it('treats missing scope as unspecified while allowing an explicit workspace-only match', () => {
    const missing = record('belief.scope.missing', { scope: {} });
    const unscoped = compileCompactPrime(input([missing], { scope: {} }));
    const workspaceGlobal = record('belief.scope.workspace', { scope: { workspace: 'lab' } });
    const explicit = compileCompactPrime(input([workspaceGlobal], { scope: { workspace: 'lab' } }));

    expect(unscoped.value?.exclusions).toContainEqual({ id: missing.id, reason: 'request scope is unspecified' });
    expect(explicit.value?.record_refs.map((entry) => entry.id)).toEqual([workspaceGlobal.id]);
  });

  it('uses locale-invariant normalization and tie ordering', () => {
    const capitalI = record('belief.locale.b', { statement: 'I parser delimiter.' });
    const lowercaseI = record('belief.locale.a', { statement: 'i parser delimiter.' });
    const result = compileCompactPrime(input([capitalI, lowercaseI], { query: 'I parser delimiter', limits: { records: 2 } }));

    expect(result.value?.record_refs.map((entry) => entry.id)).toEqual(['belief.locale.a', 'belief.locale.b']);
  });

  for (const scenario of scenariosFixture.scenarios) {
    it(`compiles the clean-room ${scenario.name} fixture`, () => {
      const result = compileCompactPrime({
        query: scenario.query,
        current_focus: scenario.current_focus,
        scope: scenario.scope,
        records: scenario.records as EpistemicRecord[],
        now: NOW,
      });
      const expected = scenario.expected as { primary?: string[]; questions?: string[]; actions?: string[]; contradictions?: string[]; excluded?: string[] };

      expect(result.ok).toBe(true);
      for (const id of expected.primary ?? []) expect(result.value?.record_refs.map((ref) => ref.id)).toContain(id);
      for (const id of expected.questions ?? []) expect(result.value?.open_question_refs.map((ref) => ref.id)).toContain(id);
      for (const id of expected.actions ?? []) expect(result.value?.recommended_action_refs.map((ref) => ref.id)).toContain(id);
      for (const id of expected.contradictions ?? []) expect(result.value?.contradiction_refs.map((ref) => ref.id)).toContain(id);
      for (const id of expected.excluded ?? []) expect(result.value?.exclusions.map((entry) => entry.id)).toContain(id);
    });
  }
});
