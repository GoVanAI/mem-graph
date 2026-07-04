import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDatabase } from '../db.js';
import { textResult, errorResult, rowsResult } from '../util.js';

const DEFAULT_PRIME_TOKENS = 4096;
const HARD_MAX_TOKENS = 16384;
const CHARS_PER_TOKEN = 4;

interface MemoryRow {
  id: number;
  layer: string;
  title: string;
  content: string;
  summary: string | null;
  project_id: string;
  category: string | null;
  lifecycle: string;
  confidence: number;
  boost: number;
  importance_score: number;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
}

function charsForEntry(row: MemoryRow): number {
  let n = 0;
  n += (row.title ?? '').length;
  n += (row.summary ?? row.content ?? '').length;
  n += 200; // overhead
  return n;
}

function primeEntry(row: MemoryRow) {
  // Get tags for this entry
  const db = getDatabase('memory');
  const tags = db
    .prepare('SELECT tag FROM memory_tag WHERE memory_id = ? ORDER BY tag')
    .all(row.id) as { tag: string }[];
  return {
    id: row.id,
    layer: row.layer,
    project_id: row.project_id,
    title: row.title,
    summary: row.summary,
    tags: tags.map((t) => t.tag),
    category: row.category,
    lifecycle: row.lifecycle,
    confidence: row.confidence,
    boost: row.boost,
    importance_score: row.importance_score,
    created_at: row.created_at,
  };
}

export function registerMemoryOrientTools(server: McpServer): void {
  server.tool(
    'memory_overview',
    'Get a high-level overview of the memory database: total count, layer distribution, status distribution, distinct projects, distinct categories, and recent activity. Cheap to call; useful as a first step in any session.',
    {},
    async () => {
      const db = getDatabase('memory');
      const total = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
      const byStatus = db
        .prepare('SELECT status, COUNT(*) AS c FROM memories GROUP BY status ORDER BY c DESC')
        .all();
      const byLayer = db
        .prepare('SELECT layer, COUNT(*) AS c FROM memories GROUP BY layer ORDER BY c DESC')
        .all();
      const byCategory = db
        .prepare('SELECT category, COUNT(*) AS c FROM memories GROUP BY category ORDER BY c DESC')
        .all();
      const byProject = db
        .prepare(
          `SELECT project_id, COUNT(*) AS c FROM memories
           WHERE status = 'active' GROUP BY project_id ORDER BY c DESC`,
        )
        .all();
      const recent = db
        .prepare(
          `SELECT id, layer, title, lifecycle, created_at FROM memories
           WHERE status = 'active' ORDER BY created_at DESC LIMIT 5`,
        )
        .all();
      const synapseTotal = (db.prepare('SELECT COUNT(*) AS c FROM synapses').get() as { c: number })
        .c;
      return rowsResult([
        {
          total,
          by_status: byStatus,
          by_layer: byLayer,
          by_category: byCategory,
          by_project: byProject,
          recent,
          total_synapses: synapseTotal,
        },
      ]);
    },
  );

  server.tool(
    'memory_projects',
    'List the distinct projects in the memory database with their entry counts and last activity.',
    {},
    async () => {
      const db = getDatabase('memory');
      const rows = db
        .prepare(
          `SELECT project_id, COUNT(*) AS c, MAX(created_at) AS latest
           FROM memories
           WHERE status = 'active'
           GROUP BY project_id
           ORDER BY latest DESC`,
        )
        .all();
      return rowsResult(rows);
    },
  );

  server.tool(
    'memory_categories',
    'List the distinct categories in the memory database with their entry counts and last activity.',
    {},
    async () => {
      const db = getDatabase('memory');
      const rows = db
        .prepare(
          `SELECT category, COUNT(*) AS c, MAX(created_at) AS latest
           FROM memories
           WHERE status = 'active' AND category IS NOT NULL
           GROUP BY category
           ORDER BY latest DESC`,
        )
        .all();
      return rowsResult(rows);
    },
  );

  server.tool(
    'memory_prime',
    'Session-start primer. Returns a curated, budgeted subset of memories relevant to the current session. The headline tool for cold-start cost reduction. Budget is in tokens; default 4K, hard cap 16K. Ordering: importance_score * (1 + boost) DESC, then lifecycle tier, then recency.',
    {
      project: z
        .string()
        .optional()
        .describe('Optional project name to bias the prime. If omitted, returns mostly _global entries.'),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .default(DEFAULT_PRIME_TOKENS)
        .describe('Token budget for the prime. Default 4096. Hard-capped at 16384.'),
      include_archived: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, includes superseded/archived entries. Default false (active only).'),
    },
    async ({ project, max_tokens, include_archived }) => {
      const budget = Math.min(max_tokens, HARD_MAX_TOKENS);
      const charBudget = budget * CHARS_PER_TOKEN;
      const db = getDatabase('memory');

      const statusClause = include_archived ? '' : "AND m.status = 'active'";
      const projectClause = project
        ? "AND (m.project_id = ? OR m.project_id = '_global')"
        : "AND m.project_id = '_global'";

      const sql = `
        SELECT m.*
        FROM memories m
        WHERE 1=1 ${statusClause} ${projectClause}
        ORDER BY
          m.importance_score * (1.0 + m.boost) DESC,
          CASE m.lifecycle WHEN 'permanent' THEN 0 WHEN 'milestone' THEN 1 ELSE 2 END,
          m.created_at DESC
        LIMIT 50
      `;
      const candidates = (project
        ? db.prepare(sql).all(project)
        : db.prepare(sql).all()) as MemoryRow[];

      let used = 0;
      const picked: MemoryRow[] = [];
      const dropped: { id: number; title: string; reason: string }[] = [];
      for (const row of candidates) {
        const cost = charsForEntry(row);
        if (used + cost > charBudget && picked.length > 0) {
          dropped.push({ id: row.id, title: row.title, reason: 'budget_exceeded' });
          continue;
        }
        picked.push(row);
        used += cost;
      }

      return textResult(
        JSON.stringify(
          {
            prime: {
              max_tokens: budget,
              used_tokens_estimate: Math.ceil(used / CHARS_PER_TOKEN),
              entry_count: picked.length,
              dropped_count: dropped.length,
            },
            entries: picked.map(primeEntry),
            dropped,
          },
          null,
          2,
        ),
      );
    },
  );
}
