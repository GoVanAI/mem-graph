import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runImportFromMemSol } from '../src/import-memsol.js';
import { createInMemoryDb } from './helpers.js';

/**
 * Build an in-memory mem-sol v1 DB for testing the import.
 * Schema mirrors the real mem-sol db.ts verbatim (minus FTS5 since
 * we're reading from it, not searching).
 */
function createMemSolDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      category        TEXT NOT NULL,
      project         TEXT NOT NULL DEFAULT '_global',
      title           TEXT NOT NULL,
      content         TEXT NOT NULL,
      summary         TEXT,
      tags            TEXT,
      session_id      TEXT,
      status          TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','superseded','archived','invalid')),
      lifecycle       TEXT NOT NULL DEFAULT 'milestone'
                      CHECK (lifecycle IN ('permanent','milestone','ephemeral')),
      confidence      REAL NOT NULL DEFAULT 1.0
                      CHECK (confidence >= 0 AND confidence <= 1),
      relevance_score REAL,
      source          TEXT NOT NULL DEFAULT 'session'
                      CHECK (source IN ('session','import','manual','derived')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at     TEXT,
      access_count    INTEGER NOT NULL DEFAULT 0,
      boost           REAL NOT NULL DEFAULT 0.0
    );

    CREATE TABLE memory_links (
      from_id    INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
      to_id      INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
      type       TEXT NOT NULL
                 CHECK (type IN ('supersedes','relates_to','derived_from','contradicts','part_of','references')),
      weight     REAL NOT NULL DEFAULT 1.0,
      reason     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (from_id, to_id, type)
    );
  `);
  return db;
}

/**
 * Convenience: insert a v1 memory row and return its id.
 */
function seedV1(
  db: Database.Database,
  args: {
    category?: string;
    project?: string;
    title: string;
    content?: string;
    summary?: string | null;
    tags?: string | null;
    status?: string;
    lifecycle?: string;
    confidence?: number;
    relevance_score?: number | null;
    source?: string;
    accessed_at?: string | null;
    access_count?: number;
    boost?: number;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO memory (
        category, project, title, content, summary, tags, status, lifecycle,
        confidence, relevance_score, source, accessed_at, access_count, boost
      ) VALUES (
        @category, @project, @title, @content, @summary, @tags, @status, @lifecycle,
        @confidence, @relevance_score, @source, @accessed_at, @access_count, @boost
      )`,
    )
    .run({
      category: args.category ?? 'note',
      project: args.project ?? '_global',
      title: args.title,
      content: args.content ?? '',
      summary: args.summary ?? null,
      tags: args.tags ?? null,
      status: args.status ?? 'active',
      lifecycle: args.lifecycle ?? 'milestone',
      confidence: args.confidence ?? 1.0,
      relevance_score: args.relevance_score ?? null,
      source: args.source ?? 'session',
      accessed_at: args.accessed_at ?? null,
      access_count: args.access_count ?? 0,
      boost: args.boost ?? 0.0,
    });
  return Number(result.lastInsertRowid);
}

describe('runImportFromMemSol — basic', () => {
  let source: Database.Database;
  let target: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    source = createMemSolDb();
    target = createInMemoryDb();
  });

  it('inserts a single memory with all fields mapped', () => {
    seedV1(source, {
      category: 'note',
      project: '_global',
      title: 'Hello',
      content: 'world content',
      summary: 'greeting',
      tags: '["hello","greet"]',
      status: 'active',
      lifecycle: 'permanent',
      confidence: 0.95,
      relevance_score: 0.7,
      boost: 0.5,
    });

    const result = runImportFromMemSol(source, target);
    expect(result.memories_inserted).toBe(1);
    expect(result.memories_skipped).toBe(0);
    expect(result.memories_failed).toBe(0);

    const row = target.prepare('SELECT * FROM memories').get() as Record<string, unknown>;
    expect(row.title).toBe('Hello');
    expect(row.project_id).toBe('_global'); // mapped from project
    expect(row.category).toBe('note');
    expect(row.lifecycle).toBe('permanent');
    expect(row.confidence).toBe(0.95);
    expect(row.importance_score).toBe(0.7); // mapped from relevance_score
    expect(row.boost).toBe(0.5);
    expect(row.source).toBe('import'); // remapped from v1's session/manual → v2's 'import'
  });

  it('remaps ids (v1_id 1 → v2_id is auto-assigned)', () => {
    seedV1(source, { title: 'a' });
    seedV1(source, { title: 'b' });
    seedV1(source, { title: 'c' });
    const result = runImportFromMemSol(source, target);
    expect(Object.keys(result.id_map).length).toBe(3);
    expect(result.id_map[1]).toBe(1); // first insert gets id 1
    expect(result.id_map[2]).toBe(2);
    expect(result.id_map[3]).toBe(3);
  });

  it('parses JSON-encoded tags into memory_tag junction', () => {
    seedV1(source, { title: 'tagged', tags: '["alpha","beta","gamma"]' });
    runImportFromMemSol(source, target);

    const tags = target
      .prepare('SELECT tag FROM memory_tag ORDER BY tag')
      .all() as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('handles null/empty/malformed tags without crashing', () => {
    seedV1(source, { title: 'no tags', tags: null });
    seedV1(source, { title: 'empty array', tags: '[]' });
    seedV1(source, { title: 'malformed', tags: '{not json' });
    seedV1(source, { title: 'not array', tags: '"a string"' });

    const result = runImportFromMemSol(source, target);
    expect(result.memories_inserted).toBe(4);
    expect((target.prepare('SELECT COUNT(*) AS c FROM memory_tag').get() as { c: number }).c).toBe(0);
  });

  it('defaults importance_score to 1.0 when relevance_score is null', () => {
    seedV1(source, { title: 'no relevance', relevance_score: null });
    runImportFromMemSol(source, target);
    const row = target.prepare('SELECT importance_score FROM memories').get() as {
      importance_score: number;
    };
    expect(row.importance_score).toBe(1.0);
  });

  it('uses default_layer option for v1 entries (default episodic)', () => {
    seedV1(source, { title: 'default layer' });
    seedV1(source, { title: 'override layer' });
    runImportFromMemSol(source, target, { default_layer: 'semantic' });

    const layers = target.prepare('SELECT layer FROM memories ORDER BY title').all() as Array<{
      layer: string;
    }>;
    expect(layers.map((l) => l.layer)).toEqual(['semantic', 'semantic']);
  });
});

