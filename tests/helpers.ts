/**
 * Test fixtures for mem-graph.
 *
 * Design note (mem-graph-analysis.md § 3.2, R1): every test reconstructs the
 * schema in-memory via `SCHEMA_SQL` + `DECAY_MATRIX_SEED` (now exported from
 * `src/db.ts`). This isolates tests from any live DB (the file-based
 * singleton in `src/db.ts` reads `MEM_GRAPH_DIR` or its default) and lets
 * tests run fast (no disk), deterministically, and concurrently without
 * colliding.
 *
 * Edges-on-read philosophy (id 44 in mem-graph): the edges this codebase
 * creates today are BM25-token-overlap at *write* time (see `auto-link.ts`).
 * The read-time edge-creation path is a Tier 3 design decision — when it
 * lands, helpers here will grow a `seedCoOccurrence(a, b, n)` to test it.
 */
import Database from 'better-sqlite3';
import { SCHEMA_SQL, DECAY_MATRIX_SEED } from '../src/db.js';
import { slugify } from '../src/wikilink.js';

export function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(DECAY_MATRIX_SEED);
  return db;
}

export interface SeedMemoryArgs {
  title: string;
  content: string;
  layer?: 'working' | 'episodic' | 'procedural' | 'semantic' | 'partner';
  project_id?: string;
  category?: string;
  lifecycle?: 'permanent' | 'milestone' | 'ephemeral';
  importance_score?: number;
  status?: 'active' | 'superseded' | 'archived' | 'invalid';
}

export function seedMemory(db: Database.Database, args: SeedMemoryArgs): number {
  const layer = args.layer ?? 'episodic';
  const project_id = args.project_id ?? '_global';
  const category = args.category ?? 'note';
  const lifecycle = args.lifecycle ?? 'milestone';
  const importance = args.importance_score ?? 1.0;
  const status = args.status ?? 'active';
  const result = db
    .prepare(
      `INSERT INTO memories
         (title, slug, content, project_id, category, layer, lifecycle, status,
          confidence, source, importance_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0, 'manual', ?)`,
    )
    .run(
      args.title,
      slugify(args.title),
      args.content,
      project_id,
      category,
      layer,
      lifecycle,
      status,
      importance,
    );
  return Number(result.lastInsertRowid);
}

export function seedSynapse(
  db: Database.Database,
  sourceId: number,
  targetId: number,
  connectionType: 'wikilink' | 'bm25_auto' | 'parent_child' = 'bm25_auto',
  weight: number = 1.0,
): void {
  db.prepare(
    `INSERT INTO synapses (source_id, target_id, connection_type, weight)
     VALUES (?, ?, ?, ?)`,
  ).run(sourceId, targetId, connectionType, weight);
}

export function countSynapses(
  db: Database.Database,
  sourceId: number,
  connectionType?: 'wikilink' | 'bm25_auto' | 'parent_child',
): number {
  const row = connectionType
    ? db
        .prepare(
          'SELECT COUNT(*) AS c FROM synapses WHERE source_id = ? AND connection_type = ?',
        )
        .get(sourceId, connectionType)
    : db.prepare('SELECT COUNT(*) AS c FROM synapses WHERE source_id = ?').get(sourceId);
  return (row as { c: number }).c;
}

export function getMemoryStatus(db: Database.Database, id: number): string {
  const row = db.prepare('SELECT status FROM memories WHERE id = ?').get(id) as
    | { status: string }
    | undefined;
  return row?.status ?? '<missing>';
}
