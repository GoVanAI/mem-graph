import type Database from 'better-sqlite3';

const HARD_MAX_TOKENS = 16384;
const CHARS_PER_TOKEN = 4;
const FRESH_WINDOW_DAYS = 7;
const FRESH_LANE_MAX_ENTRIES = 5;
const FRESH_LANE_BUDGET_FRACTION = 0.25;
const PRIME_CANDIDATE_POOL_LIMIT = 50;

type MemoryRow = { id: number; layer: string; title: string; content: string; summary: string | null; project_id: string; category: string | null; lifecycle: string; confidence: number; boost: number; importance_score: number; created_at: string; updated_at: string; };
type PrimeEntry = Omit<MemoryRow, 'content' | 'updated_at'> & { tags: string[] };
type Candidate = { row: MemoryRow; entry: PrimeEntry; cost: number };

function candidate(db: Database.Database, row: MemoryRow): Candidate {
  const tags = (db.prepare('SELECT tag FROM memory_tag WHERE memory_id=? ORDER BY tag').all(row.id) as Array<{ tag: string }>).map((tag) => tag.tag);
  const entry: PrimeEntry = { id: row.id, layer: row.layer, project_id: row.project_id, title: row.title, summary: row.summary, tags, category: row.category, lifecycle: row.lifecycle, confidence: row.confidence, boost: row.boost, importance_score: row.importance_score, created_at: row.created_at };
  return { row, entry, cost: JSON.stringify(entry).length + 200 };
}

/** Shared, zero-write selection algorithm for legacy and agent primers. */
export function runMemoryPrime(db: Database.Database, input: { project_id?: string; include_global?: boolean; max_tokens?: number; include_archived?: boolean }) {
  const budget = Math.min(input.max_tokens ?? 4096, HARD_MAX_TOKENS);
  const charBudget = budget * CHARS_PER_TOKEN;
  const includeGlobal = input.include_global ?? (input.project_id !== undefined);
  const statusClause = input.include_archived ? '' : "AND m.status = 'active'";
  const projectClause = input.project_id
    ? includeGlobal ? "AND (m.project_id = ? OR m.project_id = '_global')" : 'AND m.project_id = ?'
    : "AND m.project_id = '_global'";
  const effectiveTimestamp = "CASE WHEN datetime(m.updated_at) >= datetime(m.created_at) THEN datetime(m.updated_at) ELSE datetime(m.created_at) END";
  const normalSql = `SELECT m.* FROM memories m WHERE 1=1 ${statusClause} ${projectClause} ORDER BY m.importance_score*(1.0+m.boost) DESC,CASE m.lifecycle WHEN 'permanent' THEN 0 WHEN 'milestone' THEN 1 ELSE 2 END,m.created_at DESC LIMIT ${PRIME_CANDIDATE_POOL_LIMIT}`;
  const freshSql = `SELECT m.* FROM memories m WHERE m.status='active' ${projectClause} AND m.importance_score>=0.8 AND ${effectiveTimestamp}>=datetime('now','-${FRESH_WINDOW_DAYS} days') ORDER BY ${effectiveTimestamp} DESC,m.importance_score DESC,m.id ASC LIMIT ${PRIME_CANDIDATE_POOL_LIMIT}`;
  const normalRows = (input.project_id ? db.prepare(normalSql).all(input.project_id) : db.prepare(normalSql).all()) as MemoryRow[];
  const freshRows = (input.project_id ? db.prepare(freshSql).all(input.project_id) : db.prepare(freshSql).all()) as MemoryRow[];
  let used = 0; let freshUsed = 0; const freshPicked: Candidate[] = [];
  for (const row of freshRows) { if (freshPicked.length >= FRESH_LANE_MAX_ENTRIES) break; const item = candidate(db, row); if (freshUsed + item.cost > Math.floor(charBudget * FRESH_LANE_BUDGET_FRACTION)) continue; freshPicked.push(item); freshUsed += item.cost; used += item.cost; }
  const freshIds = new Set(freshPicked.map((item) => item.row.id)); const picked = [...freshPicked]; const dropped: Array<{ id: number; title: string; reason: string }> = [];
  for (const row of normalRows) { if (freshIds.has(row.id)) continue; const item = candidate(db, row); if (used + item.cost > charBudget && picked.length > 0) { dropped.push({ id: row.id, title: row.title, reason: 'budget_exceeded' }); continue; } picked.push(item); used += item.cost; }
  return { prime: { max_tokens: budget, used_tokens_estimate: Math.ceil(used / CHARS_PER_TOKEN), entry_count: picked.length, dropped_count: dropped.length, fresh_entry_count: freshPicked.length, fresh_ids: freshPicked.map((item) => item.row.id) }, entries: picked.map((item) => item.entry), dropped };
}
