import type Database from 'better-sqlite3';

const DEFAULT_DECAY_DAYS = 7;          // only decay synapses older than this
const DEFAULT_PRUNE_FLOOR = 0.1;       // prune synapses below this weight
const DEFAULT_FALLBACK_RATE = 0.85;    // when no matrix row matches

/**
 * Run a decay cycle:
 *  1. Decay matrix-based for synapses older than the threshold
 *  2. Apply access-based exemption (heavily-used synapses resist decay)
 *  3. Prune synapses below the weight floor
 *
 * Returns a summary of what changed.
 */
export function runDecayCycle(
  db: Database.Database,
  opts: { decayDays?: number; pruneFloor?: number } = {},
): { decayed: number; pruned: number; access_exempted: number } {
  const decayDays = opts.decayDays ?? DEFAULT_DECAY_DAYS;
  const pruneFloor = opts.pruneFloor ?? DEFAULT_PRUNE_FLOOR;

  // 1. Matrix-based decay. ORDER BY ... LIMIT 1 is the v1 review's
  //    critical issue 3 fix — without it, scalar subquery is non-deterministic
  //    when both specific and wildcard rows match.
  const decayStmt = db.prepare(`
    UPDATE synapses
    SET weight = weight * COALESCE(
        (
            SELECT dm.decay_rate
            FROM decay_matrix dm
            JOIN memories m_src ON m_src.id = synapses.source_id
            JOIN memories m_tgt ON m_tgt.id = synapses.target_id
            WHERE dm.source_layer = m_src.layer
              AND (dm.target_layer = m_tgt.layer OR dm.target_layer = '*')
              AND dm.connection_type = synapses.connection_type
            ORDER BY (dm.target_layer = '*') ASC
            LIMIT 1
        ),
        ?
    )
    WHERE updated_at < datetime('now', '-' || ? || ' days')
  `);
  const decayResult = decayStmt.run(DEFAULT_FALLBACK_RATE, decayDays);

  // 2. Access-based exemption: a touch in the last cycle multiplies by a
  //    smaller decay (or no decay). We re-apply a small reduction for hot
  //    synapses, but less than the matrix would.
  const exemptStmt = db.prepare(`
    UPDATE synapses
    SET weight = weight *
        CASE
            WHEN access_count > 10 THEN 0.99
            WHEN access_count > 3  THEN 0.97
            ELSE 1.0
        END
    WHERE updated_at < datetime('now', '-' || ? || ' days')
      AND access_count > 0
  `);
  const exemptResult = exemptStmt.run(decayDays);

  // 3. Prune fully decayed edges
  const pruneStmt = db.prepare(`DELETE FROM synapses WHERE weight < ?`);
  const pruneResult = pruneStmt.run(pruneFloor);

  return {
    decayed: decayResult.changes,
    pruned: pruneResult.changes,
    access_exempted: exemptResult.changes,
  };
}

/**
 * Diagnostic: link density per memory, total synapse count, weight distribution.
 * Returns one row per memory plus aggregate stats.
 */
export function getSpreadStats(db: Database.Database): {
  total_memories: number;
  total_synapses: number;
  by_connection_type: Array<{ connection_type: string; count: number; avg_weight: number }>;
  by_layer: Array<{ layer: string; memory_count: number; avg_outgoing: number; avg_incoming: number }>;
  per_memory: Array<{
    id: number;
    title: string;
    layer: string;
    project_id: string;
    outgoing: number;
    incoming: number;
    avg_outgoing_weight: number | null;
    avg_incoming_weight: number | null;
  }>;
  orphan_count: number;
} {
  const totalMemories = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
  const totalSynapses = (db.prepare('SELECT COUNT(*) AS c FROM synapses').get() as { c: number }).c;

  const byType = db
    .prepare(
      `SELECT connection_type,
              COUNT(*) AS count,
              AVG(weight) AS avg_weight
       FROM synapses
       GROUP BY connection_type
       ORDER BY count DESC`,
    )
    .all() as Array<{ connection_type: string; count: number; avg_weight: number }>;

  const byLayer = db
    .prepare(
      `SELECT m.layer,
              COUNT(DISTINCT m.id) AS memory_count,
              AVG((
                SELECT COUNT(*) FROM synapses s
                WHERE s.source_id = m.id
              )) AS avg_outgoing,
              AVG((
                SELECT COUNT(*) FROM synapses s
                WHERE s.target_id = m.id
              )) AS avg_incoming
       FROM memories m
       GROUP BY m.layer
       ORDER BY memory_count DESC`,
    )
    .all() as Array<{ layer: string; memory_count: number; avg_outgoing: number; avg_incoming: number }>;

  const perMemory = db
    .prepare(
      `SELECT m.id, m.title, m.layer, m.project_id,
              (SELECT COUNT(*) FROM synapses s WHERE s.source_id = m.id) AS outgoing,
              (SELECT COUNT(*) FROM synapses s WHERE s.target_id = m.id) AS incoming,
              (SELECT AVG(weight) FROM synapses s WHERE s.source_id = m.id) AS avg_outgoing_weight,
              (SELECT AVG(weight) FROM synapses s WHERE s.target_id = m.id) AS avg_incoming_weight
       FROM memories m
       ORDER BY (outgoing + incoming) DESC, m.id ASC
       LIMIT 100`,
    )
    .all() as Array<{
      id: number;
      title: string;
      layer: string;
      project_id: string;
      outgoing: number;
      incoming: number;
      avg_outgoing_weight: number | null;
      avg_incoming_weight: number | null;
    }>;

  const orphanCount = (db
    .prepare(
      `SELECT COUNT(*) AS c FROM memories m
       WHERE NOT EXISTS (SELECT 1 FROM synapses s WHERE s.source_id = m.id OR s.target_id = m.id)`,
    )
    .get() as { c: number }).c;

  return {
    total_memories: totalMemories,
    total_synapses: totalSynapses,
    by_connection_type: byType,
    by_layer: byLayer,
    per_memory: perMemory,
    orphan_count: orphanCount,
  };
}