describe('runImportFromMemSol — idempotency', () => {
  let source: Database.Database;
  let target: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    source = createMemSolDb();
    target = createInMemoryDb();
  });

  it('skips (not errors) on (project_id, title) duplicate', () => {
    // Pre-seed the target with a row that has the same project_id+title as the v1 row
    target
      .prepare(
        `INSERT INTO memories (title, slug, content, project_id, category, source)
         VALUES ('dup', 'dup', 'preexisting content', '_global', 'note', 'manual')`,
      )
      .run();

    seedV1(source, {
      title: 'dup',
      project: '_global',
      content: 'new content that should not overwrite',
    });

    const result = runImportFromMemSol(source, target);
    expect(result.memories_inserted).toBe(0);
    expect(result.memories_skipped).toBe(1);
    expect(result.memories_failed).toBe(0);

    // Content was NOT overwritten
    const row = target.prepare('SELECT content FROM memories').get() as { content: string };
    expect(row.content).toBe('preexisting content');
  });

  it('inserts non-duplicate rows in the same batch', () => {
    target
      .prepare(
        `INSERT INTO memories (title, slug, content, project_id, category, source)
         VALUES ('existing', 'existing', 'x', '_global', 'note', 'manual')`,
      )
      .run();

    seedV1(source, { title: 'existing' }); // dupe
    seedV1(source, { title: 'fresh-a' });
    seedV1(source, { title: 'fresh-b' });

    const result = runImportFromMemSol(source, target);
    expect(result.memories_inserted).toBe(2);
    expect(result.memories_skipped).toBe(1);
  });
});

describe('runImportFromMemSol — wikilink extraction (two-pass)', () => {
  let source: Database.Database;
  let target: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    source = createMemSolDb();
    target = createInMemoryDb();
  });

  it('extracts wikilinks after all memories are inserted (handles forward refs)', () => {
    // A references B; B is inserted AFTER A in the source.
    // Without two-pass, A's wikilink to B would fail.
    seedV1(source, { title: 'A', content: 'See [[B]]' });
    seedV1(source, { title: 'B', content: 'standalone' });

    const result = runImportFromMemSol(source, target);
    expect(result.wikilinks_inserted).toBe(1);

    const synapse = target
      .prepare('SELECT * FROM synapses WHERE connection_type = ?')
      .get('wikilink') as { source_id: number; target_id: number };
    expect(synapse.source_id).toBe(1); // A
    expect(synapse.target_id).toBe(2); // B
  });

  it('counts broken wikilinks (refs that do not resolve to any memory)', () => {
    seedV1(source, { title: 'lonely', content: 'Refers to [[nonexistent]]' });
    const result = runImportFromMemSol(source, target);
    expect(result.wikilinks_inserted).toBe(0);
    expect(result.wikilinks_broken).toBe(1);
  });

  it('skips self-references', () => {
    seedV1(source, { title: 'selfish', content: 'talks about [[Selfish]]' });
    const result = runImportFromMemSol(source, target);
    // extractWikilinks finds [[Selfish]]; resolveWikilink finds Selfish; upsertWikilinkSynapse
    // guards against source_id === target_id → no synapse created, but we count it as "broken"
    // (it's not strictly broken, but it has no edge either).
    expect(result.wikilinks_inserted).toBe(0);
  });
});

