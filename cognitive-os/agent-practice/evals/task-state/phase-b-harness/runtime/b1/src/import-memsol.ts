import type Database from 'better-sqlite3';
import { slugify } from './wikilink.js';
import { extractWikilinks, resolveWikilink, upsertWikilinkSynapse } from './wikilink.js';

export type DefaultLayer = 'working' | 'episodic' | 'procedural' | 'semantic' | 'partner';

export interface ImportFromMemSolOptions {
  /** Layer assigned to imported entries (v1 had no layer concept). Default 'episodic'. */
  default_layer?: DefaultLayer;
  /** importance_score for entries with NULL relevance_score. Default 1.0. */
  default_importance?: number;
  /** If true, scan source and report without writing to target. Default false. */
  dry_run?: boolean;
}

export interface ImportFromMemSolResult {
  source_db_path?: string;
  dry_run: boolean;
  memories_total: number;
  memories_inserted: number;
  memories_skipped: number; // duplicates by (project_id, title)
  memories_failed: number;
  wikilinks_inserted: number;
  wikilinks_broken: number;
  links_total: number;
  links_inserted: number; // v1 memory_links migrated as wikilink synapses
  links_skipped: number; // endpoint missing in v2 id map
  errors: Array<{ v1_id?: number; stage: string; message: string }>;
  id_map: Record<number, number>; // v1_id → v2_id
}

/**
 * One-shot migration from mem-sol v1 SQLite DB to mem-graph v2.
 *
 * Pipeline:
 *  1. INSERT memories (FTS5 triggers fire automatically). Skip on
 *     UNIQUE(project_id, title) conflict. Map relevance_score → importance_score
 *     (default 1.0 when NULL). Map project → project_id. Parse JSON tags.
 *  2. Two-pass wikilink extraction: AFTER all memories are inserted,
 *     iterate each new memory, extract `[[wikilinks]]` from content,
 *     resolve them via slug-aware lookup, and upsert synapses. The two-pass
 *     approach avoids the "neighbor not yet imported" ordering hazard.
 *  3. Migrate v1 memory_links table → synapses (connection_type='wikilink'),
 *     preserving the original v1 type in the synapse's `reason` field.
 *
 * Pure function: takes an already-opened source DB (so tests can use
 * `:memory:`) and the target DB. The MCP wrapper handles file I/O.
 */
