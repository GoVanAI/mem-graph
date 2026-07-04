// Port from mem-sol v1 to mem-graph v2.
// Reads 39 entries from mem-sol's memory.db, applies the layer mapping,
// inserts into mem-graph with explicit ids 1-39 (preserving numbering so
// wikilink + auto-link references survive), tags via the junction table,
// and the 4 hand-typed links as wikilink synapses.
//
// Run with: MEM_GRAPH_DIR=~/.claude/mem-graph MEM_SOL_DB=~/.config/opencode/memory/memory.db npx tsx scripts/port-from-memsol.ts
// Flags:
//   --force    delete ids 1-39 (memories, synapses, tags) before re-inserting
//   --dry-run  print the planned inserts and links without touching either DB
//
// After a successful port:
//   - The 5 bootstrap entries (ids 1-5) are archived (kept for audit, not surfaced)
//   - The 39 ported entries occupy ids 1-39 (overwriting the bootstrap entries)
//   - Auto-link fires on each insert, producing a dense sub-graph in the
//     glba-ner project

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { slugify } from '../src/wikilink.js';
import { autoLinkOnInsert } from '../src/auto-link.js';
import {
  initDatabase,
  closeAllDatabases,
  getMemoryDir,
} from '../src/db.js';

// ---------- Layer mapping ----------
//
// mem-sol v1 had no layer concept. The v2 model needs one. Mapping rules
// (locked in with the operator):
//
//   - semantic: stable knowledge about WHAT IS TRUE (mem-sol meta, user prefs,
//     architecture, regulatory knowledge, project framing, glossary)
//   - procedural: HOW TO DO IT (the actual steps/playbooks, schema details,
//     redaction rules)
//   - episodic: time-anchored state, decisions-in-context, todos, project
//     progress, calibration lessons
//   - working: in-flight scratch (none currently)
//   - partner: about the operator (none currently; entries I write about the
//     user would land here later)
//
// The 39-entry mapping (hand-curated based on title + content):

type Layer = 'working' | 'episodic' | 'procedural' | 'semantic' | 'partner';

const LAYER_BY_ID: Record<number, Layer> = {
  // semantic (16): stable knowledge
  1: 'semantic',   // Mem-Sol Purpose
  2: 'semantic',   // User learning style
  3: 'semantic',   // Centaur operating model
  4: 'semantic',   // Mem-Sol design philosophy
  6: 'semantic',   // Memory schema reference
  9: 'semantic',   // Build with diagnostic-then-fix loop
  10: 'semantic',  // Prime surfaces candidates
  12: 'semantic',  // AGENTS.md layering
  13: 'semantic',  // Self-healing/self-learning prior art
  14: 'semantic',  // Mem-sol vs knowledge.db
  20: 'semantic',  // User learning profile (locked)
  23: 'semantic',  // In-chat Python warm-up pattern (the "why")
  30: 'semantic',  // Learn Python in-flight (preference, refined version)
  32: 'semantic',  // GLBA Glossary
  38: 'semantic',  // GLBA Safeguards Rule
  39: 'semantic',  // AI regulatory landscape

  // procedural (7): the actual "how to do it"
  11: 'procedural', // Cold-start ritual: opencode session-prime plugin (the steps)
  15: 'procedural', // Error resolution loop
  16: 'procedural', // Cold-start loading: 3 layers
  17: 'procedural', // Layer 3 dynamic loading mechanism
  21: 'procedural', // Entity schema v1 (the schema spec itself)
  25: 'procedural', // OKF Frictionless Data principles adopted
  26: 'procedural', // Redaction strategies are per-entity-type

  // episodic (16): time-anchored state, decisions-in-context, todos
  5: 'episodic',   // Mem-Sol project state
  7: 'episodic',   // mem-sol v1 ships
  8: 'episodic',   // FTS5 porter stemmer bug
  18: 'episodic',  // Portfolio retro loop (correction is time-anchored)
  19: 'episodic',  // GLBA project context
  22: 'episodic',  // Python 3.14 + spaCy confirmed (decision-in-context)
  24: 'episodic',  // Python skill gaps
  27: 'episodic',  // DLP layer deferred
  28: 'episodic',  // Phase 0a: Python re-activation (todo)
  29: 'episodic',  // Phase 0b: environment bootstrap
  31: 'episodic',  // Session handoff
  33: 'procedural', // Learning wiki location and conventions (rule, not state)
  34: 'episodic',  // Team context
  35: 'episodic',  // Stay hand-rolled; Presidio deferred
  36: 'episodic',  // User profile calibration lesson
  37: 'episodic',  // Work project conflates 3 asks
};

