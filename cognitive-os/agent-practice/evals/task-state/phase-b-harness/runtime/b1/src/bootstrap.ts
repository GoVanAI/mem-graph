import type Database from 'better-sqlite3';
import { slugify } from './wikilink.js';

export interface BootstrapEntry {
  layer?: 'working' | 'episodic' | 'procedural' | 'semantic' | 'partner';
  category: string;
  project_id?: string;
  title: string;
  content: string;
  summary: string;
  tags: string[];
  lifecycle: 'permanent' | 'milestone' | 'ephemeral';
  confidence: number;
  source: 'session' | 'import' | 'manual' | 'derived';
  importance_score?: number;
}

const ENTRIES: BootstrapEntry[] = [
  {
    layer: 'semantic',
    category: 'note',
    project_id: '_global',
    title: 'Mem-graph purpose',
    summary:
      'Mem-graph is the v2 graph-relational memory layer: a layered memory model with wikilinks, BM25 auto-linking, spreading activation, and synaptic decay. Backed by better-sqlite3.',
    content:
      'Mem-graph is the LLM\'s persistent memory between opencode sessions. It builds on mem-sol v1\'s relational foundation and adds four capabilities: (1) a five-layer memory model (working, episodic, procedural, semantic, partner) with layer-aware decay and retrieval, (2) markdown-style `[[wikilink]]` syntax for operator-curated edges, (3) BM25 auto-linking on every insert for soft emergent edges within the same project, and (4) spreading activation retrieval — text-match + neighborhood traversal with weight attenuation, replacing pure FTS search. The relational layer (memories table with category, lifecycle, confidence, boost, summary) is preserved unchanged from v1; the graph layer is added as a sister table (synapses) plus a decay matrix. Schema is `SELECT *`-legible, the LLM is the traversal agent, the MCP is the substrate.',
    tags: ['mem-graph', 'purpose', 'meta', 'v2'],
    lifecycle: 'permanent',
    confidence: 1.0,
    source: 'manual',
    importance_score: 1.0,
  },
  {
    layer: 'semantic',
    category: 'note',
    project_id: '_global',
    title: 'Mem-graph design philosophy',
    summary:
      'Pragmatic graph-relational memory. Layered, not flat. Wikilinks in prose, not buried in tool calls. Spreading activation with bounded query semantics (depth, weight floor, cap) prevents hairballs. Three critical issues from the v1 review are fixed in the implementation.',
    content:
      'Operating principles for mem-graph: (1) Layered, not flat. Five discrete layers (working/episodic/procedural/semantic/partner) plus continuous synaptic decay — the decay rate varies by source/target layer pair and connection type. (2) Wikilinks in prose, not in tool calls. `[[reference]]` is visible markdown; an operator can read a memory and see its connections. (3) Bounded query semantics. Spreading activation has three independent bounds (max_hop_depth, min_synapse_weight, limit_cap) — no hairball queries. (4) Tag storage as a junction table, not a JSON column. Avoids FTS5 noise from `["fts5","porter"]` text and enables tag-intersection queries. (5) Critical fixes from the v1 review: the pass-through layer SQL uses a path column in the recursive CTE (not the broken EXISTS subquery from the design draft), the decay matrix subquery has `ORDER BY ... LIMIT 1` (specific rows win, wildcards are fallback), and the slug column supports `[[error-resolution-loop]]` style wikilinks in addition to `[[error resolution loop]]` and `[[id]]`. See [[Mem-graph schema reference]] for the full DDL.',
    tags: ['mem-graph', 'design', 'philosophy', 'meta'],
    lifecycle: 'permanent',
    confidence: 1.0,
    source: 'manual',
    importance_score: 1.0,
  },
  {
    layer: 'procedural',
    category: 'note',
    project_id: '_global',
    title: 'Mem-graph schema reference',
    summary:
      'Quick reference for mem-graph tables: memories, synapses, memory_tag, memories_fts, decay_matrix. Five layers, three connection types, bounded activation query.',
    content:
      'Tables: `memories` (id INTEGER PK, layer, title, slug, content, project_id, category, lifecycle, status, confidence, boost, summary, session_id, source, created_at, updated_at, accessed_at, access_count, importance_score, expires_at, refresh_strategy). `synapses` (source_id, target_id, connection_type, weight, access_count; PK = (source_id, target_id, connection_type); connection_type IN (wikilink, bm25_auto, parent_child); weight 0.0–5.0). `memory_tag` (memory_id, tag; junction table, ON DELETE CASCADE). `memories_fts` (FTS5 mirror of memories, porter stemmer + 2/3-char prefix). `decay_matrix` (source_layer, target_layer, connection_type, decay_rate; target_layer = "*" wildcard). Five layers: working, episodic, procedural, semantic, partner. Three connection types: wikilink (operator-curated, weight 1.0 +0.5 on conflict, capped at 5.0), bm25_auto (auto on insert, weight = max(0.2, min(1.5, abs(score)/10))), parent_child (reserved for future use). Spreading activation defaults: max_hop_depth=2, min_synapse_weight=0.3, limit_cap=20, land_on_layers=[procedural, episodic, semantic, partner], pass_through_layers=[semantic]. See [[Mem-graph purpose]] for context.',
    tags: ['mem-graph', 'schema', 'reference'],
    lifecycle: 'permanent',
    confidence: 1.0,
    source: 'manual',
    importance_score: 1.0,
  },
  {
    layer: 'procedural',
    category: 'note',
    project_id: 'mem-graph',
    title: 'Mem-graph example entry with wikilinks',
    summary:
      'Sample bootstrap entry that exercises the wikilink extraction and BM25 auto-linking pipeline. Has four wikilinks to other bootstrap entries and long-enough prose for the BM25 pass to find neighbors.',
    content:
      'This bootstrap entry exists to exercise two v2-specific behaviors on first run: (1) wikilink extraction — the content below contains four wikilink references to other bootstrap entries, and the `memory_add` write path will upsert synapses for each. (2) BM25 auto-linking — the prose below intentionally overlaps with [[Mem-graph project state]] and [[Mem-graph schema reference]] on shared vocabulary (mem-graph, project, schema, schema reference, references, bootstrap, v0.1.0, implementation, code-complete, design, layer, layers, FTS5, BM25, spreading activation) so the auto-link pass will create several `bm25_auto` synapses in the same project (`mem-graph`). The references are: [[Mem-graph purpose]], [[Mem-graph design philosophy]], [[Mem-graph schema reference]], [[Mem-graph project state]]. After first run, `memory_spread_stats` should show non-zero outgoing and incoming synapses for this entry, and `memory_activate("wikilink example")` should surface this entry plus its linked neighbors via spreading activation. If any of these are zero, the wikilink or auto-link pipeline has regressed.',
    tags: ['mem-graph', 'example', 'wikilinks', 'auto-link', 'bootstrap-test'],
    lifecycle: 'permanent',
    confidence: 0.9,
    source: 'manual',
    importance_score: 0.7,
  },
];