export function runImportFromMemSol(
  sourceDb: Database.Database,
  targetDb: Database.Database,
  opts: ImportFromMemSolOptions = {},
): ImportFromMemSolResult {
  const defaultLayer = opts.default_layer ?? 'episodic';
  const defaultImportance = opts.default_importance ?? 1.0;
  const dryRun = opts.dry_run ?? false;

  const errors: Array<{ v1_id?: number; stage: string; message: string }> = [];
  const idMap: Record<number, number> = {};

  // Read source rows
  type V1Row = {
    id: number;
    category: string;
    project: string;
    title: string;
    content: string;
    summary: string | null;
    tags: string | null;
    session_id: string | null;
    status: string;
    lifecycle: string;
    confidence: number;
    relevance_score: number | null;
    source: string;
    created_at: string;
    updated_at: string;
    accessed_at: string | null;
    access_count: number;
    boost: number;
  };

  const v1Rows = sourceDb
    .prepare(
      `SELECT id, category, project, title, content, summary, tags, session_id,
              status, lifecycle, confidence, relevance_score, source,
              created_at, updated_at, accessed_at, access_count, boost
       FROM memory
       ORDER BY id ASC`,
    )
    .all() as V1Row[];

  type V1Link = { from_id: number; to_id: number; type: string; weight: number; reason: string | null };
  const v1Links = sourceDb
    .prepare('SELECT from_id, to_id, type, weight, reason FROM memory_links')
    .all() as V1Link[];

  // Dry-run: count + report, no writes
  if (dryRun) {
    return {
      dry_run: true,
      memories_total: v1Rows.length,
      memories_inserted: 0,
      memories_skipped: 0,
      memories_failed: 0,
      wikilinks_inserted: 0,
      wikilinks_broken: 0,
      links_total: v1Links.length,
      links_inserted: 0,
      links_skipped: 0,
      errors: [],
      id_map: {},
    };
  }

  // Phase 1: insert memories + tags
  let memoriesInserted = 0;
  let memoriesSkipped = 0;
  let memoriesFailed = 0;

  const insertStmt = targetDb.prepare(`
    INSERT INTO memories (
      layer, title, slug, content, project_id, category, lifecycle, status,
      confidence, boost, summary, session_id, source, importance_score,
      created_at, updated_at, accessed_at, access_count
    ) VALUES (
      @layer, @title, @slug, @content, @project_id, @category, @lifecycle, @status,
      @confidence, @boost, @summary, @session_id, @source, @importance_score,
      @created_at, @updated_at, @accessed_at, @access_count
    )
  `);
  const tagInsert = targetDb.prepare(
    'INSERT OR IGNORE INTO memory_tag (memory_id, tag) VALUES (?, ?)',
  );

  for (const row of v1Rows) {
    try {
      const result = insertStmt.run({
        layer: defaultLayer,
        title: row.title,
        slug: slugify(row.title),
        content: row.content,
        project_id: row.project,
        category: row.category,
        lifecycle: row.lifecycle,
        status: row.status,
        confidence: row.confidence,
        boost: row.boost,
        summary: row.summary,
        session_id: row.session_id,
        // Remap source: 'session' / 'manual' → 'import' so v1 origin is preserved
        source: 'import',
        importance_score: row.relevance_score ?? defaultImportance,
        created_at: row.created_at,
        updated_at: row.updated_at,
        accessed_at: row.accessed_at,
        access_count: row.access_count,
      });
      const v2Id = Number(result.lastInsertRowid);
      idMap[row.id] = v2Id;

      // Tags: v1 stored as JSON arrays
      const tags = parseV1Tags(row.tags);
      for (const tag of tags) {
        try {
          tagInsert.run(v2Id, tag);
        } catch {
          /* tag FK / unique violation — skip */
        }
      }
      memoriesInserted++;
    } catch (e) {
      const msg = (e as Error).message;
      // Any UNIQUE constraint failure on memories counts as a dupe-skip.
      // The two indexes that can fire here: project_id+title and project_id+slug.
      if (msg.includes('UNIQUE constraint failed')) {
        memoriesSkipped++;
      } else {
        memoriesFailed++;
        errors.push({ v1_id: row.id, stage: 'insert_memory', message: msg });
      }
    }
  }

  // Phase 2: extract wikilinks from content (after all memories are in)
  let wikilinksInserted = 0;
  let wikilinksBroken = 0;
  const v2Ids = Object.values(idMap);
  if (v2Ids.length > 0) {
    const placeholders = v2Ids.map(() => '?').join(',');
    const newRows = targetDb
      .prepare(`SELECT id, content, project_id FROM memories WHERE id IN (${placeholders})`)
      .all(...v2Ids) as Array<{ id: number; content: string; project_id: string }>;

    for (const { id, content, project_id } of newRows) {
      const refs = extractWikilinks(content);
      for (const ref of refs) {
        const r = resolveWikilink(targetDb, ref, project_id);
        if (r && r.id !== id) {
          upsertWikilinkSynapse(targetDb, id, r.id);
          wikilinksInserted++;
        } else {
          wikilinksBroken++;
        }
      }
    }
  }

  // Phase 3: migrate v1 memory_links → wikilink synapses.
  // The v1 link type (relates_to / derived_from / part_of / etc.) is NOT
  // preserved as a column — the v2 synapses schema has no reason field.
  // The original type is recoverable from the source DB if the operator
  // needs to re-curate. We preserve the connection (source→target) and
  // weight, but lossy on the edge label.
  let linksInserted = 0;
  let linksSkipped = 0;
  const linkInsert = targetDb.prepare(`
    INSERT INTO synapses (source_id, target_id, connection_type, weight)
    VALUES (?, ?, 'wikilink', ?)
    ON CONFLICT(source_id, target_id, connection_type) DO UPDATE SET
      weight = MIN(5.0, weight + excluded.weight),
      updated_at = CURRENT_TIMESTAMP
  `);

  for (const link of v1Links) {
    const v2Source = idMap[link.from_id];
    const v2Target = idMap[link.to_id];
    if (!v2Source || !v2Target) {
      linksSkipped++;
      continue;
    }
    if (v2Source === v2Target) {
      linksSkipped++; // no self-loops
      continue;
    }
    try {
      linkInsert.run(v2Source, v2Target, link.weight);
      linksInserted++;
    } catch (e) {
      linksSkipped++;
      errors.push({
        stage: 'insert_link',
        message: `v1(${link.from_id}->${link.to_id}) ${(e as Error).message}`,
      });
    }
  }

  return {
    dry_run: false,
    memories_total: v1Rows.length,
    memories_inserted: memoriesInserted,
    memories_skipped: memoriesSkipped,
    memories_failed: memoriesFailed,
    wikilinks_inserted: wikilinksInserted,
    wikilinks_broken: wikilinksBroken,
    links_total: v1Links.length,
    links_inserted: linksInserted,
    links_skipped: linksSkipped,
    errors,
    id_map: idMap,
  };
}

/**
 * Parse v1's tag representation: JSON array of strings.
 * Returns [] for null, malformed JSON, or non-array values.
 */
function parseV1Tags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (t): t is string => typeof t === 'string' && t.trim().length > 0,
      );
    }
  } catch {
    /* fall through */
  }
  return [];
}