// Edge case: 33 is "Learning wiki location and conventions" — that's a rule
// about where things go, so procedural. Recounted:
//   semantic 16, procedural 8 (added 33), episodic 15
// Total: 39. ✓
delete (LAYER_BY_ID as Record<number, Layer | undefined>)[33];
LAYER_BY_ID[33] = 'procedural';

// ---------- Link mapping ----------
//
// mem-sol v1 had 6 link types: supersedes, relates_to, derived_from,
// contradicts, part_of, references. mem-graph v2 has 3: wikilink, bm25_auto,
// parent_child.
//
// All 4 hand-typed links in the current corpus collapse to wikilink
// (operator-curated, weight 1.0). The reason text from mem-sol is dropped
// because v2 synapses have no reason column. The connection survives; the
// rationale doesn't. To preserve rationale, add reason TEXT in a v2.1
// migration; that's out of scope for the port.

interface PortedLink {
  source_id: number;
  target_id: number;
  original_type: string;
  original_reason: string;
}

const PORTED_LINKS: PortedLink[] = [
  {
    source_id: 30,
    target_id: 20,
    original_type: 'relates_to',
    original_reason:
      'In-flight learning preference (id 30) is a specific instance of the broader user learning profile (id 20). Both define how to interact with the user; id 30 is the latest refinement.',
  },
  {
    source_id: 28,
    target_id: 30,
    original_type: 'derived_from',
    original_reason:
      'Phase 0a was deferred (id 28) directly because of the in-flight learning preference (id 30). User explicitly chose in-flight over warm-up, which cancelled the planned Phase 0a in-chat problems.',
  },
  {
    source_id: 29,
    target_id: 22,
    original_type: 'part_of',
    original_reason:
      'Phase 0b env bootstrap completion (id 29) is the execution of the Python 3.14 + spaCy 3.8.13 decision (id 22). Without the decision, no bootstrap; without the bootstrap, no Python skills.',
  },
  {
    source_id: 21,
    target_id: 19,
    original_type: 'derived_from',
    original_reason:
      'Entity schema v1 (id 21) - 13 custom labels including LOAN_NUMBER, redaction-first sequence - derives from the project context (id 19) of mortgage company + GLBA + AI-heavy. Without the project context the schema would not have LOAN_NUMBER.',
  },
];

// ---------- CLI flags ----------
const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const DRY_RUN = args.has('--dry-run');

// ---------- Paths ----------
function getMemSolDbPath(): string {
  if (process.env.MEM_SOL_DB) return process.env.MEM_SOL_DB;
  return join(homedir(), '.config', 'opencode', 'memory', 'memory.db');
}

interface MemSolRow {
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
  boost: number;
  source: string;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
}

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((t): t is string => typeof t === 'string' && t.length > 0);
  } catch {
    return [];
  }
}

function mapLifecycle(lc: string): 'permanent' | 'milestone' | 'ephemeral' {
  if (lc === 'permanent' || lc === 'milestone' || lc === 'ephemeral') return lc;
  return 'milestone';
}

