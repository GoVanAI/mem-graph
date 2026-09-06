import { describe, expect, it } from 'vitest';
import {
  assembleTaskStatePacket,
  TASK_STATE_UNRESOLVED_CODES,
  TASK_STATE_WARNING_CODES,
  type AssembleTaskStatePacketInput,
  type TaskStateManifest,
  type TaskStateSourceRef,
} from '../src/cognitive/task-state.js';
import { createInMemoryDb, seedMemory } from './helpers.js';

const hash = (letter: string) => letter.repeat(64);
const memory = (id: number, project_id = 'project-a', overrides: Record<string, unknown> = {}) => ({
  id, project_id, updated_at: '2026-08-01T00:00:00.000Z', content_sha256: hash('a'), ...overrides,
});
const ref = (id: number, project_id = 'project-a'): TaskStateSourceRef => ({ kind: 'memory', id, project_id, expected_updated_at: '2026-08-01T00:00:00.000Z' });

function manifest(overrides: Partial<TaskStateManifest> = {}): TaskStateManifest {
  const adoption = ref(1);
  return {
    schema_version: '1.0.0', manifest_id: 'manifest-a', revision: 1, project_id: 'project-a', task_id: 'task-a',
    adoption: { status: 'operator_adopted', source: adoption },
    task: {
      objective: { statement: 'Assemble the verified packet.', required: true, sources: [ref(2)] },
      definition_of_done: { statement: 'Packet has stable output.', required: true, sources: [ref(3)] },
      constraints: [{ statement: 'No writes.', required: true, sources: [ref(4)] }],
    },
    lane_requirements: { governing: 'required', current_state: 'optional', open_state: 'optional', evidence: 'optional', context_only: 'optional', warnings: 'optional' },
    event_scope: { project_id: 'project-a', task_id: 'task-a', allow_legacy_v1_context: false },
    limits: { max_items_per_lane: 10, max_preview_characters: 80 },
    ...overrides,
  };
}

function input(overrides: Partial<AssembleTaskStatePacketInput> = {}): AssembleTaskStatePacketInput {
  return {
    project_id: 'project-a', task_id: 'task-a', manifest: manifest(),
    sources: { memories: [
      memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2), memory(3), memory(4),
    ] },
    ...overrides,
  };
}