describe('runImportFromMemSol — v1 link migration', () => {
  let source: Database.Database;
  let target: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    source = createMemSolDb();
    target = createInMemoryDb();
  });

  it('migrates relates_to links as wikilink synapses (preserves weight)', () => {
    const a = seedV1(source, { title: 'a' });
    const b = seedV1(source, { title: 'b' });
    source
      .prepare(
        `INSERT INTO memory_links (from_id, to_id, type, weight) VALUES (?, ?, 'relates_to', 1.5)`,
      )
      .run(a, b);

    const result = runImportFromMemSol(source, target);
    expect(result.links_inserted).toBe(1);

    const synapse = target
      .prepare('SELECT * FROM synapses WHERE connection_type = ?')
      .get('wikilink') as { source_id: number; target_id: number; weight: number };
    expect(synapse.source_id).toBe(1); // v1 a → v2 id 1
    expect(synapse.target_id).toBe(2); // v1 b → v2 id 2
    expect(synapse.weight).toBe(1.5);
  });

  it('preserves the connection (not the v1 type label) for derived_from / part_of', () => {
    // The v1 type label is NOT stored — but the connection survives.
    // Operator can re-derive the original type by querying the source DB.
    const a = seedV1(source, { title: 'a' });
    const b = seedV1(source, { title: 'b' });
    source
      .prepare(
        `INSERT INTO memory_links (from_id, to_id, type, weight) VALUES (?, ?, 'derived_from', 1.0)`,
      )
      .run(a, b);
    source
      .prepare(
        `INSERT INTO memory_links (from_id, to_id, type, weight) VALUES (?, ?, 'part_of', 1.0)`,
      )
      .run(b, a);

    const result = runImportFromMemSol(source, target);
    expect(result.links_inserted).toBe(2);

    // Both are wikilink synapses; we lost the derived_from/part_of distinction
    const types = target
      .prepare('SELECT DISTINCT connection_type FROM synapses')
      .all() as Array<{ connection_type: string }>;
    expect(types.map((t) => t.connection_type)).toEqual(['wikilink']);
  });

  it('skips links where endpoint is missing (dupe-skipped on insert)', () => {
    // a and b get inserted, c is skipped (dupe), but a v1 link references c
    target
      .prepare(
        `INSERT INTO memories (title, slug, content, project_id, category, source)
         VALUES ('c', 'c', 'x', '_global', 'note', 'manual')`,
      )
      .run();

    const a = seedV1(source, { title: 'a' });
    const c = seedV1(source, { title: 'c', project: '_global' }); // dupe
    source
      .prepare(
        `INSERT INTO memory_links (from_id, to_id, type, weight) VALUES (?, ?, 'relates_to', 1.0)`,
      )
      .run(a, c); // target c was skipped → link should be skipped

    const result = runImportFromMemSol(source, target);
    expect(result.memories_skipped).toBe(1);
    expect(result.links_inserted).toBe(0);
    expect(result.links_skipped).toBe(1);
  });
});

describe('runImportFromMemSol — dry_run', () => {
  let source: Database.Database;
  let target: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    source = createMemSolDb();
    target = createInMemoryDb();
  });

  it('reports counts but writes nothing when dry_run=true', () => {
    seedV1(source, { title: 'a' });
    seedV1(source, { title: 'b' });
    seedV1(source, { title: 'c' });

    const result = runImportFromMemSol(source, target, { dry_run: true });
    expect(result.dry_run).toBe(true);
    expect(result.memories_total).toBe(3);
    expect(result.memories_inserted).toBe(0);

    // Nothing actually written to target
    const count = target.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number };
    expect(count.c).toBe(0);
  });
});

describe('runImportFromMemSol — pure function shape', () => {
  it('does not close the source db (caller controls lifecycle)', () => {
    const source = createMemSolDb();
    seedV1(source, { title: 'a' });
    const target = createInMemoryDb();
    runImportFromMemSol(source, target);
    // If runImportFromMemSol closed the source, this would throw.
    const row = source.prepare('SELECT COUNT(*) AS c FROM memory').get() as { c: number };
    expect(row.c).toBe(1);
  });

  it('returns the same result shape for empty source as for non-empty', () => {
    const source = createMemSolDb();
    const target = createInMemoryDb();
    const result = runImportFromMemSol(source, target);
    expect(result).toMatchObject({
      dry_run: false,
      memories_total: 0,
      memories_inserted: 0,
      wikilinks_inserted: 0,
      links_total: 0,
    });
  });
});