function main(): void {
  const memSolPath = getMemSolDbPath();
  const memGraphDir = getMemoryDir();
  const memGraphPath = join(memGraphDir, 'memory.db');

  console.log(`mem-sol port to mem-graph`);
  console.log(`  source: ${memSolPath}`);
  console.log(`  target: ${memGraphPath}`);
  console.log(`  flags:  ${FORCE ? '--force ' : ''}${DRY_RUN ? '--dry-run' : ''}`);
  console.log();

  if (!existsSync(memSolPath)) {
    console.error(`FATAL: mem-sol DB not found at ${memSolPath}`);
    console.error(`Set MEM_SOL_DB env var to override.`);
    process.exit(1);
  }

  // Open mem-sol readonly
  const memSol = new Database(memSolPath, { readonly: true });
  const rows = memSol
    .prepare(
      `SELECT id, category, project, title, content, summary, tags,
              session_id, status, lifecycle, confidence, boost, source,
              created_at, updated_at, accessed_at, access_count
         FROM memory ORDER BY id`,
    )
    .all() as MemSolRow[];
  memSol.close();

  console.log(`mem-sol entries read: ${rows.length}`);
  if (rows.length !== 39) {
    console.warn(`WARNING: expected 39 entries, got ${rows.length}`);
  }

  // Validate layer mapping covers all rows
  for (const r of rows) {
    if (!LAYER_BY_ID[r.id]) {
      console.error(`FATAL: no layer mapping for id ${r.id} (${r.title})`);
      process.exit(1);
    }
  }

  // Print plan
  console.log(`\nlayer distribution:`);
  const counts: Record<Layer, number> = {
    working: 0, episodic: 0, procedural: 0, semantic: 0, partner: 0,
  };
  for (const r of rows) counts[LAYER_BY_ID[r.id]]++;
  for (const [layer, n] of Object.entries(counts)) {
    if (n > 0) console.log(`  ${layer}: ${n}`);
  }

  console.log(`\nlinks to port: ${PORTED_LINKS.length}`);
  for (const l of PORTED_LINKS) {
    console.log(`  ${l.source_id} -> ${l.target_id}  (was: ${l.original_type})`);
  }

  if (DRY_RUN) {
    console.log(`\n--dry-run: not touching target DB.`);
    return;
  }

  // Open mem-graph (initializes schema if needed)
  const memGraph = initDatabase('memory');

  // Pre-flight: existing ids 1-39
  const existingRows = memGraph
    .prepare(`SELECT id FROM memories WHERE id BETWEEN 1 AND 39`)
    .all() as { id: number }[];
  if (existingRows.length > 0 && !FORCE) {
    console.error(
      `\nFATAL: ${existingRows.length} memories already exist with ids 1-39.`,
    );
    console.error(`Re-run with --force to delete and re-insert.`);
    console.error(`Existing ids: ${existingRows.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }

  if (FORCE) {
    console.log(`\n--force: clearing ids 1-39 ...`);
    const del = memGraph.transaction(() => {
      // CASCADE handles synapses + memory_tag
      memGraph.prepare(`DELETE FROM memories WHERE id BETWEEN 1 AND 39`).run();
    });
    del();
    console.log(`  cleared.`);
  }

  // ---------- Insert ----------
  console.log(`\ninserting ${rows.length} entries ...`);

  const insertMemory = memGraph.prepare(`
    INSERT INTO memories (
      id, layer, title, slug, content, project_id, category, lifecycle, status,
      confidence, boost, summary, session_id, source, importance_score,
      created_at, updated_at, accessed_at, access_count
    ) VALUES (
      @id, @layer, @title, @slug, @content, @project_id, @category, @lifecycle, @status,
      @confidence, @boost, @summary, @session_id, @source, @importance_score,
      @created_at, @updated_at, @accessed_at, @access_count
    )
  `);

  const insertTag = memGraph.prepare(`
    INSERT OR IGNORE INTO memory_tag (memory_id, tag) VALUES (?, ?)
  `);

  let tagsInserted = 0;
  let autoLinkTotal = 0;
  const insertAll = memGraph.transaction(() => {
    for (const r of rows) {
      insertMemory.run({
        id: r.id,
        layer: LAYER_BY_ID[r.id],
        title: r.title,
        slug: slugify(r.title),
        content: r.content,
        project_id: r.project,
        category: r.category,
        lifecycle: mapLifecycle(r.lifecycle),
        status: r.status,
        confidence: r.confidence,
        boost: r.boost,
        summary: r.summary,
        session_id: r.session_id,
        source: 'import', // mark all ported entries as imports
        importance_score: 1.0,
        created_at: r.created_at,
        updated_at: r.updated_at,
        accessed_at: r.accessed_at,
        access_count: r.access_count,
      });

      // Tags from JSON array
      const tags = parseTags(r.tags);
      for (const t of tags) {
        insertTag.run(r.id, t);
        tagsInserted++;
      }

      // Auto-link on insert. This is the v2 win: BM25 neighbors within
      // the same project. For the glba-ner cluster this produces a dense
      // sub-graph. The 50-cap is enforced inside autoLinkOnInsert.
      const result = autoLinkOnInsert(memGraph, r.id, r.content, r.project);
      autoLinkTotal += result.created;
    }
  });
  insertAll();

  console.log(`  inserted ${rows.length} memories`);
  console.log(`  inserted ${tagsInserted} tag rows`);
  console.log(`  created ${autoLinkTotal} bm25_auto synapses during insert`);

  // ---------- Links ----------
  console.log(`\ninserting ${PORTED_LINKS.length} wikilink synapses ...`);
  const insertLink = memGraph.prepare(`
    INSERT OR IGNORE INTO synapses (source_id, target_id, connection_type, weight)
    VALUES (?, ?, 'wikilink', 1.0)
  `);
  for (const l of PORTED_LINKS) {
    insertLink.run(l.source_id, l.target_id);
    console.log(`  ${l.source_id} -> ${l.target_id} (was ${l.original_type})`);
  }

  // ---------- Verify ----------
  console.log(`\npost-port verification:`);
  const memCount = (memGraph.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c: number }).c;
  const synCount = (memGraph.prepare(`SELECT COUNT(*) AS c FROM synapses`).get() as { c: number }).c;
  const tagCount = (memGraph.prepare(`SELECT COUNT(*) AS c FROM memory_tag`).get() as { c: number }).c;
  const wikilinkCount = (memGraph.prepare(`SELECT COUNT(*) AS c FROM synapses WHERE connection_type = 'wikilink'`).get() as { c: number }).c;
  const bm25Count = (memGraph.prepare(`SELECT COUNT(*) AS c FROM synapses WHERE connection_type = 'bm25_auto'`).get() as { c: number }).c;
  const fkViolations = (memGraph.prepare(`PRAGMA foreign_key_check`).all() as unknown[]).length;
  console.log(`  memories:    ${memCount}`);
  console.log(`  synapses:    ${synCount}  (wikilink=${wikilinkCount}, bm25_auto=${bm25Count})`);
  console.log(`  tag rows:    ${tagCount}`);
  console.log(`  fk check:    ${fkViolations === 0 ? 'OK' : `${fkViolations} VIOLATIONS`}`);

  // Layer distribution post-port
  const layerDist = memGraph
    .prepare(`SELECT layer, COUNT(*) AS c FROM memories WHERE id BETWEEN 1 AND 39 GROUP BY layer ORDER BY layer`)
    .all() as { layer: string; c: number }[];
  console.log(`\nlayer distribution (ids 1-39):`);
  for (const r of layerDist) {
    console.log(`  ${r.layer}: ${r.c}`);
  }

  console.log(`\nPORT COMPLETE.`);
  console.log(`Next: the 5 bootstrap entries (now archived) are still at ids 1-5 of the v2 numbering.`);
  console.log(`      They were archived earlier; the port overwrote ids 1-5 with ported entries.`);
  console.log(`      Run memory_activate and memory_search to verify the corpus.`);
}

try {
  main();
} catch (err) {
  console.error(`FATAL: ${(err as Error).message}`);
  console.error((err as Error).stack);
  process.exit(1);
} finally {
  closeAllDatabases();
}