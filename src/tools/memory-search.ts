import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDatabase } from '../db.js';
import { textResult, errorResult, rowsResult } from '../util.js';
import { readMemoryEntry } from '../memory-read.js';

/** Shared FTS normalization used by legacy search and scoped agent search. */
export function sanitizeFtsQuery(q: string): string {
  const trimmed = q.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
  if (/[":()]/.test(trimmed)) return trimmed;
  if (/\b(AND|OR|NOT|NEAR)\b/i.test(trimmed)) return trimmed;
  if (!trimmed.includes('-')) return trimmed;
  return trimmed
    .split(/\s+/)
    .map((tok) => (tok.includes('-') ? `"${tok.replace(/"/g, '""')}"` : tok))
    .join(' ');
}

export interface ScopedQueryOptions { project_id?: string; include_global?: boolean; category?: string; layer?: string; lifecycle?: string; status?: string; limit?: number; }
function scopeCondition(alias: string, projectId: string | undefined, includeGlobal = true): { sql: string; params: string[] } {
  if (!projectId) return { sql: '', params: [] };
  return { sql: ` AND ${includeGlobal ? `(${alias}project_id = ? OR ${alias}project_id = '_global')` : `${alias}project_id = ?`}`, params: [projectId] };
}
/** Shared query services used by legacy adapters and scoped family adapters. */
export function runMemorySearch(db: ReturnType<typeof getDatabase>, input: ScopedQueryOptions & { query: string }): unknown[] {
  const scope = scopeCondition('m.', input.project_id, input.include_global ?? true); const conditions = ['memories_fts MATCH ?', 'm.status = ?']; const params: Array<string | number> = [sanitizeFtsQuery(input.query), input.status ?? 'active'];
  if (scope.sql) { conditions.push(scope.sql.slice(5)); params.push(...scope.params); }
  if (input.category) { conditions.push('m.category=?'); params.push(input.category); } if (input.layer) { conditions.push('m.layer=?'); params.push(input.layer); }
  params.push(input.limit ?? 20);
  return db.prepare(`SELECT m.id,m.layer,m.project_id,m.title,m.summary,m.status,m.lifecycle,m.confidence,m.boost,m.importance_score,m.created_at,m.updated_at,bm25(memories_fts)-(m.boost*.5) AS adjusted_rank,snippet(memories_fts,1,'[',']','...',12) AS snippet FROM memories_fts JOIN memories m ON m.id=memories_fts.rowid WHERE ${conditions.join(' AND ')} ORDER BY adjusted_rank LIMIT ?`).all(...params);
}
export function runMemoryRecent(db: ReturnType<typeof getDatabase>, input: ScopedQueryOptions): unknown[] {
  const scope = scopeCondition('', input.project_id, input.include_global ?? true); const conditions = ["status='active'"]; const params: Array<string | number> = [];
  if (scope.sql) { conditions.push(scope.sql.slice(5)); params.push(...scope.params); } if (input.category) { conditions.push('category=?'); params.push(input.category); } if (input.layer) { conditions.push('layer=?'); params.push(input.layer); } if (input.lifecycle) { conditions.push('lifecycle=?'); params.push(input.lifecycle); } params.push(input.limit ?? 20);
  return db.prepare(`SELECT id,layer,project_id,title,summary,lifecycle,confidence,boost,importance_score,created_at FROM memories WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params);
}
export function runMemoryChanges(db: ReturnType<typeof getDatabase>, input: ScopedQueryOptions & { since: string }): unknown[] {
  const scope = scopeCondition('', input.project_id, input.include_global ?? true); const conditions = ['(created_at > ? OR updated_at > ?)', "status != 'invalid'"]; const params: Array<string | number> = [input.since, input.since]; if (scope.sql) { conditions.push(scope.sql.slice(5)); params.push(...scope.params); } params.push(input.limit ?? 50);
  return db.prepare(`SELECT id,layer,project_id,title,status,lifecycle,created_at,updated_at FROM memories WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...params);
}

export function registerMemorySearchTools(server: McpServer): void {
  server.tool(
    'memory_search',
    'Full-text search across memory entries. Uses FTS5 with porter stemmer and BM25 ranking. Returns matching entries with a content snippet. Boost values from the boost field bias the ranking; importance_score multiplies the base relevance.',
    {
      query: z.string().describe('Search query. FTS5 syntax: words, AND/OR/NOT, "phrases", prefix*.'),
      project_id: z.string().optional().describe('Optional project_id filter. _global entries are always included.'),
      category: z.string().optional().describe('Optional category filter.'),
      layer: z
        .enum(['working', 'episodic', 'procedural', 'semantic', 'partner'])
        .optional()
        .describe('Optional layer filter.'),
      status: z
        .enum(['active', 'superseded', 'archived', 'invalid'])
        .optional()
        .default('active')
        .describe('Status filter. Default: active only.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .default(20)
        .describe('Max results. Default 20, max 100.'),
    },
    async ({ query, project_id, category, layer, status, limit }) => {
      const db = getDatabase('memory');
      try {
        return rowsResult(runMemorySearch(db, { query, project_id, category, layer, status, limit }));
      } catch (e) {
        return errorResult(`Search error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_recent',
    'Return the most recent memory entries, optionally filtered by project_id, category, or layer.',
    {
      project_id: z.string().optional().describe('Optional project_id filter.'),
      category: z.string().optional().describe('Optional category filter.'),
      layer: z
        .enum(['working', 'episodic', 'procedural', 'semantic', 'partner'])
        .optional()
        .describe('Optional layer filter.'),
      lifecycle: z
        .enum(['permanent', 'milestone', 'ephemeral'])
        .optional()
        .describe('Optional lifecycle filter.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .default(20)
        .describe('Max results. Default 20, max 100.'),
    },
    async ({ project_id, category, layer, lifecycle, limit }) => {
      const db = getDatabase('memory');
      return rowsResult(runMemoryRecent(db, { project_id, category, layer, lifecycle, limit }));
    },
  );

  server.tool(
    'memory_get',
    'Fetch a single memory entry by id, with its content. Optionally includes 1-hop synapse neighbors. Touches access_count on both the memory and the connected synapses (D7).',
    {
      id: z.number().int().positive().describe('Memory entry id.'),
      include_synapses: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, also returns the synapse neighbors (1-hop graph traversal).'),
    },
    async ({ id, include_synapses }) => {
      const db = getDatabase('memory');
      try {
        const result = readMemoryEntry(db, id, { include_synapses });
        if (!include_synapses) return textResult(JSON.stringify(result.memory, null, 2));
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResult(`No memory found with id ${id}.`);
      }
    },
  );

  server.tool(
    'memory_changes',
    'Return entries created or updated since a given timestamp. Useful for incremental session updates ("what\'s new since I last looked").',
    {
      since: z
        .string()
        .describe('ISO-8601 timestamp. Entries with created_at or updated_at > this are returned.'),
      project_id: z.string().optional().describe('Optional project_id filter.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .default(50)
        .describe('Max results. Default 50, max 200.'),
    },
    async ({ since, project_id, limit }) => {
      const db = getDatabase('memory');
      return rowsResult(runMemoryChanges(db, { since, project_id, limit }));
    },
  );

  server.tool(
    'memory_stats',
    'Return a health check of the memory database: counts, layer/status/lifecycle distribution, boost distribution, access statistics, synapse counts, decay matrix coverage.',
    {},
    async () => {
      const db = getDatabase('memory');
      const total = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
      const byStatus = db
        .prepare('SELECT status, COUNT(*) AS c FROM memories GROUP BY status')
        .all();
      const byLayer = db
        .prepare('SELECT layer, COUNT(*) AS c FROM memories GROUP BY layer')
        .all();
      const byLifecycle = db
        .prepare('SELECT lifecycle, COUNT(*) AS c FROM memories GROUP BY lifecycle')
        .all();
      const byCategory = db
        .prepare('SELECT category, COUNT(*) AS c FROM memories GROUP BY category ORDER BY c DESC')
        .all();
      const boosted = (db
        .prepare('SELECT COUNT(*) AS c FROM memories WHERE boost > 0')
        .get() as { c: number }).c;
      const avgConfidence = (db
        .prepare('SELECT AVG(confidence) AS a FROM memories')
        .get() as { a: number | null }).a;
      const stale = (db
        .prepare(
          "SELECT COUNT(*) AS c FROM memories WHERE status = 'active' AND accessed_at IS NULL",
        )
        .get() as { c: number }).c;
      const synapseCount = (db.prepare('SELECT COUNT(*) AS c FROM synapses').get() as { c: number })
        .c;
      const synapseByType = db
        .prepare('SELECT connection_type, COUNT(*) AS c FROM synapses GROUP BY connection_type')
        .all();
      const decayMatrixRows = (db.prepare('SELECT COUNT(*) AS c FROM decay_matrix').get() as {
        c: number;
      }).c;
      const tagCount = (db.prepare('SELECT COUNT(*) AS c FROM memory_tag').get() as { c: number })
        .c;
      return rowsResult([
        {
          total,
          by_status: byStatus,
          by_layer: byLayer,
          by_lifecycle: byLifecycle,
          by_category: byCategory,
          boosted_entries: boosted,
          average_confidence: avgConfidence,
          never_accessed: stale,
          synapse_count: synapseCount,
          synapse_by_type: synapseByType,
          tag_assignments: tagCount,
          decay_matrix_rows: decayMatrixRows,
        },
      ]);
    },
  );
}
