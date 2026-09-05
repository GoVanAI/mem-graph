import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { listCognitiveEvents, verifyCognitiveEventChain } from './events.js';
import { validateTaskStateManifest } from './task-state-manifest.js';
import { loadProtectedOperatorTrustRegistry, type OperatorTrustRuntime } from './operator-trust-loader.js';
import { verifyOperatorAdoption } from './operator-adoption.js';
import {
  assembleTaskStatePacket,
  type TaskStateEventSource,
  type TaskStateMemorySource,
  type TaskStateSourceRef,
} from './task-state.js';
import type { TaskStateBootstrapEnvelope, TaskStateBootstrapRequest } from './types.js';

const authorityNotice = 'This Contract-v1 packet is separate from bootstrap guidance. Manifest status, retrieval rank, repetition, event type, artifact presence, and caller input do not grant authority.';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function envelopeDigest(value: Omit<TaskStateBootstrapEnvelope, 'envelope_digest'>): string {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const adoption = ((copy.packet as Record<string, unknown> | undefined)?.verification as Record<string, unknown> | undefined)?.adoption as Record<string, unknown> | undefined;
  if (adoption) delete adoption.evaluated_at;
  return createHash('sha256').update(stableJson(copy), 'utf8').digest('hex');
}

function unavailable(request: TaskStateBootstrapRequest | undefined, reason: TaskStateBootstrapEnvelope['reason']): TaskStateBootstrapEnvelope {
  const envelope = {
    envelope_version: '1.0.0' as const,
    status: 'unavailable' as const,
    scope: { project_id: request?.project_id ?? null, task_id: request?.task_id ?? null },
    authority_notice: authorityNotice,
    reason,
  };
  return { ...envelope, envelope_digest: envelopeDigest(envelope) };
}

function sourceKey(ref: TaskStateSourceRef): string {
  if (ref.kind === 'memory') return `memory:${ref.id}`;
  if (ref.kind === 'cognitive_event') return `event:${ref.event_id}`;
  if (ref.kind === 'epistemic_record') return `epistemic:${ref.record_id}`;
  return `artifact:${ref.path}`;
}

function manifestReferences(manifest: ReturnType<typeof validateTaskStateManifest> & { ok: true }): TaskStateSourceRef[] {
  const refs: TaskStateSourceRef[] = manifest.manifest.adoption.source.kind === 'operator_receipt' ? [] : [manifest.manifest.adoption.source];
  const statements = [manifest.manifest.task.objective, manifest.manifest.task.definition_of_done, ...manifest.manifest.task.constraints, ...(manifest.manifest.task.expected_next_action ? [manifest.manifest.task.expected_next_action] : [])];
  for (const item of statements) refs.push(...item.sources);
  refs.push(...(manifest.manifest.governing_sources ?? []));
  refs.push(...(manifest.manifest.review_policy?.validation_sources ?? []));
  return [...new Map(refs.map((ref) => [sourceKey(ref), ref])).values()];
}

function readMemories(db: Database.Database, refs: TaskStateSourceRef[]): TaskStateMemorySource[] {
  const ids = [...new Set(refs.filter((ref): ref is Extract<TaskStateSourceRef, { kind: 'memory' }> => ref.kind === 'memory').map((ref) => ref.id))];
  if (ids.length === 0) return [];
  const rows = db.prepare(`SELECT id, project_id, updated_at, content, status FROM memories WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`).all(...ids) as Array<{ id: number; project_id: string; updated_at: string; content: string; status: TaskStateMemorySource['status'] }>;
  return rows.map((row) => ({ ...row, content_sha256: createHash('sha256').update(row.content, 'utf8').digest('hex') }));
}

