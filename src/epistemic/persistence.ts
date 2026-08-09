/**
 * Epistemic Memory Phase B — atomic admission and projection persistence.
 *
 * Per EPB-001 D6/D7/D17/D19 and [[283]] Step 5 acceptance, this module:
 *   - validates and normalizes a record + provenance envelope;
 *   - resolves idempotency (D7) by SHA-256 of the canonical JSON envelope;
 *   - enforces expected_revision concurrency (D6) with stable STALE_REVISION;
 *   - refuses non-empty relations with RELATION_PERSISTENCE_NOT_ADOPTED (D21 Option A);
 *   - appends a typed cognitive source event (BeliefRevised) inside one outer transaction;
 *   - appends immutable revision + provenance rows;
 *   - upserts the current projection (epistemic_records);
 *   - rolls back every write on any failure, including the source event.
 *
 * Read-only paths (query, integrity, contradictions, review queue, bootstrap)
 * are NOT implemented here; they live in Step 6/7/8.
 */

import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { appendCognitiveEvent } from '../cognitive/events.js';

/** Stable error codes from EPB-001 D17. */
export const EPISTEMIC_ERROR_CODES = {
  STALE_REVISION: 'STALE_REVISION',
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  IDEMPOTENCY_PAYLOAD_MISMATCH: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  FUTURE_EVIDENCE: 'FUTURE_EVIDENCE',
  RELATION_PERSISTENCE_NOT_ADOPTED: 'RELATION_PERSISTENCE_NOT_ADOPTED',
  INVALID_EVENT_VERSION: 'INVALID_EVENT_VERSION',
  SCHEMA_MIGRATION_REQUIRED: 'SCHEMA_MIGRATION_REQUIRED',
  READ_ONLY_LANE: 'READ_ONLY_LANE',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_FIELD_TYPE: 'INVALID_FIELD_TYPE',
  INVALID_FIELD_VALUE: 'INVALID_FIELD_VALUE',
} as const;

export type EpistemicErrorCode =
  (typeof EPISTEMIC_ERROR_CODES)[keyof typeof EPISTEMIC_ERROR_CODES];

export class EpistemicAdmissionError extends Error {
  public readonly code: EpistemicErrorCode;
  public readonly path?: string;
  public readonly details?: Record<string, unknown>;
  constructor(
    code: EpistemicErrorCode,
    message: string,
    options: { path?: string; details?: Record<string, unknown> } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'EpistemicAdmissionError';
    this.code = code;
    this.path = options.path;
    this.details = options.details;
  }
}

export const EPISTEMIC_STATUSES = [
  'verified',
  'corroborated',
  'inferred',
  'reported',
  'assumed',
  'contested',
  'stale',
  'retracted',
] as const;
export type EpistemicStatus = (typeof EPISTEMIC_STATUSES)[number];

export const SCOPES = ['exact-project', '_global'] as const;
export type Scope = (typeof SCOPES)[number];

export interface AdmitEpistemicRecordInput {
  // Identity / idempotency (D7)
  idempotency_key: string;
  /** Optional explicit record_id; when absent, the next available integer is assigned. */
  record_id?: number;
  /** 0 = create, N > 0 = revise record N (D6). Required for revise; omit for create. */
  expected_revision?: number;
  /** Required for revise; references the prior revision. */
  previous_revision_id?: string;

  // Required content
  project_id: string;
  scope: Scope;
  statement: string;
  epistemic_status: EpistemicStatus;
  verification_level: string;
  source_quality: string;
  /** Finite number in [0, 1]. */
  confidence: number;
  /** ISO-8601 UTC string for valid_from; used for ordering and as-of queries. */
  valid_from: string;
  /** Optional ISO-8601 UTC for valid_until; supersession uses valid_until on the prior record. */
  valid_until?: string | null;

  // Optional provenance / memory linkage (D11, D20)
  source_memory_id?: number | null;
  supersedes_record_id?: number | null;
  superseded_by_record_id?: number | null;