export function runBootstrapIfEmpty(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number };
  if (row.c > 0) return 0;

  const insertMemory = db.prepare(`
    INSERT INTO memories (
      layer, title, slug, content, project_id, category, lifecycle, status,
      confidence, boost, summary, session_id, source, importance_score
    ) VALUES (
      @layer, @title, @slug, @content, @project_id, @category, @lifecycle, 'active',
      @confidence, 0.0, @summary, @session_id, @source, @importance_score
    )
  `);

  const insertTag = db.prepare(`
    INSERT OR IGNORE INTO memory_tag (memory_id, tag) VALUES (?, ?)
  `);

  const insertAll = db.transaction((entries: BootstrapEntry[]) => {
    for (const e of entries) {
      const result = insertMemory.run({
        layer: e.layer ?? 'episodic',
        title: e.title,
        slug: slugify(e.title),
        content: e.content,
        project_id: e.project_id ?? '_global',
        category: e.category,
        lifecycle: e.lifecycle,
        confidence: e.confidence,
        summary: e.summary,
        session_id: null,
        source: e.source,
        importance_score: e.importance_score ?? 1.0,
      });
      const id = Number(result.lastInsertRowid);
      for (const tag of e.tags) {
        insertTag.run(id, tag);
      }
    }
  });

  insertAll(ENTRIES);
  return ENTRIES.length;
}
