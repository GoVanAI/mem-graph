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
 * ## Update 2026-08-10: epistemic_records coverage
 *
 * The first production epistemic admission (record 1, the cognitive-frameworks
 * comparison) exposed a coverage gap: the audit only queried `memories`, not
 * `epistemic_records`. The new epistemic_lane bootstrap output shows record 1
 * but the audit would not. This script now also audits the epistemic_records
 * table for the same project.
 *
 * ## Epistemic classification (Gather.5)
 *
 * - **External (reported):** `cognitive_current_guidance_diagnose` exists with
 *   stable exclusion reasons (verified via `src/cognitive/retrieval.ts`).
 * - **Derivation (inferred):** the audit shape (per-project, summarize lane
 *   distribution across both `memories` and `epistemic_records`) is our design.
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
 *   JSON with: project_id, memories_section { total_scanned, lane_distribution,
 *   sample_exclusions }, epistemic_records_section { total_scanned,
 *   epistemic_status_distribution, scope_distribution, lane_classification,
 *   sample_records }, notes.
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

interface EpistemicRecordRow {
  record_id: number;
  project_id: string;
  scope: string;
  statement: string;
  epistemic_status: string;
  verification_level: string;
  source_quality: string;
  confidence: number;
  valid_from: string;
  valid_until: string | null;
  superseded_by_record_id: number | null;
}

interface LaneDistribution {
  governing: number;
  contextual: number;
  excluded_working: number;
  excluded_ephemeral: number;
  excluded_category: number;
  excluded_other: number;
}

