import type Database from 'better-sqlite3';
import { bumpMemoryAccess, bumpSynapseAccess, runSynapseTraverse, type SynapseTraverseParams, type SynapseTraverseRow } from './access.js';

export class MemoryReadError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'OUT_OF_SCOPE', message: string) {
    super(message);
  }
}

export interface MemoryScope {
  project_id?: string;
  include_global?: boolean;
}

export interface MemoryEntryResult {
  memory: Record<string, unknown>;
  outgoing?: Array<Record<string, unknown>>;
  incoming?: Array<Record<string, unknown>>;
}

export interface MemoryLinksResult {
  memory: Record<string, unknown>;
  tags: string[];
  rows: SynapseTraverseRow[];
}

function inScope(row: { project_id: string }, scope?: MemoryScope): boolean {
  if (!scope?.project_id) return true;
  return row.project_id === scope.project_id || (scope.include_global === true && row.project_id === '_global');
}

function memoryOrThrow(db: Database.Database, id: number, scope?: MemoryScope): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new MemoryReadError('NOT_FOUND', `No memory found with id ${id}.`);
  if (!inScope(row as { project_id: string }, scope)) {
    throw new MemoryReadError('OUT_OF_SCOPE', `memory ${id} is unavailable in project ${scope?.project_id}`);
  }
  return row;
}

/**
 * Read one memory and apply D7 access tracking. Both profile adapters use this
 * service; response shape selection stays at the adapter boundary.
 */
export function readMemoryEntry(
  db: Database.Database,
  id: number,
  options: MemoryScope & { include_synapses?: boolean } = {},
): MemoryEntryResult {
  const row = memoryOrThrow(db, id, options);
  const tags = (db.prepare('SELECT tag FROM memory_tag WHERE memory_id = ? ORDER BY tag').all(id) as Array<{ tag: string }>).map((tag) => tag.tag);

  // D7 intentionally records access even when the caller does not request
  // neighbor payloads. Access tracking failures remain non-fatal as before.
  try {
    bumpMemoryAccess(db, id);
    bumpSynapseAccess(db, [id]);
  } catch {
    // Access accounting must not turn a successful read into an MCP failure.
  }

  const memory = { ...row, tags };
  if (!options.include_synapses) return { memory };

  const outgoing = db.prepare(
    `SELECT s.connection_type, s.weight, s.access_count, s.created_at, s.updated_at,
            m.id, m.layer, m.title, m.summary
     FROM synapses s JOIN memories m ON m.id = s.target_id WHERE s.source_id = ?`,
  ).all(id) as Array<Record<string, unknown>>;
  const incoming = db.prepare(
    `SELECT s.connection_type, s.weight, s.access_count, s.created_at, s.updated_at,
            m.id, m.layer, m.title, m.summary
     FROM synapses s JOIN memories m ON m.id = s.source_id WHERE s.target_id = ?`,
  ).all(id) as Array<Record<string, unknown>>;
  return { memory, outgoing, incoming };
}

/**
 * Traverse links without access tracking. The agent adapter may redact foreign
 * neighbors into reference stubs; the legacy adapter preserves raw rows.
 */
export function readMemoryLinks(
  db: Database.Database,
  params: SynapseTraverseParams,
  scope?: MemoryScope,
): MemoryLinksResult {
  const memory = memoryOrThrow(db, params.id, scope);
  const tags = (db.prepare('SELECT tag FROM memory_tag WHERE memory_id = ? ORDER BY tag').all(params.id) as Array<{ tag: string }>).map((tag) => tag.tag);
  return { memory, tags, rows: runSynapseTraverse(db, params) };
}
