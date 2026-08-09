import type Database from 'better-sqlite3';
import { bumpMemoryAccess } from '../access.js';
import type {
  ContextualGuidanceResult,
  CurrentGuidanceDiagnostic,
  GuidanceExclusionReason,
  GoverningGuidanceResult,
  GoverningGuidanceSearchInput,
  StrictGuidanceResult,
  StrictGuidanceSearchInput,
} from './types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const GOVERNING_GUIDANCE_CATEGORIES = [
  'decision',
  'policy',
  'process',
  'preference',
  'commitment',
  'handoff',
] as const;

/**
 * Retrieve active lexical references without graph expansion or cross-project
 * fallback. This compatibility path is retained for frozen MVP-001 fixture
 * replay; it does not apply governing eligibility and must not drive guidance.
 *
 * The search deliberately accepts plain text only. Converting it to quoted
 * tokens keeps FTS5 operators and punctuation from altering the query's
 * meaning or producing a MATCH syntax error.
 */
export function searchCurrentGuidance(
  db: Database.Database,
  input: StrictGuidanceSearchInput,
): StrictGuidanceResult[] {
  return searchGuidance(db, input, { governingOnly: false, trackAccess: true }).map(
    ({ category: _category, ...row }) => row,
  );
}

/**
 * Retrieve the narrow subset of current memories that may drive a guidance
 * decision. This mechanically excludes in-flight and ephemeral material plus
 * categories that are contextual, evidentiary, audit, or otherwise
 * non-governing. Eligibility is not a claim that a memory is authoritative:
 * user and system instructions remain higher priority.
 */
export function searchGoverningGuidance(
  db: Database.Database,
  input: GoverningGuidanceSearchInput,
): GoverningGuidanceResult[] {
  return searchGuidance(db, input, { governingOnly: true, trackAccess: true }).map((row) => ({
    ...row,
    eligibility: 'governing_eligible',
  }));
}

/**
 * Inspect the bounded, active lexical candidate set without changing access
 * tracking. Candidates are split after lexical ranking and limiting, so an
 * excluded row still explains why an otherwise relevant result cannot drive
 * current guidance.
 */
export function diagnoseCurrentGuidance(
  db: Database.Database,
  input: GoverningGuidanceSearchInput,
): CurrentGuidanceDiagnostic {
  const rows = searchGuidance(db, input, { governingOnly: false, trackAccess: false });
  const governing: GoverningGuidanceResult[] = [];
  const excluded: ContextualGuidanceResult[] = [];

  for (const row of rows) {
    const exclusionReasons = guidanceExclusionReasons(row);
    if (exclusionReasons.length === 0) {
      governing.push({ ...row, eligibility: 'governing_eligible' });
    } else {
      excluded.push({
        ...row,
        eligibility: 'contextual_ineligible',
        exclusion_reasons: exclusionReasons,
      });
    }
  }

  return {
    scope: {
      project_id: input.project_id,
      include_global: input.include_global === true,
      active_only: true,
      graph_expansion: false,
      candidate_limit: normalizeLimit(input.limit),
    },
    access_tracking: 'not_touched',
    governing,
    excluded,
  };
}

interface GuidanceSearchRow extends StrictGuidanceResult {
  category: string | null;
}

interface GuidanceSearchOptions {
  governingOnly: boolean;
  trackAccess: boolean;
}

function searchGuidance(
  db: Database.Database,
  input: StrictGuidanceSearchInput,
  options: GuidanceSearchOptions,
): GuidanceSearchRow[] {
  const ftsQuery = toSafeFtsQuery(input.query);
  if (!ftsQuery) return [];

  const conditions = ['memories_fts MATCH ?', "m.status = 'active'"];
  const params: Array<string | number> = [ftsQuery];

  if (input.include_global) {
    conditions.push("(m.project_id = ? OR m.project_id = '_global')");
  } else {
    conditions.push('m.project_id = ?');
  }
  params.push(input.project_id);

  if (options.governingOnly) {
    const categoryPlaceholders = GOVERNING_GUIDANCE_CATEGORIES.map(() => '?').join(', ');
    conditions.push("m.layer != 'working'", "m.lifecycle != 'ephemeral'");
    conditions.push(`lower(trim(COALESCE(m.category, ''))) IN (${categoryPlaceholders})`);
    params.push(...GOVERNING_GUIDANCE_CATEGORIES);
  }

  if (input.category) {
    conditions.push('m.category = ?');
    params.push(input.category);
  }
  if (input.layer) {
    conditions.push('m.layer = ?');
    params.push(input.layer);
  }

  const limit = normalizeLimit(input.limit);
  const rows = db
    .prepare(
      `SELECT m.id, m.layer, m.project_id, m.category, m.title, m.summary, m.status,
              m.lifecycle, m.confidence, m.importance_score,
              bm25(memories_fts) - (m.boost * 0.5) AS adjusted_rank,
              snippet(memories_fts, 1, '[', ']', '...', 12) AS snippet
       FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       WHERE ${conditions.join(' AND ')}
       ORDER BY
         CASE WHEN m.project_id = ? THEN 0 ELSE 1 END,
         adjusted_rank ASC,
         m.id ASC
       LIMIT ?`,
    )
    .all(...params, input.project_id, limit) as GuidanceSearchRow[];

  if (options.trackAccess) {
    for (const row of rows) {
      bumpMemoryAccess(db, row.id);
    }
  }
  return rows;
}

function guidanceExclusionReasons(row: GuidanceSearchRow): GuidanceExclusionReason[] {
  const reasons: GuidanceExclusionReason[] = [];
  if (row.layer === 'working') reasons.push('working_layer');
  if (row.lifecycle === 'ephemeral') reasons.push('ephemeral_lifecycle');
  if (!GOVERNING_GUIDANCE_CATEGORIES.some((category) => category === normalizeCategory(row.category))) {
    reasons.push('category_not_governing');
  }
  return reasons;
}

function normalizeCategory(category: string | null): string {
  return category?.trim().toLowerCase() ?? '';
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function toSafeFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
  return tokens.map((token) => `"${token}"`).join(' AND ');
}
