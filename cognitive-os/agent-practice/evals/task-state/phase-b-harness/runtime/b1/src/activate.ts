import type Database from 'better-sqlite3';
import { bumpSynapseAccess } from './access.js';

export interface ActivateParams {
  query: string;
  max_hop_depth?: number;
  min_synapse_weight?: number;
  limit_cap?: number;
  land_on_layers?: string[];
  pass_through_layers?: string[];
  project_id?: string | null;
}

const DEFAULT_MAX_HOP_DEPTH = 2;
const DEFAULT_MIN_SYNAPSE_WEIGHT = 0.3;
const DEFAULT_LIMIT_CAP = 20;
const DEFAULT_LAND_ON_LAYERS = ['procedural', 'episodic', 'semantic', 'partner'];
const DEFAULT_PASS_THROUGH_LAYERS = ['semantic'];

/**
 * Spreading activation retrieval.
 *
 * The recursive CTE carries a `path` column (comma-joined ancestor ids).
 * The pass-through check uses json_each to test "any ancestor in the path
 * is a pass-through layer". This correctly implements the v2 design intent
 * (fixes the v1 review's critical issue 1 — the broken EXISTS subquery).
 */
export function runActivate(
  db: Database.Database,
  params: ActivateParams,
): Array<{
  id: number;
  layer: string;
  project_id: string;
  max_relevance: number;
}> {
  const {
    query,
    max_hop_depth = DEFAULT_MAX_HOP_DEPTH,
    min_synapse_weight = DEFAULT_MIN_SYNAPSE_WEIGHT,
    limit_cap = DEFAULT_LIMIT_CAP,
    land_on_layers = DEFAULT_LAND_ON_LAYERS,
    pass_through_layers = DEFAULT_PASS_THROUGH_LAYERS,
    project_id = null,
  } = params;

  // Sanitize FTS5 query: handle operators that would break MATCH
  const ftsQuery = sanitizeFtsForMatch(query);

  // Build the land_on / pass_through IN-list literals
  const landOnList = sqlInList(land_on_layers);
  const passThroughList = sqlInList(pass_through_layers);

  // The pass-through EXISTS subquery: "is any ancestor in sa.path a pass-through memory?"
  // Path format: ",1,5,17," — we strip the leading/trailing comma and json_each it.
  const passThroughExists = `
      OR EXISTS (
        SELECT 1
        FROM memories m2
        WHERE m2.id IN (
          SELECT value FROM json_each(
            '[' || replace(substr(sa.path, 2, length(sa.path) - 2), ',', ',') || ']'
          )
        )
          AND m2.layer IN ${passThroughList}
      )
  `;

  const projectClause = project_id
    ? `AND (m.project_id = :project_id OR m.project_id = '_global')`
    : '';

  // Cycle prevention: the depth bound (max_hop_depth) prevents infinite recursion,
  // and the final GROUP BY id dedupes any node reached via multiple paths.
  // We cannot add an explicit NOT EXISTS cycle guard because SQLite allows only
  // one recursive reference to a CTE per WITH clause, and the recursive step
  // already uses the second reference.

  const sql = `
    WITH RECURSIVE
      SpreadingActivation(id, layer, project_id, effective_weight, current_depth, path) AS (
        -- Anchor: FTS5 hits
        SELECT m.id, m.layer, m.project_id, 5.0, 0, ',' || m.id || ','
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.rowid
        WHERE memories_fts MATCH :fts_query
          ${projectClause}

        UNION ALL

        -- Recursive step: traverse synapses
        SELECT
          CASE WHEN s.source_id = sa.id THEN s.target_id ELSE s.source_id END,
          m.layer,
          m.project_id,
          sa.effective_weight * s.weight * m.importance_score,
          sa.current_depth + 1,
          sa.path || m.id || ','
        FROM SpreadingActivation sa
        JOIN synapses s
          ON (s.source_id = sa.id OR s.target_id = sa.id)
        JOIN memories m
          ON m.id = CASE WHEN s.source_id = sa.id THEN s.target_id ELSE s.source_id END
        WHERE sa.current_depth < :max_hop_depth
          AND s.weight >= :min_synapse_weight
          AND (
              m.layer IN ${landOnList}
              ${passThroughExists}
          )
      )
    SELECT id, layer, project_id, MAX(effective_weight) AS max_relevance
    FROM SpreadingActivation
    GROUP BY id
    ORDER BY max_relevance DESC
    LIMIT :limit_cap
  `;

  // Note on access_count: runActivate touches the returned memories'
  // access_count below AND the access_count of synapses connecting them
  // (D7 — extended to the graph; see id 90 in mem-graph for rationale).
  // We bump only the result-set's neighborhood — not all traversed synapses
  // — to keep write amplification bounded (result_count <= limit_cap;
  // per-memory degree capped at 50).

  const stmt = db.prepare(sql);
  const rows = stmt.all({
    fts_query: ftsQuery,
    max_hop_depth,
    min_synapse_weight,
    limit_cap,
    ...(project_id ? { project_id } : {}),
  }) as Array<{ id: number; layer: string; project_id: string; max_relevance: number }>;

  // Mark the returned memories' access_count (D7) and bump the access_count
  // of synapses connecting them to the rest of the graph.
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE memories
       SET accessed_at = CURRENT_TIMESTAMP, access_count = access_count + 1
       WHERE id IN (${placeholders})`,
    ).run(...ids);
    bumpSynapseAccess(db, ids);
  }

  return rows;
}

/**
 * Quote a list of strings into a SQL IN-list literal: ('a','b','c')
 * Single quotes inside strings are escaped by doubling.
 */
function sqlInList(values: string[]): string {
  const escaped = values.map((v) => `'${v.replace(/'/g, "''")}'`);
  return `(${escaped.join(',')})`;
}

/**
 * Wrap user query in a way that is safe for FTS5 MATCH.
 * If the user supplies a quoted phrase or FTS5 operators, pass through.
 * Otherwise, tokenize and prefix-match to give "I typed 'foo' and got a hit"
 * behavior. Empty query returns '*' (match-all).
 */
function sanitizeFtsForMatch(q: string): string {
  const trimmed = q.trim();
  if (!trimmed) return '*';
  // If the user has clearly composed an FTS5 expression, pass it through
  if (/[":()]/.test(trimmed)) return trimmed;
  if (/\b(AND|OR|NOT|NEAR)\b/i.test(trimmed)) return trimmed;
  // Tokenize and prefix-match each token (limit to 20 to keep query bounded)
  const tokens = trimmed
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 20);
  if (tokens.length === 0) return '*';
  return tokens.map((t) => (t.length > 1 ? `${t}*` : t)).join(' ');
}