  // Optional relations — D21 Option A: MUST be empty / undefined.
  relations?: unknown[];

  // Provenance details (D11, D13)
  provenance?: {
    excerpt_hash?: string | null;
    observed_at?: string | null;
    observed_by_role?: string | null;
    authority_input?: unknown;
  };

  // Audit envelope (cognitive event shape — D3 v2 BeliefRevised contract)
  task_id: string;
  session_id?: string;
  observed_at?: string;
}

export interface AdmitEpistemicRecordResult {
  record_id: number;
  revision_id: string;
  revision_number: number;
  event_id: string;
  sequence: number;
  idempotent_replay: boolean;
}

const FUTURE_EVIDENCE_SKEW_MS = 60_000;

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical JSON: recursively sorted object keys, finite numbers only. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const write = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new Error('canonical JSON cannot contain a non-finite number');
      }
      return JSON.stringify(item);
    }
    if (item === undefined) return 'null';
    if (typeof item !== 'object') {
      throw new Error(`canonical JSON cannot contain ${typeof item}`);
    }
    if (ancestors.has(item)) throw new Error('canonical JSON cannot contain circular references');
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      result = `[${item.map(write).join(',')}]`;
    } else {
      const entries: string[] = [];
      for (const key of Object.keys(item as Record<string, unknown>).sort()) {
        entries.push(`${JSON.stringify(key)}:${write((item as Record<string, unknown>)[key])}`);
      }
      result = `{${entries.join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  };
  return write(value);
}

function validateCommon(input: AdmitEpistemicRecordInput): void {
  if (!input || typeof input !== 'object') {
    throw new EpistemicAdmissionError(
      EPISTEMIC_ERROR_CODES.INVALID_FIELD_TYPE,
      'input must be a JSON object',
    );
  }
  if (typeof input.idempotency_key !== 'string' || input.idempotency_key.length === 0) {
    throw new EpistemicAdmissionError(
      EPISTEMIC_ERROR_CODES.MISSING_REQUIRED_FIELD,
      'idempotency_key must be a non-empty string',
    );
  }
  for (const path of ['task_id', 'project_id', 'scope', 'statement', 'epistemic_status',
                       'verification_level', 'source_quality', 'valid_from'] as const) {
    const v = input[path];
    if (typeof v !== 'string' || v.length === 0) {
      throw new EpistemicAdmissionError(
        EPISTEMIC_ERROR_CODES.MISSING_REQUIRED_FIELD,
        `${path} must be a non-empty string`,
        { path },
      );
    }
  }
  if (!SCOPES.includes(input.scope as Scope)) {
    throw new EpistemicAdmissionError(
      EPISTEMIC_ERROR_CODES.INVALID_FIELD_VALUE,
      `scope must be one of ${SCOPES.join(', ')}`,
      { path: 'scope' },
    );
  }
  if (!EPISTEMIC_STATUSES.includes(input.epistemic_status as EpistemicStatus)) {
    throw new EpistemicAdmissionError(
      EPISTEMIC_ERROR_CODES.INVALID_FIELD_VALUE,
      `epistemic_status must be one of ${EPISTEMIC_STATUSES.join(', ')}`,
      { path: 'epistemic_status' },
    );
  }
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) ||
      input.confidence < 0 || input.confidence > 1) {
    throw new EpistemicAdmissionError(
      EPISTEMIC_ERROR_CODES.INVALID_FIELD_TYPE,
      'confidence must be a finite number in [0,1]',
      { path: 'confidence' },
    );
  }
  // D21 Option A: refuse non-empty relations
  if (input.relations !== undefined) {
    if (!Array.isArray(input.relations) || input.relations.length > 0) {
      throw new EpistemicAdmissionError(
        EPISTEMIC_ERROR_CODES.RELATION_PERSISTENCE_NOT_ADOPTED,
        'first-class relation persistence is not adopted in Slice 1 (Option A); pass an empty array or omit',
        { path: 'relations' },
      );
    }
  }
  // D12: future evidence rejection
  const observedAt = input.observed_at ?? new Date().toISOString();
  const skew = Date.parse(observedAt) - Date.now();
  if (Number.isFinite(skew) && skew > FUTURE_EVIDENCE_SKEW_MS) {
    throw new EpistemicAdmissionError(
      EPISTEMIC_ERROR_CODES.FUTURE_EVIDENCE,
      `observed_at is more than ${FUTURE_EVIDENCE_SKEW_MS}ms in the future`,
      { path: 'observed_at' },
    );
  }
}

/**
 * Test-only knob: when set, the transaction throws at the indicated boundary
 * so the rollback path can be exercised. Real callers must never set this.
 */
export type FailureBoundary =
  | 'after_validate'
  | 'after_idempotency_lookup'
  | 'after_event_append'
  | 'after_revision_insert'
  | 'after_provenance_insert'
  | 'after_projection_upsert'
  | null;

export interface InternalAdmitOptions {
  __inject_failure_at?: FailureBoundary;
}

interface RevisionRow {
  revision_id: string;
  record_id: number;
  revision_number: number;
  record_payload: string;
  valid_from: string;
  valid_until: string | null;
  supersedes_record_id: number | null;
  superseded_by_record_id: number | null;
  source_event_id: string;
  created_at: string;
}

/**
 * Atomic idempotent admission. One transaction; failure at any boundary
 * rolls back every write. Returns the existing record on idempotent replay.
 */
export function admitEpistemicRecord(
  db: Database.Database,
  input: AdmitEpistemicRecordInput,
  internal: InternalAdmitOptions = {},
): AdmitEpistemicRecordResult {
  validateCommon(input);

  const now = new Date().toISOString();
  const observedAt = input.observed_at ?? now;
  const recordedBy = input.session_id ?? 'unknown';

  // The record_payload is the canonical, normalized projection of the
  // record's identity-bearing fields. Used both for hash verification and
  // for projection rebuild.
  const payloadObj = {
    project_id: input.project_id,
    scope: input.scope,
    statement: input.statement,
    epistemic_status: input.epistemic_status,
    verification_level: input.verification_level,
    source_quality: input.source_quality,
    confidence: input.confidence,
    valid_from: input.valid_from,
    valid_until: input.valid_until ?? null,
    source_memory_id: input.source_memory_id ?? null,
    supersedes_record_id: input.supersedes_record_id ?? null,
    superseded_by_record_id: input.superseded_by_record_id ?? null,
  };
  const recordPayload = canonicalJson(payloadObj);
  const payloadHash = sha256(recordPayload);

  return db.transaction((): AdmitEpistemicRecordResult => {
    if (internal.__inject_failure_at === 'after_validate') {
      throw new Error('injected failure after validate');
    }

    // (2) Idempotency lookup — same idempotency_key must produce same record.
    const existingEvent = db
      .prepare(
        `SELECT event_id, payload FROM cognitive_events
         WHERE idempotency_key = ?`,
      )
      .get(input.idempotency_key) as { event_id: string; payload: string } | undefined;
    if (existingEvent) {
      // Verify the canonical envelope matches. The cognitive_events payload
      // carries the request envelope; if it differs, refuse.
      const stored = JSON.parse(existingEvent.payload) as { envelope_hash?: string };
      if (stored.envelope_hash !== payloadHash) {
        throw new EpistemicAdmissionError(
          EPISTEMIC_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
          'idempotency_key was already used with a different epistemic envelope',
          { details: { stored_hash: stored.envelope_hash, computed_hash: payloadHash } },
        );
      }
      // Idempotent replay: find the existing revision and projection.
      const existingRevision = db
        .prepare(
          `SELECT revision_id, record_id, revision_number FROM epistemic_revisions
           WHERE source_event_id = ?`,
        )
        .get(existingEvent.event_id) as
        | { revision_id: string; record_id: number; revision_number: number }
        | undefined;
      if (!existingRevision) {
        throw new EpistemicAdmissionError(
          EPISTEMIC_ERROR_CODES.INVALID_EVENT_VERSION,
          'existing cognitive event has no corresponding epistemic revision',
        );
      }
      return {
        record_id: existingRevision.record_id,
        revision_id: existingRevision.revision_id,
        revision_number: existingRevision.revision_number,
        event_id: existingEvent.event_id,
        sequence: 0, // not appended
        idempotent_replay: true,
      };
    }

    if (internal.__inject_failure_at === 'after_idempotency_lookup') {
      throw new Error('injected failure after idempotency lookup');
    }

    // (3) Determine record_id and revision_number.
    let recordId: number;
    let revisionNumber: number;
    let priorRevisionId: string | null = null;

    if (input.expected_revision === undefined || input.expected_revision === 0) {
      // Create path
      if (input.record_id !== undefined) {
        recordId = input.record_id;
      } else {
        const maxRow = db
          .prepare('SELECT COALESCE(MAX(record_id), 0) AS m FROM epistemic_records')
          .get() as { m: number };
        recordId = Number(maxRow.m) + 1;
      }
      // Verify no existing record with this id (would otherwise be a revise)
      const existingRecord = db
        .prepare('SELECT record_id FROM epistemic_records WHERE record_id = ?')
        .get(recordId);
      if (existingRecord) {
        throw new EpistemicAdmissionError(
          EPISTEMIC_ERROR_CODES.STALE_REVISION,
          `record_id ${recordId} already exists; pass expected_revision > 0 to revise`,
          { details: { record_id: recordId } },
        );
      }
      revisionNumber = 1;
    } else {
      // Revise path
      if (typeof input.record_id !== 'number') {
        throw new EpistemicAdmissionError(
          EPISTEMIC_ERROR_CODES.MISSING_REQUIRED_FIELD,
          'record_id is required when expected_revision > 0',
          { path: 'record_id' },
        );
      }
      recordId = input.record_id;
      const current = db
        .prepare(
          `SELECT current_revision_id, revision_number FROM epistemic_records r
           JOIN epistemic_revisions v ON v.revision_id = r.current_revision_id
           WHERE r.record_id = ?`,
        )
        .get(recordId) as { current_revision_id: string; revision_number: number } | undefined;
      if (!current) {
        throw new EpistemicAdmissionError(
          EPISTEMIC_ERROR_CODES.STALE_REVISION,
          `record_id ${recordId} does not exist; pass expected_revision = 0 to create`,
          { details: { record_id: recordId } },
        );
      }
      if (current.revision_number !== input.expected_revision) {
        throw new EpistemicAdmissionError(
          EPISTEMIC_ERROR_CODES.STALE_REVISION,
          `expected_revision ${input.expected_revision} does not match current ${current.revision_number}`,
          {
            details: {
              record_id: recordId,
              expected: input.expected_revision,
              current: current.revision_number,
            },
          },
        );
      }
      if (input.previous_revision_id !== undefined &&
          input.previous_revision_id !== current.current_revision_id) {
        throw new EpistemicAdmissionError(
          EPISTEMIC_ERROR_CODES.STALE_REVISION,
          'previous_revision_id does not match the current revision',
          {
            details: {
              expected_previous: current.current_revision_id,
              got_previous: input.previous_revision_id,
            },
          },
        );
      }
      priorRevisionId = current.current_revision_id;
      revisionNumber = current.revision_number + 1;
    }

    // (4) Append typed cognitive source event (BeliefRevised v2).
    const envelope = {
      envelope_hash: payloadHash,
      record_id: String(recordId),
      revision_number: revisionNumber,
      previous_revision_id: priorRevisionId,
      statement: input.statement,
      epistemic_status: input.epistemic_status,
      confidence: input.confidence,
      scope: input.scope,
    };
    const ev = appendCognitiveEvent(db, {
      event_type: 'BeliefRevised',
      task_id: input.task_id,
      project_id: input.project_id,
      payload: envelope,
      session_id: input.session_id,
      correlation_id: 'epistemic-kernel-activation-phase-b',
      idempotency_key: input.idempotency_key,
      observed_at: observedAt,
      schema_version: 2,
    });

    if (internal.__inject_failure_at === 'after_event_append') {
      throw new Error('injected failure after event append');
    }

    // (5) Append immutable revision row.
    const revisionId = randomUUID();
    const createdAt = now;
    const revisionRow: RevisionRow = {
      revision_id: revisionId,
      record_id: recordId,
      revision_number: revisionNumber,
      record_payload: recordPayload,
      valid_from: input.valid_from,
      valid_until: input.valid_until ?? null,
      supersedes_record_id: input.supersedes_record_id ?? null,
      superseded_by_record_id: input.superseded_by_record_id ?? null,
      source_event_id: ev.event_id,
      created_at: createdAt,
    };
    db.prepare(
      `INSERT INTO epistemic_revisions
       (revision_id, record_id, revision_number, previous_revision_id, record_payload,
        valid_from, valid_until, supersedes_record_id, superseded_by_record_id,
        source_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revisionRow.revision_id,
      revisionRow.record_id,
      revisionRow.revision_number,
      priorRevisionId,
      revisionRow.record_payload,
      revisionRow.valid_from,
      revisionRow.valid_until,
      revisionRow.supersedes_record_id,
      revisionRow.superseded_by_record_id,
      revisionRow.source_event_id,
      revisionRow.created_at,
    );

    if (internal.__inject_failure_at === 'after_revision_insert') {
      throw new Error('injected failure after revision insert');
    }

    // (6) Append immutable provenance row.
    db.prepare(
      `INSERT INTO epistemic_provenance
       (record_id, revision_id, source_memory_id, source_event_id, excerpt_hash,
        observed_at, recorded_by, observed_by_role, authority_input)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recordId,
      revisionId,
      input.source_memory_id ?? null,
      ev.event_id,
      input.provenance?.excerpt_hash ?? null,
      input.provenance?.observed_at ?? observedAt,
      recordedBy,
      input.provenance?.observed_by_role ?? null,
      input.provenance?.authority_input !== undefined
        ? canonicalJson(input.provenance.authority_input)
        : null,
    );

    if (internal.__inject_failure_at === 'after_provenance_insert') {
      throw new Error('injected failure after provenance insert');
    }

    // (7) Upsert current projection.
    db.prepare(
      `INSERT INTO epistemic_records
       (record_id, project_id, scope, statement, epistemic_status, verification_level,
        source_quality, confidence, valid_from, valid_until, current_revision_id,
        source_event_id, source_memory_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(record_id) DO UPDATE SET
         scope = excluded.scope,
         statement = excluded.statement,
         epistemic_status = excluded.epistemic_status,
         verification_level = excluded.verification_level,
         source_quality = excluded.source_quality,
         confidence = excluded.confidence,
         valid_from = excluded.valid_from,
         valid_until = excluded.valid_until,
         current_revision_id = excluded.current_revision_id,
         source_event_id = excluded.source_event_id,
         source_memory_id = excluded.source_memory_id,
         updated_at = excluded.updated_at
       WHERE excluded.source_event_id = epistemic_records.source_event_id
          OR epistemic_records.current_revision_id = ?`,
    ).run(
      recordId,
      input.project_id,
      input.scope,
      input.statement,
      input.epistemic_status,
      input.verification_level,
      input.source_quality,
      input.confidence,
      input.valid_from,
      input.valid_until ?? null,
      revisionId,
      ev.event_id,
      input.source_memory_id ?? null,
      createdAt,
      createdAt,
      priorRevisionId,
    );

    if (internal.__inject_failure_at === 'after_projection_upsert') {
      throw new Error('injected failure after projection upsert');
    }

    return {
      record_id: recordId,
      revision_id: revisionId,
      revision_number: revisionNumber,
      event_id: ev.event_id,
      sequence: ev.sequence,
      idempotent_replay: false,
    };
  })();
}

/**
 * Append an epistemic receipt without altering the current projection.
 * Receipts are append-only evidence that link a revision to outcomes,
 * challenges, uses, or contradictions.
 */
export function appendEpistemicReceipt(
  db: Database.Database,
  input: {
    idempotency_key: string;
    record_id: number;
    revision_id: string;
    receipt_type:
      | 'ChallengeReceipt'
      | 'BeliefUseReceipt'
      | 'DecisionOutcomeReceipt'
      | 'ContradictionSignal'
      | 'ReviewDeadlineReceipt';
    receipt_payload: unknown;
    independence_key?: string | null;
    observed_at: string;
    task_id: string;
    project_id: string;
    session_id?: string;
  },
): { receipt_id: string; event_id: string; sequence: number } {
  if (typeof input.record_id !== 'number') {
    throw new EpistemicAdmissionError(
      EPISTEMIC_ERROR_CODES.MISSING_REQUIRED_FIELD,
      'record_id must be a number',
    );
  }
  if (typeof input.revision_id !== 'string' || input.revision_id.length === 0) {
    throw new EpistemicAdmissionError(
      EPISTEMIC_ERROR_CODES.MISSING_REQUIRED_FIELD,
      'revision_id must be a non-empty string',
    );
  }

  const receiptPayloadJson = canonicalJson(input.receipt_payload);
  const receiptPayloadHash = sha256(receiptPayloadJson);

  return db.transaction(() => {
    // Verify the referenced revision exists.
    const rev = db
      .prepare('SELECT revision_id FROM epistemic_revisions WHERE revision_id = ?')
      .get(input.revision_id);
    if (!rev) {
      throw new EpistemicAdmissionError(
        EPISTEMIC_ERROR_CODES.STALE_REVISION,
        `revision_id ${input.revision_id} does not exist`,
      );
    }

    // Idempotency: same key + same payload hash returns the same receipt.
    const existingEvent = db
      .prepare('SELECT event_id FROM cognitive_events WHERE idempotency_key = ?')
      .get(input.idempotency_key) as { event_id: string } | undefined;
    if (existingEvent) {
      const existingReceipt = db
        .prepare(
          `SELECT receipt_id FROM epistemic_receipts WHERE source_event_id = ?`,
        )
        .get(existingEvent.event_id) as { receipt_id: string } | undefined;
      if (existingReceipt) {
        return {
          receipt_id: existingReceipt.receipt_id,
          event_id: existingEvent.event_id,
          sequence: 0,
        };
      }
    }

    const ev = appendCognitiveEvent(db, {
      event_type: 'BeliefRevised',
      task_id: input.task_id,
      project_id: input.project_id,
      payload: {
        record_id: String(input.record_id),
        receipt_type: input.receipt_type,
        receipt_payload_hash: receiptPayloadHash,
        independence_key: input.independence_key ?? null,
        genesis: true,
        statement: `Receipt appended: ${input.receipt_type} on revision ${input.revision_id}`,
        confidence: 1.0,
        epistemic_status: 'reported',
        scope: 'exact-project',
      },
      session_id: input.session_id,
      idempotency_key: input.idempotency_key,
      correlation_id: 'epistemic-kernel-activation-phase-b',
      observed_at: input.observed_at,
      schema_version: 2,
    });

    const receiptId = randomUUID();
    db.prepare(
      `INSERT INTO epistemic_receipts
       (receipt_id, record_id, revision_id, source_event_id, receipt_type, receipt_payload,
        independence_key, observed_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId,
      input.record_id,
      input.revision_id,
      ev.event_id,
      input.receipt_type,
      receiptPayloadJson,
      input.independence_key ?? null,
      input.observed_at,
      new Date().toISOString(),
    );

    return { receipt_id: receiptId, event_id: ev.event_id, sequence: ev.sequence };
  })();
}