function taskStateEnvelope(value: unknown): TaskStateEventSource['task_state'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  const roles = ['current_state', 'open_state', 'evidence', 'completion', 'warning'];
  const statuses = ['current', 'open', 'blocked', 'pending', 'resolved', 'completed', 'superseded'];
  if (envelope.version !== '1.0.0'
    || typeof envelope.state_id !== 'string' || envelope.state_id.length === 0
    || typeof envelope.role !== 'string' || !roles.includes(envelope.role)
    || typeof envelope.status !== 'string' || !statuses.includes(envelope.status)
    || typeof envelope.statement !== 'string' || envelope.statement.length === 0) return undefined;
  return envelope as unknown as TaskStateEventSource['task_state'];
}

function toEventSource(
  event: ReturnType<typeof listCognitiveEvents>[number],
  integrityValid: boolean,
): TaskStateEventSource {
  return {
    event_id: event.event_id, project_id: event.project_id, task_id: event.task_id,
    sequence: event.sequence, event_hash: event.event_hash, event_type: event.event_type,
    schema_version: event.schema_version, observed_at: event.observed_at,
    correlation_id: event.correlation_id, causation_id: event.causation_id, payload: event.payload,
    integrity_valid: integrityValid,
    ...(taskStateEnvelope(event.payload.task_state) ? { task_state: taskStateEnvelope(event.payload.task_state) } : {}),
  };
}

function readEpistemic(db: Database.Database, refs: TaskStateSourceRef[]): Array<{ record_id: string; project_id: string; revision: number; statement: string }> {
  const ids = [...new Set(refs.filter((ref): ref is Extract<TaskStateSourceRef, { kind: 'epistemic_record' }> => ref.kind === 'epistemic_record').map((ref) => ref.record_id))];
  if (ids.length === 0) return [];
  const numericIds = ids.filter((id) => /^\d+$/.test(id)).map(Number);
  if (numericIds.length === 0) return [];
  const rows = db.prepare(`SELECT r.record_id, r.revision_number, r.record_payload FROM epistemic_revisions r INNER JOIN (SELECT record_id, MAX(revision_number) AS revision_number FROM epistemic_revisions GROUP BY record_id) latest ON latest.record_id = r.record_id AND latest.revision_number = r.revision_number WHERE r.superseded_by_record_id IS NULL AND r.record_id IN (${numericIds.map(() => '?').join(',')}) ORDER BY r.record_id ASC`).all(...numericIds) as Array<{ record_id: number; revision_number: number; record_payload: string }>;
  return rows.flatMap((row) => {
    try {
      const payload = JSON.parse(row.record_payload) as Record<string, unknown>;
      const projectId = typeof payload.project_id === 'string' ? payload.project_id : '';
      const statement = typeof payload.statement === 'string' ? payload.statement : '';
      return [{ record_id: String(row.record_id), project_id: projectId, revision: row.revision_number, statement }];
    } catch { return []; }
  });
}

