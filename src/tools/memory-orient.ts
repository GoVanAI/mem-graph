import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDatabase } from '../db.js';
import { textResult, errorResult, rowsResult } from '../util.js';
import { runMemoryPrime } from '../memory-prime.js';

const DEFAULT_PRIME_TOKENS = 4096;

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
    'Session-start primer. Returns a curated, budgeted subset of memories relevant to the current session. The headline tool for cold-start cost reduction. Budget is in tokens; default 4K, hard cap 16K. Recently created or updated high-importance active records receive a bounded freshness lane before ordinary ordering: importance_score * (1 + boost) DESC, then lifecycle tier, then recency.',
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
      return textResult(JSON.stringify(runMemoryPrime(getDatabase('memory'), {
        project_id: project,
        include_global: project !== undefined,
        max_tokens,
        include_archived,
      }), null, 2));
    },
  );
}
