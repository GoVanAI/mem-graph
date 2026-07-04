import type Database from 'better-sqlite3';

const AUTO_LINK_LIMIT = 5;          // top-N BM25 neighbors to consider
const AUTO_LINK_RELATIVE_FLOOR = 0.5; // skip matches whose |score| is < 50% of the best |score|
const SYNAPSE_CAP_PER_MEMORY = 50;  // max outgoing synapses per memory (D5)

/**
 * Sanitize content for FTS5 MATCH. Strips FTS5 operators (hyphens, quotes, parens)
 * by quoting suspect tokens. Prevents malformed-query errors at the cost of
 * slightly less expressive search.
 *
 * Tokens are OR'd together — for auto-linking we want "memories that share
 * SOME vocabulary with this one", not "memories that contain ALL these terms"
 * (which would be impossible for a long content body).
 */
function sanitizeFtsQuery(content: string): string {
  const tokens = content
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1) // skip single-char tokens (noise)
    .slice(0, 30); // keep query bounded
  if (tokens.length === 0) return '';
  return tokens
    .map((t) => `${t}*`) // prefix match for partial words
    .join(' OR ');
}

/**
 * Create/update bm25_auto synapses from `memoryId` to its top-N BM25 neighbors
 * in the same project. Project floor: cross-project matches are excluded.
 *
 * Relevance filter: only neighbors whose |score| is at least
 * AUTO_LINK_RELATIVE_FLOOR of the best |score| are linked. This is a relative
 * threshold that scales with corpus size — for tiny corpora, all matches pass;
 * for large corpora, low-quality matches are pruned.
 *
 * Returns the count of synapses created/updated.
 */
export function autoLinkOnInsert(
  db: Database.Database,
  memoryId: number,
  content: string,
  projectId: string,
): { created: number; updated: number } {
  const ftsQuery = sanitizeFtsQuery(content);
  if (!ftsQuery) return { created: 0, updated: 0 };

  // Look up top neighbors
  let rows: { id: number; score: number }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT m.id, bm25(memories_fts) AS score
         FROM memories_fts fts
         JOIN memories m ON m.id = fts.rowid
         WHERE memories_fts MATCH ?
           AND m.id != ?
           AND m.project_id = ?
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(ftsQuery, memoryId, projectId, AUTO_LINK_LIMIT) as { id: number; score: number }[];
  } catch {
    return { created: 0, updated: 0 };
  }

  if (rows.length === 0) return { created: 0, updated: 0 };

  // Compute the best |score|; drop matches whose |score| is below the
  // relative floor (too far from the best match to be a meaningful link).
  const bestAbs = Math.abs(rows[0].score);

  let created = 0;
  let updated = 0;
  const upsert = db.prepare(
    `INSERT INTO synapses (source_id, target_id, connection_type, weight)
     VALUES (?, ?, 'bm25_auto', ?)
     ON CONFLICT(source_id, target_id, connection_type) DO UPDATE SET
         weight = MIN(5.0, weight + 0.2),
         updated_at = CURRENT_TIMESTAMP`,
  );

  for (const { id: neighborId, score } of rows) {
    // Relative noise filter: drop matches that are far from the best.
    if (Math.abs(score) < bestAbs * AUTO_LINK_RELATIVE_FLOOR) continue;

    // Map score to weight in [0.2, 1.5]. For tiny corpora, scores are tiny
    // (e.g., -0.000004), so we use a fixed-shape curve: weight = |score| / 10
    // clamped. For larger corpora with bigger scores, this still produces
    // values in [0.2, 1.5] but more discriminating.
    const normalized = Math.max(score, -50.0); // clamp so single huge hits don't blow out
    const weight = Math.max(0.2, Math.min(1.5, Math.abs(normalized) / 10.0));

    // Detect insert vs update by checking the change count via a probe.
    // We do an explicit pre-check to keep the return shape clean.
    const exists = db
      .prepare(
        `SELECT 1 FROM synapses WHERE source_id = ? AND target_id = ? AND connection_type = 'bm25_auto'`,
      )
      .get(memoryId, neighborId);
    upsert.run(memoryId, neighborId, weight);
    if (exists) updated++;
    else created++;
  }

  // Cap enforcement: if we have > SYNAPSE_CAP_PER_MEMORY outgoing synapses,
  // prune the lowest-weight bm25_auto synapses (wikilinks are operator-curated,
  // they are NOT pruned by the cap).
  const cap = db
    .prepare(
      `SELECT COUNT(*) AS c FROM synapses WHERE source_id = ?`,
    )
    .get(memoryId) as { c: number };
  if (cap.c > SYNAPSE_CAP_PER_MEMORY) {
    const excess = cap.c - SYNAPSE_CAP_PER_MEMORY;
    db.prepare(
      `DELETE FROM synapses
       WHERE source_id = ?
         AND connection_type = 'bm25_auto'
         AND (source_id, target_id, connection_type) IN (
           SELECT source_id, target_id, connection_type FROM synapses
           WHERE source_id = ? AND connection_type = 'bm25_auto'
           ORDER BY weight ASC, updated_at ASC
           LIMIT ?
         )`,
    ).run(memoryId, memoryId, excess);
  }

  return { created, updated };
}
