import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { getDatabase } from '../db.js';
import { textResult, errorResult } from '../util.js';
import { runImportFromMemSol } from '../import-memsol.js';

export function registerMemoryImportTools(server: McpServer): void {
  server.tool(
    'memory_import_from_mem_sol',
    'One-shot migration from mem-sol v1 SQLite DB to mem-graph v2. ' +
      'Pipeline: insert memories (FTS5 triggers fire) → parse JSON tags into memory_tag junction ' +
      '→ two-pass wikilink extraction (handles forward references) → migrate v1 memory_links ' +
      'as wikilink synapses with the original v1 type preserved in `reason`. ' +
      'Idempotent: skips rows whose (project_id, title) already exists. ' +
      'Auto-link is deferred to next activation — batch insert avoids the ' +
      '"neighbor not yet imported" ordering hazard. ' +
      'Returns counts and a v1→v2 id map for verification.',
    {
      source_db_path: z
        .string()
        .describe(
          'Path to mem-sol v1 memory.db file (e.g., /path/to/mem-sol/memory.db).',
        ),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, scan source and report counts without writing to target. Default false.'),
      default_layer: z
        .enum(['working', 'episodic', 'procedural', 'semantic', 'partner'])
        .optional()
        .default('episodic')
        .describe('Layer assigned to imported entries (v1 had no layer concept). Default episodic.'),
      default_importance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(1.0)
        .describe('importance_score for v1 entries with NULL relevance_score. Default 1.0.'),
    },
    async ({ source_db_path, dry_run, default_layer, default_importance }) => {
      if (!existsSync(source_db_path)) {
        return errorResult(`Source DB not found: ${source_db_path}`);
      }

      let sourceDb: Database.Database;
      try {
        sourceDb = new Database(source_db_path, { readonly: true });
      } catch (e) {
        return errorResult(`Could not open source DB: ${(e as Error).message}`);
      }

      try {
        const result = runImportFromMemSol(sourceDb, getDatabase('memory'), {
          dry_run,
          default_layer,
          default_importance,
        });
        return textResult(
          JSON.stringify({ source_db_path, ...result }, null, 2),
        );
      } catch (e) {
        return errorResult(`Import error: ${(e as Error).message}`);
      } finally {
        sourceDb.close();
      }
    },
  );
}