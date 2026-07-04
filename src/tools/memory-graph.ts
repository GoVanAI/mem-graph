import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDatabase } from '../db.js';
import { textResult, errorResult, rowsResult } from '../util.js';
import { runActivate } from '../activate.js';
import { runDecayCycle, getSpreadStats, getStaleMemories } from '../decay.js';

export function registerMemoryGraphTools(server: McpServer): void {
  server.tool(
    'memory_synapse_create',
    'Create a synapse (graph edge) between two memory entries. Three connection types: wikilink (operator-curated, weight 1.0), bm25_auto (auto on insert, weight 0.2-1.5), parent_child (reserved). Enforces 50/50 cap on per-memory synapses; oldest lowest-weight bm25_auto are pruned if exceeded.',
    {
      source_id: z.number().int().positive().describe('Source memory id.'),
      target_id: z.number().int().positive().describe('Target memory id.'),
      connection_type: z.enum(['wikilink', 'bm25_auto', 'parent_child']).describe('Edge type. wikilink for operator-curated; bm25_auto for text-overlap; parent_child reserved.'),
      weight: z.number().min(0).max(5).optional().default(1.0).describe('Edge weight 0.0-5.0. Default 1.0.'),
    },
    async ({ source_id, target_id, connection_type, weight }) => {
      if (source_id === target_id) {
        return errorResult('A memory cannot link to itself.');
      }
      const db = getDatabase('memory');
      try {
        const fromRow = db.prepare('SELECT id FROM memories WHERE id = ?').get(source_id);
        const toRow = db.prepare('SELECT id FROM memories WHERE id = ?').get(target_id);
        if (!fromRow) return errorResult(`No memory found with source_id ${source_id}.`);
        if (!toRow) return errorResult(`No memory found with target_id ${target_id}.`);

        db.prepare(
          `INSERT INTO synapses (source_id, target_id, connection_type, weight)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_id, target_id, connection_type) DO UPDATE SET
               weight = MIN(5.0, weight + ?),
               updated_at = CURRENT_TIMESTAMP`,
        ).run(source_id, target_id, connection_type, weight, weight);

        return textResult(
          JSON.stringify(
            { source_id, target_id, connection_type, weight, created: true },
            null,
            2,
          ),
        );
      } catch (e) {
        return errorResult(`Synapse create error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_synapse_traverse',
    'List the synapses connected to a memory entry, with the connected memories\' summary. Direction: outgoing (this -> others), incoming (others -> this), or both. Optional connection_type filter.',
    {
      id: z.number().int().positive().describe('Memory entry id.'),
      direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('both').describe('Link direction filter. Default both.'),
      connection_type: z.enum(['wikilink', 'bm25_auto', 'parent_child']).optional().describe('Optional connection type filter.'),
      min_weight: z.number().min(0).max(5).optional().default(0.0).describe('Minimum synapse weight to include. Default 0.'),
      limit: z.number().int().positive().max(200).optional().default(50).describe('Max results. Default 50.'),
    },
    async ({ id, direction, connection_type, min_weight, limit }) => {
      const db = getDatabase('memory');
      try {
        const exists = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
        if (!exists) {
          return errorResult(`No memory found with id ${id}.`);
        }

        const conditions: string[] = ['s.weight >= ?'];
        const params: (string | number)[] = [min_weight];
        const joins: string[] = [];

        if (connection_type) {
          conditions.push('s.connection_type = ?');
          params.push(connection_type);
        }

        if (direction === 'outgoing' || direction === 'both') {
          joins.push(`(s.source_id = ? AND s.target_id = m.id)`);
          params.push(id);
        }
        if (direction === 'incoming' || direction === 'both') {
          joins.push(`(s.target_id = ? AND s.source_id = m.id)`);
          params.push(id);
        }

        params.push(limit);
        const where = joins.length > 1 ? `(${joins.join(' OR ')})` : joins[0];

        const stmt = db.prepare(`
          SELECT s.source_id, s.target_id, s.connection_type, s.weight, s.access_count,
                 s.created_at, s.updated_at,
                 m.id AS other_id, m.layer AS other_layer, m.title AS other_title,
                 m.summary AS other_summary, m.status AS other_status, m.project_id AS other_project_id
          FROM synapses s
          JOIN memories m ON ${where}
          WHERE ${conditions.join(' AND ')}
          ORDER BY s.weight DESC, s.updated_at DESC
          LIMIT ?
        `);
        const rows = stmt.all(...params);
        return rowsResult(rows);
      } catch (e) {
        return errorResult(`Synapse traverse error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_activate',
    'The headline v2 retrieval: spreading activation over the graph. Text-match (FTS5 BM25) on the query → 1-hop neighbors → 2-hop neighbors, with weight attenuation per step. Three independent bounds prevent hairballs: max_hop_depth (default 2), min_synapse_weight (default 0.3), limit_cap (default 20). Pass-through layers (default: semantic) are traversed but not gated by land_on_layers. importance_score multiplies effective_weight per step.',
    {
      query: z.string().describe('Search query. FTS5 syntax: words, AND/OR/NOT, "phrases", prefix*.'),
      max_hop_depth: z.number().int().min(1).max(5).optional().default(2).describe('Max traversal depth. Default 2.'),
      min_synapse_weight: z.number().min(0).max(5).optional().default(0.3).describe('Minimum synapse weight to traverse. Default 0.3.'),
      limit_cap: z.number().int().positive().max(100).optional().default(20).describe('Max results returned. Default 20, max 100.'),
      land_on_layers: z
        .array(z.enum(['working', 'episodic', 'procedural', 'semantic', 'partner']))
        .optional()
        .default(['procedural', 'episodic', 'semantic', 'partner'])
        .describe('Layers to surface in results. Default: all except working.'),
      pass_through_layers: z
        .array(z.enum(['working', 'episodic', 'procedural', 'semantic', 'partner']))
        .optional()
        .default(['semantic'])
        .describe('Layers allowed as hops but not gated by land_on_layers. Default: semantic.'),
      project_id: z.string().optional().describe('Optional project_id scope. If omitted, all projects are searched.'),
    },
    async (params) => {
      try {
        const results = runActivate(getDatabase('memory'), params);
        // Enrich with title and summary
        if (results.length > 0) {
          const db = getDatabase('memory');
          const ids = results.map((r) => r.id);
          const placeholders = ids.map(() => '?').join(',');
          const meta = db
            .prepare(
              `SELECT id, layer, project_id, title, summary, lifecycle, category
               FROM memories WHERE id IN (${placeholders})`,
            )
            .all(...ids) as Array<{
            id: number;
            layer: string;
            project_id: string;
            title: string;
            summary: string | null;
            lifecycle: string;
            category: string | null;
          }>;
          const metaById = new Map(meta.map((m) => [m.id, m]));
          return rowsResult(
            results.map((r) => ({
              ...r,
              title: metaById.get(r.id)?.title ?? null,
              summary: metaById.get(r.id)?.summary ?? null,
              lifecycle: metaById.get(r.id)?.lifecycle ?? null,
              category: metaById.get(r.id)?.category ?? null,
            })),
          );
        }
        return rowsResult(results);
      } catch (e) {
        return errorResult(`Activate error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_decay',
    'Run a decay cycle: matrix-based decay for synapses older than the threshold, access-based exemption for hot synapses, prune fully decayed edges. Returns counts. Production runs via OS cron / scheduled task; this tool is for manual invocation and testing.',
    {
      decay_days: z.number().int().positive().optional().default(7).describe('Only decay synapses older than this many days. Default 7.'),
      prune_floor: z.number().min(0).max(1).optional().default(0.1).describe('Prune synapses below this weight. Default 0.1.'),
    },
    async ({ decay_days, prune_floor }) => {
      try {
        const result = runDecayCycle(getDatabase('memory'), {
          decayDays: decay_days,
          pruneFloor: prune_floor,
        });
        return textResult(
          JSON.stringify(
            { ...result, decay_days, prune_floor, ran_at: new Date().toISOString() },
            null,
            2,
          ),
        );
      } catch (e) {
        return errorResult(`Decay error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_spread_stats',
    'Diagnostic: total counts, link density per memory, synapse distribution by type and layer, orphan count. Useful for understanding graph shape.',
    {},
    async () => {
      try {
        return rowsResult([getSpreadStats(getDatabase('memory'))]);
      } catch (e) {
        return errorResult(`Spread stats error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_stale',
    'Find entries not accessed in N days. Operational hygiene: which memories are getting cold? ' +
      'Each result includes a `never_accessed` boolean (true when accessed_at is NULL) so the headline ' +
      'cold-set signal is grep-able in JSON form.',
    {
      days: z.number().int().positive().optional().default(30).describe('Threshold in days. Default 30.'),
      project_id: z.string().optional().describe('Optional project_id filter. _global entries are always included.'),
      lifecycle: z
        .array(z.enum(['permanent', 'milestone', 'ephemeral']))
        .optional()
        .describe('Optional lifecycle allow-list (e.g., ["permanent", "milestone"] to exclude ephemerals).'),
      layer: z
        .array(z.enum(['working', 'episodic', 'procedural', 'semantic', 'partner']))
        .optional()
        .describe('Optional layer allow-list (e.g., ["episodic", "semantic"] to exclude procedural).'),
      limit: z.number().int().positive().max(500).optional().default(50).describe('Max results. Default 50, max 500.'),
    },
    async ({ days, project_id, lifecycle, layer, limit }) => {
      try {
        const rows = getStaleMemories(getDatabase('memory'), {
          days,
          project_id,
          lifecycle,
          layer,
          limit,
        });
        return rowsResult(rows);
      } catch (e) {
        return errorResult(`Stale error: ${(e as Error).message}`);
      }
    },
  );
}