describe('assembleTaskStatePacket — Contract v1 internal assembler', () => {
  it('is exact-project by default, rejects collisions, and requires dual explicit global authorization', () => {
    const collision = input({ sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2, 'project-b'), memory(3), memory(4)] } });
    expect(assembleTaskStatePacket(collision).warnings).toContain('cross_project_source');
    expect(assembleTaskStatePacket(collision).governing.map((item) => item.source.project_id)).not.toContain('project-b');

    const globalManifest = manifest({ include_global: true, task: { ...manifest().task, objective: { statement: 'Global is explicit.', required: true, sources: [ref(9, '_global')] } } });
    const denied = assembleTaskStatePacket(input({ manifest: globalManifest, sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(3), memory(4), memory(9, '_global')] } }));
    expect(denied.warnings).toContain('global_source_not_authorized');
    const allowed = assembleTaskStatePacket(input({ include_global: true, manifest: globalManifest, sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(3), memory(4), memory(9, '_global')] } }));
    expect(allowed.scope.global_inclusion).toBe('explicit');
    expect(allowed.warnings).not.toContain('global_source_not_authorized');
  });

  it('enforces task identity, external manifest adoption, and proposed/superseded contextual-only behavior', () => {
    const mismatchedTask = assembleTaskStatePacket(input({ manifest: manifest({ event_scope: { project_id: 'project-a', task_id: 'other', allow_legacy_v1_context: false } }) }));
    expect(mismatchedTask.unresolved).toContain('task_identity_unresolved');
    expect(mismatchedTask.governing).toEqual([]);
    expect(mismatchedTask.current_state).toEqual([]);
    expect(mismatchedTask.open_state).toEqual([]);
    expect(mismatchedTask.evidence).toEqual([]);
    expect(mismatchedTask.context_only.every((item) => item.exclusion_reasons?.includes('task_identity_unresolved'))).toBe(true);
    const selfAdopted = assembleTaskStatePacket(input({ sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: false }), memory(2), memory(3), memory(4)] } }));
    expect(selfAdopted.unresolved).toContain('manifest_adoption_unverified');
    expect(selfAdopted.governing).toEqual([]);
    const proposed = assembleTaskStatePacket(input({ manifest: manifest({ adoption: { status: 'proposed', source: ref(1) } }) }));
    expect(proposed.unresolved).not.toContain('manifest_adoption_unverified');
    expect(proposed.context_only.some((item) => item.preview.includes('proposed'))).toBe(true);
  });

  it('retains deterministic exclusion reasons on every supported context-only item', () => {
    const proposed = assembleTaskStatePacket(input({ manifest: manifest({ adoption: { status: 'proposed', source: ref(1) } }) }));
    expect(proposed.context_only).not.toEqual([]);
    expect(proposed.context_only.every((item) => item.exclusion_reasons?.length)).toBe(true);
    expect(proposed.context_only.every((item) => item.exclusion_reasons?.includes('manifest_proposed'))).toBe(true);
    const superseded = assembleTaskStatePacket(input({ manifest: manifest({ adoption: { status: 'superseded', source: ref(1) } }) }));
    expect(superseded.context_only.every((item) => item.exclusion_reasons?.includes('manifest_superseded'))).toBe(true);
    const unverified = assembleTaskStatePacket(input({ sources: { memories: [memory(1), memory(2), memory(3), memory(4)] } }));
    expect(unverified.context_only.every((item) => item.exclusion_reasons?.includes('manifest_adoption_unverified'))).toBe(true);
    const contextualEvents = assembleTaskStatePacket(input({ manifest: manifest({ event_scope: { project_id: 'project-a', task_id: 'task-a', allow_legacy_v1_context: true } }), sources: {
      memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2), memory(3), memory(4)],
      events: [
        { event_id: 'legacy', project_id: 'project-a', task_id: 'task-a', sequence: 1, event_hash: hash('a'), schema_version: 1, integrity_valid: true },
        { event_id: 'envelope', project_id: 'project-a', task_id: 'task-a', sequence: 2, event_hash: hash('b'), integrity_valid: true, task_state: { version: '1.0.0', state_id: 's', role: 'open_state', status: 'open', statement: 'Await approval.' } },
      ],
    } }));
    expect(contextualEvents.context_only.every((item) => item.exclusion_reasons?.length)).toBe(true);
    expect(contextualEvents.context_only.find((item) => item.item_id.includes('|legacy'))?.exclusion_reasons).toEqual(['legacy_v1_context_allowed']);
    expect(contextualEvents.context_only.find((item) => item.item_id.includes('|envelope:'))?.exclusion_reasons).toEqual(['event_projection_unsupported']);
  });

  it('honors required, optional, and disabled lanes, including a valid all-disabled empty packet', () => {
    const allDisabled = manifest({ lane_requirements: { governing: 'disabled', current_state: 'disabled', open_state: 'disabled', evidence: 'disabled', context_only: 'disabled', warnings: 'disabled' } });
    const packet = assembleTaskStatePacket(input({ manifest: allDisabled }));
    expect(packet.unresolved).not.toContain('required_lane_unresolved');
    expect(packet.warnings).toEqual([]);
    expect(packet.unresolved).toEqual([]);
    expect(packet.governing).toEqual([]);
    const poisonedAllDisabled = assembleTaskStatePacket(input({ manifest: allDisabled, sources: {
      memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2), memory(3), memory(4)],
      event_chain: { project_id: 'project-a', task_id: 'task-a', valid: false },
      events: [{ event_id: 'poison', project_id: 'project-a', task_id: 'task-a', sequence: 1, event_hash: hash('b'), integrity_valid: false }],
      contradiction_receipts: [{ receipt_id: 'poison', project_id: 'project-a', task_id: 'task-a', left: ref(2), right: ref(3), explicit: true }],
    } }));
    expect(poisonedAllDisabled.warnings).toEqual([]);
    expect(poisonedAllDisabled.unresolved).toEqual([]);
    expect(poisonedAllDisabled.verification.source_references).toEqual([]);
    const mismatchedAllDisabled = assembleTaskStatePacket(input({ manifest: {
      ...allDisabled,
      task_id: 'other-task',
      event_scope: { ...allDisabled.event_scope, task_id: 'other-task' },
    } }));
    expect(mismatchedAllDisabled.warnings).toEqual([]);
    expect(mismatchedAllDisabled.unresolved).toEqual(['task_identity_unresolved']);
    expect(mismatchedAllDisabled.verification.source_references).toEqual([]);
    const warningsDisabled = assembleTaskStatePacket(input({ manifest: manifest({
      task: { ...manifest().task, objective: { statement: 'Absent but diagnosable.', required: true, sources: [ref(99)] } },
      lane_requirements: { ...manifest().lane_requirements, warnings: 'disabled' },
    }) }));
    expect(warningsDisabled.warnings).toEqual([]);
    expect(warningsDisabled.unresolved).toContain('source_not_found');
    const requiredEvidence = assembleTaskStatePacket(input({ manifest: manifest({ lane_requirements: { ...manifest().lane_requirements, evidence: 'required' } }) }));
    expect(requiredEvidence.warnings).toContain('missing_evidence');
    expect(requiredEvidence.unresolved).toContain('required_lane_unresolved');
    const requiredWarningsEmpty = assembleTaskStatePacket(input({ manifest: manifest({ lane_requirements: { ...manifest().lane_requirements, warnings: 'required' } }) }));
    expect(requiredWarningsEmpty.warnings).toEqual([]);
    expect(requiredWarningsEmpty.unresolved).toContain('required_lane_unresolved');
    const optionalWarningsEmpty = assembleTaskStatePacket(input());
    expect(optionalWarningsEmpty.warnings).toEqual([]);
    expect(optionalWarningsEmpty.unresolved).not.toContain('required_lane_unresolved');
  });

  it('keeps Contract 1.1 adoption diagnostics when all lanes are disabled and excludes evaluated_at from packet digests', () => {
    const receipt = { kind: 'operator_receipt' as const, receipt_id: 'b1b2b3b4-c5c6-4d47-8e89-a1b2c3d4e5f6', project_id: 'project-a', task_id: 'task-a' };
    const v11 = manifest({ schema_version: '1.1.0', adoption: { status: 'operator_adopted', source: receipt }, lane_requirements: { governing: 'disabled', current_state: 'disabled', open_state: 'disabled', evidence: 'disabled', context_only: 'disabled', warnings: 'disabled' } });
    const verdict = { status: 'unverified' as const, capability: 'task_state_governing' as const, authority_ceiling: 'task_orientation_only' as const, manifest_sha256: hash('m'), evaluated_at: '2026-09-02T00:00:00.000Z', failure_codes: ['trust_registry_unavailable', 'manifest_adoption_unverified'] as Array<'trust_registry_unavailable' | 'manifest_adoption_unverified'> };
    const one = assembleTaskStatePacket(input({ manifest: v11, adoption_verdict: verdict }));
    const two = assembleTaskStatePacket(input({ manifest: v11, adoption_verdict: { ...verdict, evaluated_at: '2026-09-02T00:00:01.000Z' } }));
    expect(one).toMatchObject({ contract_version: '1.1.0' }); expect(one.unresolved).toContain('trust_registry_unavailable'); expect(one.verification.adoption?.evaluated_at).toBe(verdict.evaluated_at); expect(two.packet_digest).toBe(one.packet_digest);
  });

  it('classifies absent, out-of-scope, mismatch, and unavailable source versions with only Contract v1 codes', () => {
    const absent = assembleTaskStatePacket(input({ manifest: manifest({ task: { ...manifest().task, objective: { statement: 'Absent.', required: true, sources: [ref(99)] } } }) }));
    expect(absent.unresolved).toContain('source_not_found');
    expect(absent.warnings).toContain('missing_required_source');
    const partial = assembleTaskStatePacket(input({ manifest: manifest({ task: { ...manifest().task, objective: { statement: 'One source resolves.', required: true, sources: [ref(2), ref(99)] } } }) }));
    expect(partial.unresolved).toContain('source_not_found');
    expect(partial.warnings).not.toContain('missing_required_source');
    const mismatch = assembleTaskStatePacket(input({ manifest: manifest({ task: { ...manifest().task, objective: { statement: 'Drift.', required: true, sources: [{ kind: 'memory', id: 2, project_id: 'project-a', expected_updated_at: '2026-01-01T00:00:00.000Z' }] } } }) }));
    expect(mismatch.warnings).toContain('source_version_mismatch');
    const unavailable = assembleTaskStatePacket(input({ sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2, 'project-a', { authoritative_version_token_available: false }), memory(3), memory(4)] } }));
    expect(unavailable.unresolved).toContain('source_version_unverified');
    const eventRef = { kind: 'cognitive_event', event_id: 'old', project_id: 'project-a', task_id: 'task-a', expected_event_hash: hash('b') } as const;
    const bounded = assembleTaskStatePacket(input({ manifest: manifest({ task: { ...manifest().task, objective: { statement: 'Bounded.', required: false, sources: [eventRef] } }, event_scope: { project_id: 'project-a', task_id: 'task-a', after_sequence: 5, allow_legacy_v1_context: false } }), sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(3), memory(4)], events: [{ event_id: 'old', project_id: 'project-a', task_id: 'task-a', sequence: 2, event_hash: hash('b'), integrity_valid: true }] } }));
    expect(bounded.unresolved).toContain('source_out_of_scope');
    const eventMismatch = assembleTaskStatePacket(input({ manifest: manifest({ task: { ...manifest().task, objective: { statement: 'Hash-bound.', required: true, sources: [{ kind: 'cognitive_event', event_id: 'hash-event', project_id: 'project-a', task_id: 'task-a', expected_event_hash: hash('e') }] } } }), sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(3), memory(4)], events: [{ event_id: 'hash-event', project_id: 'project-a', task_id: 'task-a', sequence: 8, event_hash: hash('f'), integrity_valid: true }] } }));
    expect(eventMismatch.warnings).toContain('source_version_mismatch');
  });

  it('fails closed when the adoption source itself is version-mismatched', () => {
    const versionDriftedAdoption = assembleTaskStatePacket(input({ manifest: manifest({
      adoption: { status: 'operator_adopted', source: { kind: 'memory', id: 1, project_id: 'project-a', expected_updated_at: '2026-01-01T00:00:00.000Z' } },
    }) }));
    expect(versionDriftedAdoption.warnings).toContain('source_version_mismatch');
    expect(versionDriftedAdoption.unresolved).toContain('manifest_adoption_unverified');
    expect(versionDriftedAdoption.governing).toEqual([]);
  });

  it.each(['superseded', 'archived', 'invalid'] as const)(
    'keeps %s memory sources out of governing state',
    (status) => {
      const inactiveStatement = assembleTaskStatePacket(input({
        sources: {
          memories: [
            memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }),
            memory(2, 'project-a', { status }),
            memory(3),
            memory(4),
          ],
        },
      }));
      expect(inactiveStatement.unresolved).toContain('source_out_of_scope');
      expect(inactiveStatement.governing.some((item) => item.source.kind === 'memory' && item.source.id === 2)).toBe(false);

      const inactiveAdoption = assembleTaskStatePacket(input({
        sources: {
          memories: [
            memory(1, 'project-a', { status, operator_adoption_verified: true, external_to_manifest: true }),
            memory(2),
            memory(3),
            memory(4),
          ],
        },
      }));
      expect(inactiveAdoption.unresolved).toEqual(expect.arrayContaining([
        'manifest_adoption_unverified',
        'source_out_of_scope',
      ]));
      expect(inactiveAdoption.governing).toEqual([]);
    },
  );

  it('requires event identity/hash/integrity and explicit evidence provenance, while keeping envelopes unsupported', () => {
    const packet = assembleTaskStatePacket(input({ sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2), memory(3), memory(4), memory(7)], event_chain: { project_id: 'project-a', task_id: 'task-a', valid: false, failing_sequence: 2 }, events: [
      { event_id: 'evidence', project_id: 'project-a', task_id: 'task-a', sequence: 2, event_hash: hash('c'), schema_version: 2, event_type: 'EvidenceObserved', integrity_valid: true, payload: { source_memory_id: 7 } },
      { event_id: 'envelope', project_id: 'project-a', task_id: 'task-a', sequence: 3, event_hash: hash('d'), integrity_valid: true, task_state: { version: '1.0.0', state_id: 'open-1', role: 'open_state', status: 'open', statement: 'Await approval.' } },
    ] } }));
    expect(packet.warnings).toContain('event_chain_invalid');
    expect(packet.evidence).toHaveLength(1);
    expect(packet.evidence[0].source.kind).toBe('cognitive_event');
    expect(packet.unresolved).toContain('event_projection_unsupported');
    expect(packet.open_state).toEqual([]);
    const unavailableSupport = assembleTaskStatePacket(input({ sources: {
      memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2), memory(3), memory(4), memory(7, 'project-a', { authoritative_version_token_available: false })],
      events: [{ event_id: 'unavailable-support', project_id: 'project-a', task_id: 'task-a', sequence: 2, event_hash: hash('e'), schema_version: 2, event_type: 'EvidenceObserved', integrity_valid: true, payload: { source_memory_id: 7 } }],
    } }));
    expect(unavailableSupport.unresolved).toContain('source_version_unverified');
    expect(unavailableSupport.evidence).toEqual([]);
  });

  it('uses explicit contradiction/review evidence and never treats age alone as stale', () => {
    const reviewed = assembleTaskStatePacket(input({ evaluation_time: '2026-08-29T00:00:00.000Z', manifest: manifest({ review_policy: { review_after: '2026-01-01T00:00:00.000Z', validation_sources: [ref(2)] } }), sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2), memory(3), memory(4)], validation_after_deadline: [{ source: ref(2), validated_at: '2026-02-01T00:00:00.000Z' }] } }));
    expect(reviewed.warnings).not.toContain('review_due');
    const mismatchedValidation = assembleTaskStatePacket(input({ evaluation_time: '2026-08-29T00:00:00.000Z', manifest: manifest({ review_policy: { review_after: '2026-01-01T00:00:00.000Z', validation_sources: [ref(2)] } }), sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2), memory(3), memory(4)], validation_after_deadline: [{ source: { kind: 'memory', id: 2, project_id: 'project-a', expected_updated_at: '2026-01-01T00:00:00.000Z' }, validated_at: '2026-02-01T00:00:00.000Z' }] } }));
    expect(mismatchedValidation.warnings).toContain('review_due');
    const unavailableValidation = assembleTaskStatePacket(input({ evaluation_time: '2026-08-29T00:00:00.000Z', manifest: manifest({ review_policy: { review_after: '2026-01-01T00:00:00.000Z', validation_sources: [ref(8)] } }), sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2), memory(3), memory(4), memory(8, 'project-a', { authoritative_version_token_available: false })], validation_after_deadline: [{ source: ref(8), validated_at: '2026-02-01T00:00:00.000Z' }] } }));
    expect(unavailableValidation.warnings).toContain('review_due');
    const overdue = assembleTaskStatePacket(input({ evaluation_time: '2026-08-29T00:00:00.000Z', manifest: manifest({ review_policy: { review_after: '2026-01-01T00:00:00.000Z' } }) }));
    expect(overdue.warnings).toContain('review_due');
    expect(overdue.unresolved).not.toContain('source_version_mismatch');
    const contradiction = assembleTaskStatePacket(input({ manifest: manifest({ task: { ...manifest().task, objective: { statement: 'Two sources.', required: false, sources: [ref(2), ref(3)] } } }), sources: { memories: [memory(1, 'project-a', { operator_adoption_verified: true, external_to_manifest: true }), memory(2, 'project-a', { content: 'permit' }), memory(3, 'project-a', { content: 'deny' }), memory(4)], contradiction_receipts: [{ receipt_id: 'r', project_id: 'project-a', task_id: 'task-a', left: ref(2), right: ref(3), explicit: true }] } }));
    expect(contradiction.warnings).toContain('explicit_contradiction_present');
  });

  it('is deterministic, bounded, and does not mutate its input', () => {
    const long = 'x'.repeat(200);
    const state = input({ manifest: manifest({ limits: { max_items_per_lane: 1, max_preview_characters: 20 }, task: { ...manifest().task, constraints: [{ statement: long, required: true, sources: [ref(4)] }, { statement: long, required: true, sources: [ref(3)] }] } }) });
    const before = structuredClone(state);
    const one = assembleTaskStatePacket(state);
    const two = assembleTaskStatePacket(structuredClone(state));
    expect(one).toEqual(two);
    expect(one.packet_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(one.governing).toHaveLength(1);
    expect(one.limits.estimated_tokens).toBeGreaterThan(0);
    expect(state).toEqual(before);
  });

  it('leaves every logical row in a disposable database unchanged', () => {
    const db = createInMemoryDb();
    try {
      seedMemory(db, { title: 'Zero-write sentinel', content: 'Must remain untouched.', project_id: 'project-a' });
      const logicalSnapshot = () => {
        const tables = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all() as Array<{ name: string }>;
        return Object.fromEntries(tables.map(({ name }) => {
          const quoted = `"${name.replaceAll('"', '""')}"`;
          const rows = db.prepare(`SELECT * FROM ${quoted}`).all();
          return [name, rows.map((row) => JSON.stringify(row)).sort()];
        }));
      };
      const before = logicalSnapshot();
      assembleTaskStatePacket(input());
      expect(logicalSnapshot()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('exports no invented classifications beyond the frozen Contract v1 vocabulary', () => {
    const result = assembleTaskStatePacket({ project_id: 'project-a', task_id: 'task-a', manifest: null });
    expect(result.unresolved).toEqual(['missing_task_manifest']);
    expect([...TASK_STATE_WARNING_CODES, ...TASK_STATE_UNRESOLVED_CODES]).toEqual([
      'cross_project_source', 'global_source_not_authorized', 'missing_required_source', 'source_version_mismatch',
      'event_chain_invalid', 'missing_evidence', 'review_due', 'explicit_contradiction_present',
      'missing_task_manifest', 'task_identity_unresolved', 'manifest_adoption_unverified', 'required_lane_unresolved',
      'source_not_found', 'source_out_of_scope', 'source_version_unverified', 'event_projection_unsupported',
    ]);
  });
});
