import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  COGNITIVE_EVENT_TYPES,
  type AppendCognitiveEventInput,
  type CognitiveEvent,
  type CognitiveEventType,
} from './types.js';

const SCHEMA_VERSION = 1;

export interface CognitiveEventListFilters {
  event_type?: CognitiveEventType;
  task_id?: string;
  project_id?: string;
  session_id?: string;
  correlation_id?: string;
  causation_id?: string;
  after_sequence?: number;
  before_sequence?: number;
  limit?: number;
}

export interface CognitiveEventChainVerification {
  valid: boolean;
  event_count: number;
  failing_sequence?: number;
  reason?: string;
}

interface EventRow {
  sequence: number;
  event_id: string;
  event_type: CognitiveEventType;
  task_id: string;
  project_id: string;
  session_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
  payload: string;
  schema_version: number;
  observed_at: string;
  created_at: string;
  previous_hash: string | null;
  event_hash: string;
  idempotency_hash: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** JSON with recursively sorted object keys, suitable for durable equality and hashing. */
function deterministicJson(value: unknown): string {
  const ancestors = new Set<object>();

  const write = (item: unknown, inArray: boolean): string | undefined => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Cognitive event JSON cannot contain a non-finite number');
      return JSON.stringify(item);
    }
    if (item === undefined) return inArray ? 'null' : undefined;
    if (typeof item !== 'object') {
      throw new Error(`Cognitive event JSON cannot contain ${typeof item}`);
    }
    if (ancestors.has(item)) throw new Error('Cognitive event JSON cannot contain circular references');

    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      result = `[${item.map((entry) => write(entry, true) ?? 'null').join(',')}]`;
    } else {
      const entries: string[] = [];
      for (const key of Object.keys(item).sort()) {
        const encoded = write((item as Record<string, unknown>)[key], false);
        if (encoded !== undefined) entries.push(`${JSON.stringify(key)}:${encoded}`);
      }
      result = `{${entries.join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  };

  const encoded = write(value, false);
  if (encoded === undefined) throw new Error('Cognitive event JSON cannot be undefined');
  return encoded;
}

function assertInput(input: AppendCognitiveEventInput): void {
  if (!COGNITIVE_EVENT_TYPES.includes(input.event_type)) {
    throw new Error(`Unsupported cognitive event type: ${input.event_type}`);
  }
  for (const [name, value] of Object.entries({
    task_id: input.task_id,
    project_id: input.project_id,
    session_id: input.session_id,
    correlation_id: input.correlation_id,
    causation_id: input.causation_id,
    idempotency_key: input.idempotency_key,
    observed_at: input.observed_at,
  })) {
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`${name} must be a non-empty string when provided`);
    }
  }
  if (input.payload === null || Array.isArray(input.payload) || typeof input.payload !== 'object') {
    throw new Error('payload must be a JSON object');
  }
}

function idempotencyHash(input: AppendCognitiveEventInput, payload: string): string {
  return sha256(deterministicJson({
    event_type: input.event_type,
    task_id: input.task_id,
    project_id: input.project_id,
    session_id: input.session_id ?? null,
    correlation_id: input.correlation_id ?? null,
    causation_id: input.causation_id ?? null,
    payload: JSON.parse(payload),
    observed_at: input.observed_at ?? null,
  }));
}

function eventHash(row: Omit<EventRow, 'event_hash'>): string {
  return sha256(deterministicJson({
    sequence: Number(row.sequence),
    event_id: row.event_id,
    event_type: row.event_type,
    task_id: row.task_id,
    project_id: row.project_id,
    session_id: row.session_id,
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    idempotency_key: row.idempotency_key,
    payload: JSON.parse(row.payload),
    schema_version: Number(row.schema_version),
    observed_at: row.observed_at,
    created_at: row.created_at,
    previous_hash: row.previous_hash,
    idempotency_hash: row.idempotency_hash,
  }));
}

function toCognitiveEvent(row: EventRow): CognitiveEvent {
  return {
    sequence: Number(row.sequence),
    event_id: row.event_id,
    event_type: row.event_type,
    task_id: row.task_id,
    project_id: row.project_id,
    session_id: row.session_id,
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    idempotency_key: row.idempotency_key,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    schema_version: Number(row.schema_version),
    observed_at: row.observed_at,
    created_at: row.created_at,
    previous_hash: row.previous_hash,
    event_hash: row.event_hash,
  };
}

/** Append an immutable event, or return its original row for an identical idempotent request. */
export function appendCognitiveEvent(
  db: Database.Database,
  input: AppendCognitiveEventInput,
): CognitiveEvent {
  assertInput(input);
  const payload = deterministicJson(input.payload);
  const requestHash = input.idempotency_key === undefined ? null : idempotencyHash(input, payload);

  return db.transaction(() => {
    if (input.idempotency_key !== undefined) {
      const existing = db
        .prepare('SELECT * FROM cognitive_events WHERE idempotency_key = ?')
        .get(input.idempotency_key) as EventRow | undefined;
      if (existing) {
        if (existing.idempotency_hash !== requestHash) {
          throw new Error('Idempotency key was already used with different cognitive event content');
        }
        return toCognitiveEvent(existing);
      }
    }

    const tail = db
      .prepare('SELECT sequence, event_hash FROM cognitive_events ORDER BY sequence DESC LIMIT 1')
      .get() as Pick<EventRow, 'sequence' | 'event_hash'> | undefined;
    const createdAt = new Date().toISOString();
    const row: Omit<EventRow, 'event_hash'> = {
      sequence: tail === undefined ? 1 : Number(tail.sequence) + 1,
      event_id: randomUUID(),
      event_type: input.event_type,
      task_id: input.task_id,
      project_id: input.project_id,
      session_id: input.session_id ?? null,
      correlation_id: input.correlation_id ?? null,
      causation_id: input.causation_id ?? null,
      idempotency_key: input.idempotency_key ?? null,
      payload,
      schema_version: SCHEMA_VERSION,
      observed_at: input.observed_at ?? createdAt,
      created_at: createdAt,
      previous_hash: tail?.event_hash ?? null,
      idempotency_hash: requestHash,
    };
    const hash = eventHash(row);
    db.prepare(`
      INSERT INTO cognitive_events (
        sequence, event_id, event_type, task_id, project_id, session_id,
        correlation_id, causation_id, idempotency_key, payload, schema_version,
        observed_at, created_at, previous_hash, event_hash, idempotency_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.sequence, row.event_id, row.event_type, row.task_id, row.project_id,
      row.session_id, row.correlation_id, row.causation_id, row.idempotency_key,
      row.payload, row.schema_version, row.observed_at, row.created_at,
      row.previous_hash, hash, row.idempotency_hash,
    );
    return toCognitiveEvent({ ...row, event_hash: hash });
  })();
}

