#!/usr/bin/env -S npx tsx
/**
 * Cognitive lane contamination audit.
 *
 * ## Purpose (per [[300]] RCA — low-priority action)
 *
 * The r/mlops "long-term memory is an attack surface" finding (memory 299 §1)
 * raises the question: which routes could leak contextual records into the
 * governing lane under pressure? We have a partial mitigation
 * (`cognitive_current_guidance_diagnose` with stable exclusion reasons) but no
 * systematic audit yet.
 *
 * ## Epistemic classification (Gather.5)
 *
 * - **External (reported):** `cognitive_current_guidance_diagnose` exists with
 *   stable exclusion reasons (verified via `src/cognitive/retrieval.ts`).
 * - **Derivation (inferred):** the audit shape (per-project, summarize lane
 *   distribution) is our design.
 * - **Awaiting operator validation (assumed):** the threshold for "concerning"
 *   lane distribution; the script reports raw numbers, doesn't pass judgment.
 *
 * ## Usage
 *
 *   npx tsx scripts/cognitive_contamination_audit.ts [project_id] [--limit=200]
 *
 * Exit code: 0 = ran successfully; non-zero = invalid invocation.
 *
 * ## Output
 *
 *   JSON with: project_id, total_scanned, lane_distribution
 *   { governing: N, contextual: N, excluded_working: N, excluded_ephemeral: N,
 *   excluded_category: N, excluded_other: N }, sample_exclusions
 *   [{memory_id, exclusion_reasons, title, summary}] (first 10).
 */

import { resolve } from 'node:path';
import Database from 'better-sqlite3';

const LIVE_DB = process.env.STEP10_LIVE_DB
  || resolve(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude/mem-graph/memory.db');

interface MemoryRow {
  id: number;
  title: string;
  status: string;
  project_id: string;
  category: string | null;
  layer: string;
  lifecycle: string;
  summary: string | null;
  importance_score: number;
}

interface LaneDistribution {
  governing: number;
  contextual: number;
  excluded_working: number;
  excluded_ephemeral: number;
  excluded_category: number;
  excluded_other: number;
}

function parseArgs(argv: string[]): { project: string; limit: number; help: boolean } {
  let project = 'cognitive-os';
  let limit = 200;
  let help = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('--limit=')) limit = Number(arg.split('=')[1]);
    else if (!arg.startsWith('--')) project = arg;
  }
  return { project, limit, help };
}

function loadActiveMemories(db: Database.Database, project: string, limit: number): MemoryRow[] {
  return db.prepare(`
    SELECT id, title, status, project_id, category, layer, lifecycle, summary, importance_score
    FROM memories
    WHERE status = 'active'
      AND project_id = ?
    ORDER BY importance_score DESC, updated_at DESC
    LIMIT ?
  `).all(project, limit) as MemoryRow[];
}

function classify(row: MemoryRow): { lane: 'governing' | 'contextual'; exclusions: string[] } {
  const exclusions: string[] = [];
  if (row.layer === 'working') exclusions.push('working_layer');
  if (row.lifecycle === 'ephemeral') exclusions.push('ephemeral_lifecycle');
  // Mirroring the cognitive.ts allow-list (governing categories from agent-bootstrap)
  const GOVERNING_CATEGORIES = new Set(['decision', 'policy', 'process', 'preference', 'commitment', 'handoff']);
  if (row.category && !GOVERNING_CATEGORIES.has(row.category)) {
    exclusions.push('category_not_governing');
  }
  // Only working/ephemeral/category exclusions are explicit. Other rows are
  // governing-lane eligible (even if they're not currently retrieved as
  // governing — that's a search-time decision, not a lane-membership one).
  if (exclusions.length === 0) return { lane: 'governing', exclusions: [] };
  if (exclusions.some(e => e === 'working_layer' || e === 'ephemeral_lifecycle')) {
    // excludes from governing regardless of category
    return { lane: 'contextual', exclusions };
  }
  // category_not_governing alone: not governing, but not "excluded" in the
  // strong sense — call it contextual.
  return { lane: 'contextual', exclusions };
}

function audit(db: Database.Database, project: string, limit: number) {
  const rows = loadActiveMemories(db, project, limit);
  const distribution: LaneDistribution = {
    governing: 0,
    contextual: 0,
    excluded_working: 0,
    excluded_ephemeral: 0,
    excluded_category: 0,
    excluded_other: 0,
  };
  const sampleExclusions: Array<{ id: number; title: string; category: string | null; exclusion_reasons: string[] }> = [];
  for (const row of rows) {
    const { lane, exclusions } = classify(row);
    if (lane === 'governing') distribution.governing += 1;
    else distribution.contextual += 1;
    for (const e of exclusions) {
      if (e === 'working_layer') distribution.excluded_working += 1;
      else if (e === 'ephemeral_lifecycle') distribution.excluded_ephemeral += 1;
      else if (e === 'category_not_governing') distribution.excluded_category += 1;
      else distribution.excluded_other += 1;
    }
    if (sampleExclusions.length < 10 && exclusions.length > 0) {
      sampleExclusions.push({ id: row.id, title: row.title, category: row.category, exclusion_reasons: exclusions });
    }
  }
  const governingRatio = rows.length === 0 ? 0 : distribution.governing / rows.length;
  return {
    project_id: project,
    total_scanned: rows.length,
    layer_distribution: {
      working: rows.filter(r => r.layer === 'working').length,
      episodic: rows.filter(r => r.layer === 'episodic').length,
      semantic: rows.filter(r => r.layer === 'semantic').length,
      procedural: rows.filter(r => r.layer === 'procedural').length,
      partner: rows.filter(r => r.layer === 'partner').length,
    },
    lifecycle_distribution: {
      permanent: rows.filter(r => r.lifecycle === 'permanent').length,
      milestone: rows.filter(r => r.lifecycle === 'milestone').length,
      ephemeral: rows.filter(r => r.lifecycle === 'ephemeral').length,
    },
    lane_distribution: distribution,
    governing_ratio: Number(governingRatio.toFixed(3)),
    sample_exclusions: sampleExclusions,
    notes: [
      'governing_ratio is informational; pass judgment based on the project',
      'working_layer and ephemeral_lifecycle exclusions are hard — never governing',
      'category_not_governing is the softest exclusion — could be promoted by recategorization',
      'this audit does NOT call any memory_to_mark or memory_update; observe-only',
    ],
  };
}

function main(argv: string[]): number {
  const { project, limit, help } = parseArgs(argv);
  if (help) {
    console.log('Usage: npx tsx scripts/cognitive_contamination_audit.ts [project_id] [--limit=200]');
    return 0;
  }
  const db = new Database(LIVE_DB, { readonly: true });
  try {
    const report = audit(db, project, limit);
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } finally {
    db.close();
  }
}

process.exit(main(process.argv));