/**
 * Options for `getStaleMemories`.
 *
 * `lifecycle` and `layer` accept allow-lists. Empty / undefined means
 * "no filter on that dimension." An invalid layer or lifecycle value in
 * the array is silently dropped (e.g., a misspelling doesn't error — it
 * just matches nothing).
 */
export interface StaleFilters {
  days?: number;
  project_id?: string;
  lifecycle?: string[];
  layer?: string[];
  limit?: number;
}

export interface StaleRow {
  id: number;
  title: string;
  layer: string;
  project_id: string;
  lifecycle: string;
  accessed_at: string | null;
  access_count: number;
  days_since_access: number | null;
  /**
   * True iff `accessed_at IS NULL`. Surfaced explicitly so the
   * "never-accessed" cohort is grep-able from JSON output.
   * The original `accessed_at IS NULL` rows are still included in the
   * result set; this just makes their cold-set nature visible at a glance.
   */
  never_accessed: boolean;
}

const STALE_ALLOWED_LAYERS = ['working', 'episodic', 'procedural', 'semantic', 'partner'];
const STALE_ALLOWED_LIFECYCLES = ['permanent', 'milestone', 'ephemeral'];

/**
 * Find entries not accessed in N days (D7: hygiene tool).
 *
 * Filtering combinations supported:
 *  - days (default 30): threshold for "stale"
 *  - project_id: scope to one project; _global entries are always included
 *  - lifecycle: keep only entries whose lifecycle is in this list
 *  - layer: keep only entries whose layer is in this list
 *  - limit: cap on result rows (default 50, max 500)
 *
 * Always filters to `status = 'active'` — superseded/archived/invalid
 * entries are hygiene-noise, not hygiene-targets.
 *
 * Result rows sort: `accessed_at ASC NULLS FIRST` (never-accessed surface
 * first — they're the highest-leverage cleanup targets), tiebreak on `id ASC`.
 */
export function getStaleMemories(
  db: Database.Database,
  opts: StaleFilters = {},
): StaleRow[] {
  const days = opts.days ?? 30;
  const projectId = opts.project_id;
  const lifecycle = (opts.lifecycle ?? []).filter((l) =>
    STALE_ALLOWED_LIFECYCLES.includes(l),
  );
  const layer = (opts.layer ?? []).filter((l) =>
    STALE_ALLOWED_LAYERS.includes(l),
  );
  const limit = Math.min(opts.limit ?? 50, 500);

  const clauses: string[] = [
    "m.status = 'active'",
    "(m.accessed_at IS NULL OR m.accessed_at < datetime('now', '-' || ? || ' days'))",
  ];
  const params: (string | number)[] = [days];

  if (projectId) {
    clauses.push("(m.project_id = ? OR m.project_id = '_global')");
    params.push(projectId);
  }
  if (lifecycle.length > 0) {
    const placeholders = lifecycle.map(() => '?').join(',');
    clauses.push(`m.lifecycle IN (${placeholders})`);
    params.push(...lifecycle);
  }
  if (layer.length > 0) {
    const placeholders = layer.map(() => '?').join(',');
    clauses.push(`m.layer IN (${placeholders})`);
    params.push(...layer);
  }
  params.push(limit);

  const sql = `
    SELECT m.id, m.title, m.layer, m.project_id, m.lifecycle,
           m.accessed_at, m.access_count,
           CASE
             WHEN m.accessed_at IS NULL THEN NULL
             ELSE CAST(julianday('now') - julianday(m.accessed_at) AS INTEGER)
           END AS days_since_access,
           CASE WHEN m.accessed_at IS NULL THEN 1 ELSE 0 END AS never_accessed_raw
    FROM memories m
    WHERE ${clauses.join(' AND ')}
    ORDER BY m.accessed_at ASC NULLS FIRST, m.id ASC
    LIMIT ?
  `;
  type RawRow = Omit<StaleRow, 'never_accessed'> & { never_accessed_raw: number };
  const rows = db.prepare(sql).all(...params) as RawRow[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    layer: r.layer,
    project_id: r.project_id,
    lifecycle: r.lifecycle,
    accessed_at: r.accessed_at,
    access_count: r.access_count,
    days_since_access: r.days_since_access,
    never_accessed: r.never_accessed_raw === 1,
  }));
}