/** Read events in ledger order, optionally narrowing the audit view. */
export function listCognitiveEvents(
  db: Database.Database,
  filters: CognitiveEventListFilters = {},
): CognitiveEvent[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  const filterColumns: Array<[keyof CognitiveEventListFilters, string]> = [
    ['event_type', 'event_type'],
    ['task_id', 'task_id'],
    ['project_id', 'project_id'],
    ['session_id', 'session_id'],
    ['correlation_id', 'correlation_id'],
    ['causation_id', 'causation_id'],
  ];
  for (const [key, column] of filterColumns) {
    const value = filters[key];
    if (value !== undefined) {
      conditions.push(`${column} = ?`);
      params.push(value);
    }
  }
  if (filters.after_sequence !== undefined) {
    conditions.push('sequence > ?');
    params.push(filters.after_sequence);
  }
  if (filters.before_sequence !== undefined) {
    conditions.push('sequence < ?');
    params.push(filters.before_sequence);
  }
  let sql = 'SELECT * FROM cognitive_events';
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY sequence ASC';
  if (filters.limit !== undefined) {
    if (!Number.isInteger(filters.limit) || filters.limit < 0) {
      throw new Error('limit must be a non-negative integer');
    }
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }
  return (db.prepare(sql).all(...params) as EventRow[]).map(toCognitiveEvent);
}

/** Verify sequence continuity, previous-hash linkage, and every event hash. */
export function verifyCognitiveEventChain(db: Database.Database): CognitiveEventChainVerification {
  const rows = db.prepare('SELECT * FROM cognitive_events ORDER BY sequence ASC').all() as EventRow[];
  let previousHash: string | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const sequence = Number(row.sequence);
    if (sequence !== index + 1) {
      return { valid: false, event_count: rows.length, failing_sequence: sequence, reason: 'sequence is not contiguous' };
    }
    if (row.previous_hash !== previousHash) {
      return { valid: false, event_count: rows.length, failing_sequence: sequence, reason: 'previous hash does not match prior event' };
    }
    try {
      if (eventHash(row) !== row.event_hash) {
        return { valid: false, event_count: rows.length, failing_sequence: sequence, reason: 'event hash does not match event content' };
      }
    } catch (error) {
      return {
        valid: false,
        event_count: rows.length,
        failing_sequence: sequence,
        reason: `event cannot be hashed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    previousHash = row.event_hash;
  }
  return { valid: true, event_count: rows.length };
}