interface EpistemicLaneDistribution {
  governing_lane_eligible: number;
  contextual_lane: number;
  terminal_state: number;
  scope_violation: number;
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

function loadActiveEpistemicRecords(db: Database.Database, project: string, limit: number): EpistemicRecordRow[] {
  return db.prepare(`
    SELECT record_id, project_id, scope, statement, epistemic_status, verification_level,
           source_quality, confidence, valid_from, valid_until, superseded_by_record_id
    FROM epistemic_records
    WHERE project_id = ?
      AND superseded_by_record_id IS NULL
    ORDER BY valid_from DESC
    LIMIT ?
  `).all(project, limit) as EpistemicRecordRow[];
}

function classifyMemory(row: MemoryRow): { lane: 'governing' | 'contextual'; exclusions: string[] } {
  const exclusions: string[] = [];
  if (row.layer === 'working') exclusions.push('working_layer');
  if (row.lifecycle === 'ephemeral') exclusions.push('ephemeral_lifecycle');
  const GOVERNING_CATEGORIES = new Set(['decision', 'policy', 'process', 'preference', 'commitment', 'handoff']);
  if (row.category && !GOVERNING_CATEGORIES.has(row.category)) {
    exclusions.push('category_not_governing');
  }
  if (exclusions.length === 0) return { lane: 'governing', exclusions: [] };
  return { lane: 'contextual', exclusions };
}

/**
 * Classify an epistemic_record into one of three lane buckets based on its
 * epistemic_status. The mapping mirrors the v0.4 semantic:
 *   - governing: verified OR corroborated (operator-ratified or operator-validated)
 *   - contextual: inferred OR reported OR assumed (admissible but not ratified)
 *   - terminal: stale OR retracted OR contested (do not surface under default lane)
 *
 * A record whose scope is NOT exact-project is a scope_violation (per
 * Locked Invariant #9: cross-scope relations fail closed). Even when the
 * record is otherwise governing, a scope mismatch is recorded.
 */
function classifyEpistemicRecord(row: EpistemicRecordRow): {
  lane: 'governing' | 'contextual' | 'terminal';
  scope_violation: boolean;
} {
  const STATUS_LANE: Record<string, 'governing' | 'contextual' | 'terminal'> = {
    verified: 'governing',
    corroborated: 'governing',
    inferred: 'contextual',
    reported: 'contextual',
    assumed: 'contextual',
    stale: 'terminal',
    retracted: 'terminal',
    contested: 'terminal',
  };
  const lane = STATUS_LANE[row.epistemic_status] ?? 'contextual';
  const scope_violation = row.scope !== 'exact-project' && row.scope !== '_global';
  return { lane, scope_violation };
}

function auditMemories(rows: MemoryRow[]) {
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
    const { lane, exclusions } = classifyMemory(row);
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
  return {
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
    category_distribution: {
      decision: rows.filter(r => r.category === 'decision').length,
      policy: rows.filter(r => r.category === 'policy').length,
      process: rows.filter(r => r.category === 'process').length,
      preference: rows.filter(r => r.category === 'preference').length,
      commitment: rows.filter(r => r.category === 'commitment').length,
      handoff: rows.filter(r => r.category === 'handoff').length,
      finding: rows.filter(r => r.category === 'finding').length,
      reference: rows.filter(r => r.category === 'reference').length,
      note: rows.filter(r => r.category === 'note').length,
    },
    lane_distribution: distribution,
    sample_exclusions: sampleExclusions,
  };
}

function auditEpistemicRecords(rows: EpistemicRecordRow[]) {
  const distribution: EpistemicLaneDistribution = {
    governing_lane_eligible: 0,
    contextual_lane: 0,
    terminal_state: 0,
    scope_violation: 0,
  };
  const statusCounts: Record<string, number> = {};
  const scopeCounts: Record<string, number> = {};
  const sampleRecords: Array<{
    record_id: number;
    epistemic_status: string;
    scope: string;
    lane: string;
    confidence: number;
    statement_excerpt: string;
  }> = [];
  for (const row of rows) {
    const { lane, scope_violation } = classifyEpistemicRecord(row);
    if (lane === 'governing') distribution.governing_lane_eligible += 1;
    else if (lane === 'contextual') distribution.contextual_lane += 1;
    else distribution.terminal_state += 1;
    if (scope_violation) distribution.scope_violation += 1;
    statusCounts[row.epistemic_status] = (statusCounts[row.epistemic_status] ?? 0) + 1;
    scopeCounts[row.scope] = (scopeCounts[row.scope] ?? 0) + 1;
    if (sampleRecords.length < 10) {
      sampleRecords.push({
        record_id: row.record_id,
        epistemic_status: row.epistemic_status,
        scope: row.scope,
        lane,
        confidence: row.confidence,
        statement_excerpt: row.statement.slice(0, 100) + (row.statement.length > 100 ? '...' : ''),
      });
    }
  }
  return {
    total_scanned: rows.length,
    epistemic_status_distribution: statusCounts,
    scope_distribution: scopeCounts,
    lane_distribution: distribution,
    sample_records: sampleRecords,
  };
}

function audit(db: Database.Database, project: string, limit: number) {
  const memories = loadActiveMemories(db, project, limit);
  const epistemicRecords = loadActiveEpistemicRecords(db, project, limit);
  const memoriesSection = auditMemories(memories);
  const epistemicRecordsSection = auditEpistemicRecords(epistemicRecords);
  const memoriesGoverningRatio = memories.length === 0 ? 0 : memoriesSection.lane_distribution.governing / memories.length;
  const epistemicGoverningRatio = epistemicRecords.length === 0 ? 0 : epistemicRecordsSection.lane_distribution.governing_lane_eligible / epistemicRecords.length;
  return {
    project_id: project,
    memories_section: {
      ...memoriesSection,
      governing_ratio: Number(memoriesGoverningRatio.toFixed(3)),
    },
    epistemic_records_section: {
      ...epistemicRecordsSection,
      governing_ratio: Number(epistemicGoverningRatio.toFixed(3)),
    },
    notes: [
      'memories_section: governing_ratio is informational; pass judgment based on the project',
      'memories_section: working_layer and ephemeral_lifecycle exclusions are hard — never governing',
      'memories_section: category_not_governing is the softest exclusion — could be promoted by recategorization',
      'epistemic_records_section: governing_lane_eligible maps verified/corroborated to governing',
      'epistemic_records_section: contextual_lane maps inferred/reported/assumed',
      'epistemic_records_section: terminal_state maps stale/retracted/contested (do not surface under default lane)',
      'epistemic_records_section: scope_violation flags records whose scope is neither exact-project nor _global',
      'this audit does NOT call any memory_to_mark, epistemic_admit, or memory_update; observe-only',
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