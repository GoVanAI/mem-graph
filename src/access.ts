import type Database from 'better-sqlite3';

/**
 * Touch a memory's access tracking (D7).
 *
 * Sets `accessed_at` to the current timestamp and increments `access_count`
 * by 1. No-op if the memory id does not exist (silently — the UPDATE
 * affects zero rows).
 */
export function bumpMemoryAccess(db: Database.Database, memoryId: number): void {
  db.prepare(
    "UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?",
  ).run(memoryId);
}

/**
 * Touch the synapse access tracking for synapses whose either endpoint is
 * in the given list of memory ids (D7 — extended to the graph).
 *
 * Increments `synapses.access_count` by 1 for each synapse where
 * `source_id` OR `target_id` is in the list. No-op on empty input.
 *
 * Intentionally does NOT bump `synapses.updated_at`. Access is not mutation;
 * the decay's "slow-fading glory" semantic depends on that distinction —
 * `updated_at` measures re-curation, `access_count` measures retrieval
 * interest. Mixing them would break decay's exemption logic.
 */
export function bumpSynapseAccess(db: Database.Database, memoryIds: number[]): void {
  if (memoryIds.length === 0) return;
  const placeholders = memoryIds.map(() => '?').join(',');
  db.prepare(
    `UPDATE synapses SET access_count = access_count + 1
     WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
  ).run(...memoryIds, ...memoryIds);
}

export type SynapseDirection = 'outgoing' | 'incoming' | 'both';
export type SynapseConnectionType = 'wikilink' | 'bm25_auto' | 'parent_child';

export interface SynapseTraverseParams {
  id: number;
  direction?: SynapseDirection;
  connection_type?: SynapseConnectionType;
  min_weight?: number;
  limit?: number;
}

export interface SynapseTraverseRow {
  source_id: number;
  target_id: number;
  connection_type: string;
  weight: number;
  access_count: number;
  created_at: string;
  updated_at: string;
  other_id: number;
  other_layer: string;
  other_title: string;
  other_summary: string | null;
  other_status: string;
  other_project_id: string;
}

/**
 * Traverse the synapse graph for a memory.
 *
 * Returns one row per synapse whose endpoint matches `id`, joined with the
 * other memory's title/summary/etc. Filterable by direction, connection
 * type, and minimum weight.
 *
 * Implementation note — placeholder/param ordering:
 * The SQL is built so the order of `?` placeholders exactly matches the
 * order in which bindParams are appended below. Reversed order is the bug
 * behind [[178]] (id 178 in mem-graph): the original inline handler built
 * params as [min_weight, connection_type, id, limit] while the SQL's
 * placeholders appear in order [JOIN.source_id, WHERE.weight,
 * WHERE.connection_type, LIMIT]. min_weight (default 0) bound to the JOIN's
 * source_id placeholder filtered every synapse to source_id=0, returning [].
 * Tests in tests/synapse.test.ts lock the ordering by exercising every
 * direction + connection_type + min_weight combination.
 */
export function runSynapseTraverse(
  db: Database.Database,
  params: SynapseTraverseParams,
): SynapseTraverseRow[] {
  const {
    id,
    direction = 'both',
    connection_type,
    min_weight = 0,
    limit = 50,
  } = params;

  // Verify the source memory exists (matches old tool behavior).
  const exists = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
  if (!exists) {
    throw new Error(`No memory found with id ${id}.`);
  }

  const joins: string[] = [];
  const conditions: string[] = [];
  const bindParams: (string | number)[] = [];

  // JOIN placeholders come first in the SQL.
  if (direction === 'outgoing' || direction === 'both') {
    joins.push('(s.source_id = ? AND s.target_id = m.id)');
    bindParams.push(id);
  }
  if (direction === 'incoming' || direction === 'both') {
    joins.push('(s.target_id = ? AND s.source_id = m.id)');
    bindParams.push(id);
  }

  // WHERE placeholders come next.
  conditions.push('s.weight >= ?');
  bindParams.push(min_weight);
  if (connection_type) {
    conditions.push('s.connection_type = ?');
    bindParams.push(connection_type);
  }

  // LIMIT placeholder is last.
  bindParams.push(limit);

  const where = joins.length > 1 ? `(${joins.join(' OR ')})` : joins[0];

  const stmt = db.prepare(`
    SELECT s.source_id, s.target_id, s.connection_type, s.weight, s.access_count,
           s.created_at, s.updated_at,
           m.id AS other_id, m.layer AS other_layer, m.title AS other_title,
           m.summary AS other_summary, m.status AS other_status, m.project_id AS other_project_id
    FROM synapses s
    JOIN memories m ON ${where}
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.weight DESC, s.updated_at DESC
    LIMIT ?
  `);
  return stmt.all(...bindParams) as SynapseTraverseRow[];
}