/** Compose a server-owned snapshot. No caller-provided sources or adoption flags cross this boundary. */
export function composeTaskStateBootstrap(
  db: Database.Database,
  request: TaskStateBootstrapRequest | undefined,
  trustRuntime?: OperatorTrustRuntime,
): TaskStateBootstrapEnvelope {
  if (!request || typeof request.project_id !== 'string' || typeof request.task_id !== 'string') return unavailable(undefined, 'invalid_request');
  try {
    const validated = validateTaskStateManifest(request.manifest);
    if (!validated.ok) return unavailable(request, 'manifest_invalid');
    const manifest = validated.manifest;
    const refs = manifestReferences(validated);
    const chain = verifyCognitiveEventChain(db);
    const scopedEvents = listCognitiveEvents(db, { project_id: request.project_id, task_id: request.task_id });
    for (const event of scopedEvents) {
      if (typeof event.payload.source_memory_id === 'number' && Number.isInteger(event.payload.source_memory_id)) refs.push({ kind: 'memory', id: event.payload.source_memory_id, project_id: event.project_id });
      if (typeof event.payload.source_event_id === 'string' && event.payload.source_event_id.length > 0) refs.push({ kind: 'cognitive_event', event_id: event.payload.source_event_id, project_id: event.project_id, task_id: event.task_id });
    }
    const directEvents = refs.filter((ref): ref is Extract<TaskStateSourceRef, { kind: 'cognitive_event' }> => ref.kind === 'cognitive_event');
    const eventIds = [...new Set(directEvents.map((ref) => ref.event_id))];
    const directRows = eventIds.length === 0 ? [] : db.prepare(`SELECT sequence, event_id, event_type, task_id, project_id, session_id, correlation_id, causation_id, idempotency_key, payload, schema_version, observed_at, created_at, previous_hash, event_hash FROM cognitive_events WHERE event_id IN (${eventIds.map(() => '?').join(',')}) ORDER BY sequence ASC`).all(...eventIds) as Array<Record<string, unknown>>;
    const directSources = directRows.flatMap((row) => {
      try {
        return [toEventSource({ ...row, sequence: Number(row.sequence), event_id: String(row.event_id), event_type: String(row.event_type) as ReturnType<typeof listCognitiveEvents>[number]['event_type'], task_id: String(row.task_id), project_id: String(row.project_id), session_id: row.session_id as string | null, correlation_id: row.correlation_id as string | null, causation_id: row.causation_id as string | null, idempotency_key: row.idempotency_key as string | null, payload: JSON.parse(String(row.payload)) as Record<string, unknown>, schema_version: Number(row.schema_version), observed_at: String(row.observed_at), created_at: String(row.created_at), previous_hash: row.previous_hash as string | null, event_hash: String(row.event_hash) }, chain.valid)];
      } catch { return []; }
    });
    const events = [...new Map([...scopedEvents.map((event) => toEventSource(event, chain.valid)), ...directSources].map((event) => [event.event_id, event])).values()].sort((left, right) => left.sequence - right.sequence || left.event_id.localeCompare(right.event_id));
    const sources = {
      memories: readMemories(db, refs), events,
      epistemic_records: readEpistemic(db, refs),
      event_chain: { project_id: request.project_id, task_id: request.task_id, valid: chain.valid, ...(chain.failing_sequence !== undefined ? { failing_sequence: chain.failing_sequence } : {}) },
      // Contract v1 has no server-owned typed contradiction or validation source yet.
      contradiction_receipts: [], validation_after_deadline: [], artifacts: [],
    };
    const evaluationTime = new Date().toISOString();
    const adoptionVerdict = manifest.schema_version === '1.1.0'
      ? verifyOperatorAdoption({ receipt: request.adoption_receipt, registry: loadProtectedOperatorTrustRegistry(trustRuntime), startup: trustRuntime?.startup, manifest, manifest_receipt_ref: manifest.adoption.source, request_scope: { project_id: request.project_id, task_id: request.task_id, include_global: request.include_global === true }, event_scope: { project_id: manifest.event_scope.project_id, task_id: manifest.event_scope.task_id }, evaluated_at: evaluationTime })
      : undefined;
    // A Contract 1.1 request may reach this boundary with a caller-requested
    // global scope, but it becomes effective only after the signed receipt has
    // granted it. This preserves the three-way global gate at composition.
    const includeGlobal = manifest.schema_version === '1.1.0'
      ? adoptionVerdict?.status === 'verified' && request.include_global === true && manifest.include_global === true
      : request.include_global === true && manifest.include_global === true;
    const packet = assembleTaskStatePacket({
      project_id: request.project_id, task_id: request.task_id,
      include_global: includeGlobal,
      manifest, sources, evaluation_time: evaluationTime, classification_contract_version: manifest.schema_version,
      ...(adoptionVerdict ? { adoption_verdict: adoptionVerdict } : {}),
    });
    const envelope = { envelope_version: manifest.schema_version === '1.1.0' ? '1.1.0' as const : '1.0.0' as const, status: 'assembled' as const, scope: { project_id: request.project_id, task_id: request.task_id }, authority_notice: authorityNotice, packet };
    return { ...envelope, envelope_digest: envelopeDigest(envelope) };
  } catch {
    return unavailable(request, 'source_resolution_failed');
  }
}
